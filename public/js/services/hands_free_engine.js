// HandsFreeEngine: строгая машина состояний (IDLE -> SPEAKING -> LISTENING -> EVALUATING -> FEEDBACK)
// с защитой от эха, обработкой no-speech на Android Chrome, командами и Screen Wake Lock.

import { audioPlayer as defaultAudioPlayer } from './audio_player.js';
import { soundFx as defaultSoundFx } from './sound_fx.js';
import { createWakeLock } from './wake_lock.js';
import { evaluateVoiceAnswer, expectedSpeechFor, promptForHandsFree } from './hands_free_matcher.js';

export const HF_STATES = Object.freeze({
  IDLE: 'IDLE',
  SPEAKING: 'SPEAKING',
  LISTENING: 'LISTENING',
  EVALUATING: 'EVALUATING',
  FEEDBACK: 'FEEDBACK',
  PAUSED: 'PAUSED',
});

const DEFAULT_POST_SPEAK_MS = 220;   // пауза после озвучки, чтобы эхо динамика не попало в микрофон
const DEFAULT_CORRECT_PAUSE_MS = 600;
const DEFAULT_WRONG_PAUSE_MS = 1500;
const DEFAULT_HARD_PAUSE_MS = 450;
const DEFAULT_LISTEN_TIMEOUT_MS = 9000;
const MAX_NO_SPEECH_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasVoiceForLang(synth, langPrefix) {
  if (!synth || typeof synth.getVoices !== 'function') return false;
  try {
    const re = new RegExp(`^${langPrefix}([-_]|$)`, 'i');
    return (synth.getVoices() || []).some((v) => re.test(v && v.lang ? v.lang : ''));
  } catch {
    return false;
  }
}

/**
 * Создаёт контроллер Hands-Free голосового режима.
 * Не пересекается с public/js/stt.js (использует собственный изолированный экземпляр SpeechRecognition).
 */
export function createHandsFreeEngine(callbacks = {}, deps = {}) {
  const audio = deps.audioPlayer ?? defaultAudioPlayer;
  const fx = deps.soundFx ?? defaultSoundFx;
  const wakeLock = deps.wakeLock ?? createWakeLock();
  const getSRCtor = deps.getSRCtor ?? (() => (
    typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition || null) : null
  ));
  const getSynth = deps.getSynth ?? (() => (
    typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
  ));

  const postSpeakMs = deps.postSpeakMs ?? DEFAULT_POST_SPEAK_MS;
  const correctPauseMs = deps.correctPauseMs ?? DEFAULT_CORRECT_PAUSE_MS;
  const wrongPauseMs = deps.wrongPauseMs ?? DEFAULT_WRONG_PAUSE_MS;
  const hardPauseMs = deps.hardPauseMs ?? DEFAULT_HARD_PAUSE_MS;
  const listenTimeoutMs = deps.listenTimeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS;
  const maxNoSpeechRetries = deps.maxNoSpeechRetries ?? MAX_NO_SPEECH_RETRIES;

  let state = HF_STATES.IDLE;
  let disposed = false;
  let activeRec = null;
  let recEndWaiter = null;
  let listenAbort = null;
  let pauseWaiter = null;
  let pendingControl = null; // 'skip' | 'repeat' | 'stop' | null
  let currentAbort = null;

  function emitState(next, detail = {}) {
    state = next;
    if (typeof callbacks.onStateChange === 'function') {
      try { callbacks.onStateChange(next, detail); } catch { /* ignore */ }
    }
  }
  function emitInterim(text) {
    if (typeof callbacks.onInterim === 'function') {
      try { callbacks.onInterim(text); } catch { /* ignore */ }
    }
  }
  function emitFeedback(info) {
    if (typeof callbacks.onFeedback === 'function') {
      try { callbacks.onFeedback(info); } catch { /* ignore */ }
    }
  }
  function emitError(msg) {
    if (typeof callbacks.onError === 'function') {
      try { callbacks.onError(msg); } catch { /* ignore */ }
    }
  }

  /**
   * Жёсткая защита от эха: гарантированно останавливает/прерывает SpeechRecognition
   * ДО любого вывода звука (озвучка или Web Audio beep).
   */
  async function stopRecognition() {
    if (listenAbort) {
      const fn = listenAbort;
      listenAbort = null;
      fn();
    }
    const rec = activeRec;
    if (!rec) return;
    activeRec = null;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        recEndWaiter = null;
        resolve();
      };
      recEndWaiter = finish;
      setTimeout(finish, 250);
      try { rec.onresult = null; rec.onerror = null; } catch { /* ignore */ }
      try {
        if (typeof rec.abort === 'function') rec.abort();
        else if (typeof rec.stop === 'function') rec.stop();
        else finish();
      } catch {
        finish();
      }
    });
  }

  function interruptSpeech() {
    if (currentAbort) {
      try { currentAbort.abort(); } catch { /* ignore */ }
      currentAbort = null;
    }
    try { audio.stop(); } catch { /* ignore */ }
  }

  /** Пауза с возможностью немедленного выхода по pause/skip/repeat/dispose */
  async function interruptibleSleep(ms) {
    if (ms <= 0 || disposed || pendingControl) return;
    await new Promise((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(); }, ms);
      const ctrl = new AbortController();
      const prev = currentAbort;
      currentAbort = ctrl;
      const cleanup = () => {
        clearTimeout(t);
        if (currentAbort === ctrl) currentAbort = prev;
      };
      ctrl.signal.addEventListener('abort', () => { cleanup(); resolve(); }, { once: true });
    });
  }

  /** Одно окно прослушивания микрофона (строго после завершения озвучки) */
  function listenOnce() {
    return new Promise((resolve) => {
      const SRCtor = getSRCtor();
      if (!SRCtor || disposed) {
        return resolve({ status: 'unsupported', transcripts: [] });
      }

      let settled = false;
      let latestInterim = '';
      let finalAlts = [];
      let timer = null;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (listenAbort === abortMe) listenAbort = null;
        const r = activeRec;
        if (r === rec) activeRec = null;
        try { r.onresult = null; r.onerror = null; r.onend = null; } catch { /* ignore */ }
        resolve(res);
      };

      const rec = new SRCtor();
      rec.lang = 'de-DE';
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      activeRec = rec;

      const abortMe = () => {
        try {
          if (typeof rec.abort === 'function') rec.abort();
          else if (typeof rec.stop === 'function') rec.stop();
        } catch { /* ignore */ }
        finish({ status: 'aborted', transcripts: [] });
      };
      listenAbort = abortMe;

      timer = setTimeout(() => {
        try {
          if (typeof rec.stop === 'function') rec.stop();
        } catch { /* ignore */ }
        // Если уже есть промежуточный текст — используем его, иначе считаем тишиной
        if (latestInterim) {
          finish({ status: 'ok', transcripts: [latestInterim] });
        } else {
          finish({ status: 'no-speech', transcripts: [] });
        }
      }, listenTimeoutMs);

      rec.onresult = (e) => {
        if (settled) return;
        const results = e && e.results ? e.results : [];
        let interimTxt = '';
        let hasFinal = false;
        const alts = [];

        for (let i = 0; i < results.length; i += 1) {
          const item = results[i];
          if (!item || !item[0]) continue;
          if (item.isFinal) {
            hasFinal = true;
            for (let j = 0; j < item.length; j += 1) {
              const t = String(item[j] && item[j].transcript ? item[j].transcript : '').trim();
              if (t && !alts.includes(t)) alts.push(t);
            }
          } else {
            interimTxt += ' ' + String(item[0].transcript || '');
          }
        }

        const live = (alts[0] || interimTxt).replace(/\s+/g, ' ').trim();
        if (live) {
          latestInterim = live;
          emitInterim(live);
        }
        if (hasFinal && alts.length) {
          finalAlts = alts;
          finish({ status: 'ok', transcripts: finalAlts });
        }
      };

      rec.onerror = (e) => {
        const code = e && e.error ? String(e.error) : 'unknown';
        if (code === 'no-speech') {
          finish({ status: 'no-speech', transcripts: [] });
        } else if (code === 'aborted') {
          finish({ status: 'aborted', transcripts: [] });
        } else if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          finish({ status: 'fatal', error: code, transcripts: [] });
        } else if (code === 'network') {
          finish({ status: 'network', error: code, transcripts: [] });
        } else {
          finish({ status: 'no-speech', transcripts: [] });
        }
      };

      rec.onend = () => {
        if (recEndWaiter) {
          const w = recEndWaiter;
          recEndWaiter = null;
          w();
        }
        if (settled) return;
        if (finalAlts.length) finish({ status: 'ok', transcripts: finalAlts });
        else if (latestInterim) finish({ status: 'ok', transcripts: [latestInterim] });
        else finish({ status: 'no-speech', transcripts: [] });
      };

      try {
        rec.start();
      } catch (err) {
        finish({ status: 'fatal', error: (err && err.name) || 'start_failed', transcripts: [] });
      }
    });
  }

  async function waitUntilResumed() {
    if (state !== HF_STATES.PAUSED || disposed) return;
    await new Promise((resolve) => {
      pauseWaiter = resolve;
    });
    pauseWaiter = null;
  }

  function wakeFromPause() {
    if (pauseWaiter) {
      const w = pauseWaiter;
      pauseWaiter = null;
      w();
    }
  }

  async function enterPaused(statusText = 'На паузе') {
    await stopRecognition();
    interruptSpeech();
    emitState(HF_STATES.PAUSED, { statusText });
  }

  /** Проиграть озвучку с гарантированной предварительной остановкой микрофона */
  async function safeSpeak(text, opts = {}) {
    await stopRecognition();
    if (disposed || pendingControl || state === HF_STATES.PAUSED) return { ok: false, interrupted: true };
    const ctrl = new AbortController();
    currentAbort = ctrl;
    try {
      return await audio.play(text, { ...opts, signal: ctrl.signal });
    } finally {
      if (currentAbort === ctrl) currentAbort = null;
    }
  }

  /** Проиграть тон с гарантированной остановкой микрофона */
  async function safeBeep(kind) {
    await stopRecognition();
    if (disposed) return;
    if (kind === 'success') await fx.beepSuccess();
    else if (kind === 'error') await fx.beepError();
    else await fx.beepTick();
  }

  /** Озвучить задание карточки (DE через AudioPlayerService, RU через ru-RU или мягкий сигнал) */
  async function speakCardPrompt(prompt) {
    emitState(HF_STATES.SPEAKING, { statusText: 'Озвучиваю задание…' });
    emitInterim('');
    if (!prompt.speakText) {
      await safeBeep('tick');
      return;
    }
    if (prompt.speakLang === 'ru-RU') {
      const synth = getSynth();
      if (hasVoiceForLang(synth, 'ru')) {
        const res = await safeSpeak(prompt.speakText, { lang: 'ru-RU', rate: 1.0 });
        if (!res.ok && !res.interrupted) await safeBeep('tick');
      } else {
        await safeBeep('tick');
      }
      return;
    }
    await safeSpeak(prompt.speakText, { lang: 'de-DE' });
  }

  async function start() {
    disposed = false;
    pendingControl = null;
    audio.unlock();
    fx.unlock();
    await wakeLock.acquire();
    emitState(HF_STATES.IDLE, { statusText: 'Готов к запуску' });
  }

  function pause() {
    if (disposed || state === HF_STATES.PAUSED) return;
    pendingControl = 'pause';
    stopRecognition().catch(() => {});
    interruptSpeech();
    emitState(HF_STATES.PAUSED, { statusText: 'Пауза — нажмите, чтобы продолжить' });
  }

  function resume() {
    if (disposed || state !== HF_STATES.PAUSED) return;
    pendingControl = null;
    audio.unlock();
    fx.unlock();
    wakeLock.acquire().catch(() => {});
    emitState(HF_STATES.IDLE, { statusText: 'Продолжаем…' });
    wakeFromPause();
  }

  function skipCurrent() {
    if (disposed) return;
    pendingControl = 'skip';
    stopRecognition().catch(() => {});
    interruptSpeech();
    wakeFromPause();
  }

  function repeatCurrent() {
    if (disposed) return;
    pendingControl = 'repeat';
    stopRecognition().catch(() => {});
    interruptSpeech();
    wakeFromPause();
  }

  function dispose() {
    disposed = true;
    pendingControl = 'stop';
    stopRecognition().catch(() => {});
    interruptSpeech();
    wakeLock.release().catch(() => {});
    emitState(HF_STATES.IDLE, { statusText: '' });
    wakeFromPause();
  }

  /** Озвучивание новой карточки (экран изучения) в Hands-Free */
  async function speakLearnCard(card) {
    if (disposed) return { stopped: true };
    pendingControl = null;
    const term = card && card.article ? `${card.article} ${card.term || ''}` : String((card && card.term) || '');
    for (;;) {
      if (disposed) return { stopped: true };
      if (state === HF_STATES.PAUSED) {
        await waitUntilResumed();
        if (disposed) return { stopped: true };
      }
      pendingControl = null;
      emitState(HF_STATES.SPEAKING, { statusText: 'Новое слово — слушаем…' });
      if (term) await safeSpeak(term, { lang: 'de-DE' });
      if (disposed) return { stopped: true };
      if (pendingControl === 'skip') { pendingControl = null; return { skipped: true }; }
      if (pendingControl === 'repeat') { pendingControl = null; continue; }
      if (pendingControl === 'pause' || state === HF_STATES.PAUSED) {
        pendingControl = null;
        await enterPaused('Пауза на новом слове');
        continue;
      }
      if (card && card.example) {
        await interruptibleSleep(350);
        if (!disposed && !pendingControl && state !== HF_STATES.PAUSED) {
          await safeSpeak(card.example, { lang: 'de-DE' });
        }
      }
      if (disposed) return { stopped: true };
      if (pendingControl === 'repeat') { pendingControl = null; continue; }
      if (pendingControl === 'pause' || state === HF_STATES.PAUSED) {
        pendingControl = null;
        await enterPaused('Пауза на новом слове');
        continue;
      }
      await interruptibleSleep(500);
      emitState(HF_STATES.IDLE);
      return { ok: true };
    }
  }

  /**
   * Прогон одной FSRS-карточки через строгий цикл:
   * IDLE -> SPEAKING -> LISTENING -> EVALUATING -> FEEDBACK
   */
  async function runCard({ item }) {
    if (disposed) return { action: 'stopped' };
    pendingControl = null;
    const prompt = promptForHandsFree(item);
    const expectedPhrase = expectedSpeechFor(item);
    const cardStart = Date.now();
    let noSpeechRetries = 0;

    for (;;) {
      if (disposed) return { action: 'stopped' };

      if (state === HF_STATES.PAUSED) {
        await waitUntilResumed();
        if (disposed) return { action: 'stopped' };
        if (pendingControl === 'skip') {
          pendingControl = null;
          emitState(HF_STATES.IDLE);
          return { action: 'skip' };
        }
        noSpeechRetries = 0;
      }

      // --- SPEAKING (микрофон гарантированно остановлен) ---
      pendingControl = null;
      await speakCardPrompt(prompt);
      if (disposed) return { action: 'stopped' };
      if (pendingControl === 'skip') {
        pendingControl = null;
        emitState(HF_STATES.IDLE);
        return { action: 'skip' };
      }
      if (pendingControl === 'repeat') {
        pendingControl = null;
        continue;
      }
      if (pendingControl === 'pause' || state === HF_STATES.PAUSED) {
        pendingControl = null;
        await enterPaused();
        continue;
      }

      // Акустическая пауза после ended, чтобы не поймать эхо собственного динамика
      if (postSpeakMs > 0) await interruptibleSleep(postSpeakMs);
      if (disposed) return { action: 'stopped' };
      if (pendingControl === 'skip') { pendingControl = null; emitState(HF_STATES.IDLE); return { action: 'skip' }; }
      if (pendingControl === 'repeat') { pendingControl = null; continue; }
      if (pendingControl === 'pause' || state === HF_STATES.PAUSED) { pendingControl = null; await enterPaused(); continue; }

      // --- LISTENING (цикл обработки no-speech на Android Chrome) ---
      let listenRes = null;
      let restartSpeaking = false;
      for (;;) {
        if (disposed) return { action: 'stopped' };
        emitState(HF_STATES.LISTENING, {
          statusText: noSpeechRetries > 0 ? `Слушаю ещё раз (${noSpeechRetries}/${maxNoSpeechRetries})…` : 'Говорите по-немецки…',
        });
        listenRes = await listenOnce();
        if (disposed) return { action: 'stopped' };

        if (pendingControl === 'skip') {
          pendingControl = null;
          emitState(HF_STATES.IDLE);
          return { action: 'skip' };
        }
        if (pendingControl === 'repeat') {
          pendingControl = null;
          noSpeechRetries = 0;
          restartSpeaking = true;
          break;
        }
        if (pendingControl === 'pause' || state === HF_STATES.PAUSED) {
          pendingControl = null;
          await enterPaused();
          restartSpeaking = true;
          break;
        }

        if (listenRes.status === 'no-speech') {
          if (noSpeechRetries < maxNoSpeechRetries) {
            noSpeechRetries += 1;
            emitInterim('');
            emitState(HF_STATES.LISTENING, { statusText: 'Тишина — перезапускаю микрофон…' });
            await interruptibleSleep(250);
            continue;
          }
          // После 2 автоперезапусков при полной тишине — мягкая пауза, НЕ ставим Again!
          noSpeechRetries = 0;
          await enterPaused('Тишина — режим на паузе. Нажмите «Продолжить»');
          restartSpeaking = true;
          break;
        }

        if (listenRes.status === 'fatal' || listenRes.status === 'unsupported') {
          const msg = listenRes.error === 'not-allowed' || listenRes.error === 'service-not-allowed'
            ? 'Нет доступа к микрофону. Разрешите микрофон в настройках браузера.'
            : listenRes.status === 'unsupported'
              ? 'Распознавание речи не поддерживается в этом браузере.'
              : 'Микрофон недоступен.';
          emitError(msg);
          await enterPaused(msg);
          restartSpeaking = true;
          break;
        }

        if (listenRes.status === 'network') {
          const msg = 'Для распознавания речи в Chrome требуется сеть.';
          emitError(msg);
          await enterPaused(msg);
          restartSpeaking = true;
          break;
        }

        if (listenRes.status === 'aborted') {
          restartSpeaking = true;
          break;
        }

        // status === 'ok'
        noSpeechRetries = 0;
        break;
      }

      if (restartSpeaking) continue;

      // --- EVALUATING ---
      await stopRecognition();
      emitState(HF_STATES.EVALUATING, { statusText: 'Проверяю ответ…' });
      const ev = evaluateVoiceAnswer(item, listenRes.transcripts);
      const responseMs = Math.max(0, Date.now() - cardStart);

      // Перехваченные голосовые команды
      if (ev.command === 'weiter') {
        emitFeedback({ kind: 'skip', heard: ev.transcript, expected: expectedPhrase });
        await safeBeep('tick');
        emitState(HF_STATES.IDLE);
        return { action: 'skip' };
      }
      if (ev.command === 'nochmal') {
        await safeBeep('tick');
        continue;
      }
      if (ev.command === 'stopp') {
        await safeBeep('tick');
        await enterPaused('Остановлено командой «stopp»');
        continue;
      }
      if (ev.command === 'schwer') {
        emitState(HF_STATES.FEEDBACK, { statusText: 'Оценка: Трудно (Hard)' });
        emitFeedback({ kind: 'hard', heard: ev.transcript, expected: expectedPhrase });
        await safeBeep('tick');
        await interruptibleSleep(hardPauseMs);
        emitState(HF_STATES.IDLE);
        return { action: 'rated', rating: 2, correct: true, userAnswer: ev.transcript, responseMs };
      }

      // --- FEEDBACK ---
      if (ev.matched) {
        emitState(HF_STATES.FEEDBACK, { statusText: '✓ Верно!' });
        emitFeedback({ kind: 'correct', heard: ev.transcript, expected: expectedPhrase });
        await safeBeep('success');
        await interruptibleSleep(correctPauseMs);
        emitState(HF_STATES.IDLE);
        return { action: 'rated', rating: 3, correct: true, userAnswer: ev.transcript, responseMs };
      }

      // Ошибка: мягкий сигнал -> озвучиваем правильный ответ -> Again -> пауза ~1.5 с
      emitState(HF_STATES.FEEDBACK, { statusText: `✗ Правильно: ${expectedPhrase}` });
      emitFeedback({ kind: 'wrong', heard: ev.transcript, expected: expectedPhrase });
      await safeBeep('error');
      if (!disposed && pendingControl !== 'skip') {
        await safeSpeak(expectedPhrase, { lang: 'de-DE' });
      }
      if (disposed) return { action: 'stopped' };
      if (pendingControl === 'skip') {
        pendingControl = null;
        emitState(HF_STATES.IDLE);
        return { action: 'rated', rating: 1, correct: false, userAnswer: ev.transcript, responseMs };
      }
      await interruptibleSleep(wrongPauseMs);
      emitState(HF_STATES.IDLE);
      return { action: 'rated', rating: 1, correct: false, userAnswer: ev.transcript, responseMs };
    }
  }

  return {
    get isSupported() { return !!getSRCtor(); },
    get state() { return state; },
    get wakeLockActive() { return wakeLock.isActive(); },
    start,
    runCard,
    speakLearnCard,
    pause,
    resume,
    skipCurrent,
    repeatCurrent,
    dispose,
  };
}

export default createHandsFreeEngine;
