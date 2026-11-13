// #/listen (список и генерация) и #/listen/:id (плеер: прослушивание, вопросы, текст, диктовка)
import { h, navigate } from '../app.js';
import { getText, postTextAttempt } from '../api2.js';
import { mountQuiz } from '../ui/quiz.js';
import { playText, playDialogue, stop, isPlaying } from '../tts_player.js';
import { voicesReady } from '../tts.js';
import { gradeSentence } from '/shared/grading.js';
import { buildGenerateForm, buildTextList, describeError, routeId } from './texts.js';
import { renderTappableText } from './reader.js';

const MAX_DICT = 10;                       // предложений в диктовке за раз
const DICT_PLAYS = { easy: Infinity, medium: 2, hard: 1 };
const hasSynth = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));

/** Строки диалога «Имя: реплика» -> [{speaker, text}] */
function parseDialogue(body) {
  const out = [];
  let last = 'Sprecher';
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(t);
    if (m) { last = m[1].trim(); out.push({ speaker: last, text: m[2].trim() }); }
    else out.push({ speaker: last, text: t });
  }
  return out;
}

/** Предложения для диктовки (без имён говорящих, от 3 слов) */
function splitSentences(body, dialogue) {
  const out = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    let t = line.trim();
    if (!t) continue;
    if (dialogue) t = t.replace(/^[^:]{1,40}:\s*/, '');
    for (const s of t.replace(/([.!?…]+)\s+/g, '$1\u0001').split('\u0001')) {
      const x = s.trim();
      if (x.split(/\s+/).length >= 3 && x.length <= 300) out.push(x);
    }
  }
  return out.slice(0, MAX_DICT);
}

const stripPunct = (s) => String(s).replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Разбор по словам: «−» лишнее слово, «+» пропущенное (текстовые метки, не только цвет) */
function renderDiff(host, diff) {
  const parts = [];
  for (const d of Array.isArray(diff) ? diff : []) {
    if (!d || typeof d.w !== 'string') continue;
    if (d.t === 'del') { const s = h('del', { text: `−${d.w}` }); parts.push(s); }
    else if (d.t === 'ins') { const s = h('strong', { text: `+${d.w}` }); parts.push(s); }
    else parts.push(d.w);
    parts.push(' ');
  }
  host.replaceChildren(...parts, h('p', { class: 'muted', text: '− лишнее слово, + пропущенное слово' }));
}

function safeGrade(answer, expected, hard) {
  const a = hard ? stripPunct(answer) : answer;
  const e = hard ? stripPunct(expected) : expected;
  try {
    const g = gradeSentence(a, e);
    if (g && typeof g.result === 'string') return g;
  } catch { /* упадём на простое сравнение */ }
  const same = String(a).trim().toLowerCase() === String(e).trim().toLowerCase();
  return { result: same ? 'correct' : 'wrong', similarity: same ? 1 : 0, diff: [], note: '' };
}

// ---------- список ----------
function mountList(container) {
  const list = buildTextList({
    kinds: ['listening', 'dialogue'], href: '#/listen/', emptyText: 'Пока нет аудио-текстов.',
  });
  container.append(
    h('h2', { text: 'Аудирование' }),
    hasSynth() ? null : h('p', { class: 'error', text: 'Этот браузер не умеет озвучивать текст.' }),
    h('details', { open: !!(location.hash.includes('new=1')) },
      h('summary', { text: 'Сгенерировать аудио-текст' }),
      buildGenerateForm({ audio: true, onCreated: (item) => navigate(`#/listen/${item.id}`) })),
    h('h3', { text: 'Сохранённые' }),
    list.el);
  return () => {};
}

// ---------- плеер ----------
async function mountPlayer(container, ctx, id) {
  const settings = (ctx && ctx.settings) || {};
  const maxPlays = Number(settings.listening_plays) === 1 ? 1 : 2;
  const difficulty = ['easy', 'medium', 'hard'].includes(settings.difficulty) ? settings.difficulty : 'medium';
  const voiceName = typeof settings.tts_voice === 'string' ? settings.tts_voice : '';
  let secsTimer = null;
  let alive = true;
  const cleanup = () => {
    alive = false;
    if (secsTimer) clearInterval(secsTimer);
    secsTimer = null;
    stop();
  };

  container.append(h('p', { class: 'muted center', text: 'Загрузка…' }));
  let item;
  try {
    item = await getText(id);
  } catch (e) {
    container.replaceChildren(h('div', { class: 'card-box stack center' },
      h('p', { class: 'error', text: describeError(e) }),
      h('a', { class: 'btn', href: '#/listen', text: 'К списку' })));
    return cleanup;
  }
  if (!item || typeof item.body !== 'string' || !item.body.trim()) {
    container.replaceChildren(h('div', { class: 'card-box stack center' },
      h('p', { class: 'error', text: 'Не удалось открыть текст.' }),
      h('a', { class: 'btn', href: '#/listen', text: 'К списку' })));
    return cleanup;
  }

  const isDialogue = item.kind === 'dialogue';
  const lines = isDialogue ? parseDialogue(item.body) : [];
  const questions = Array.isArray(item.questions) ? item.questions : [];
  let plays = 0;
  let training = false;
  let rate = Math.min(1.1, Math.max(0.8, Number(settings.tts_rate) || 0.9));
  let userStopped = false;
  let quizStarted = false;
  let secs = 0;
  secsTimer = setInterval(() => { if (!document.hidden) secs++; }, 1000);

  // Элементы плеера
  const status = h('p', { class: 'muted center' });
  const msg = h('p', { class: 'error' });
  const bar = h('div');
  bar.style.height = '6px';
  bar.style.width = '0%';
  bar.style.background = 'currentColor';
  bar.style.transition = 'width .3s';
  const track = h('div', null, bar);
  track.style.background = 'rgba(128,128,128,.25)';
  track.style.borderRadius = '3px';
  const nowLine = h('p', { class: 'muted center' });
  const playBtn = h('button', { class: 'btn primary', type: 'button', onclick: onPlay });
  playBtn.style.minHeight = '56px';
  const rateLabel = h('span', { text: `Скорость: ${rate.toFixed(2)}` });
  const rateInput = h('input', { type: 'range', min: '0.8', max: '1.1', step: '0.05', value: String(rate),
    oninput: () => { rate = Number(rateInput.value) || 0.9; rateLabel.textContent = `Скорость: ${rate.toFixed(2)}`; } });
  const trainBox = h('input', { type: 'checkbox', onchange: () => { training = trainBox.checked; refresh(); } });
  const toQuiz = h('button', { class: 'btn', type: 'button', text: questions.length ? 'К вопросам' : 'Показать текст', onclick: startQuiz });
  const quizHost = h('div', { class: 'stack' });
  const resultHost = h('div', { class: 'stack' });
  const transcriptHost = h('div', { class: 'stack' });
  const dictHost = h('div', { class: 'stack' });
  const voiceHint = h('p', { class: 'muted', hidden: true,
    text: 'Немецкий голос не найден. Установите немецкий голос в настройках телефона (синтез речи).' });

  function refresh() {
    const exhausted = !training && plays >= maxPlays;
    status.textContent = `Прослушиваний: ${plays} из ${training ? '∞' : maxPlays}`;
    playBtn.textContent = isPlaying() ? '■ Стоп' : exhausted ? 'Прослушивания закончились' : '▶ Слушать';
    playBtn.style.opacity = exhausted && !isPlaying() ? '0.5' : '1';
  }

  async function onPlay() {
    if (isPlaying()) { userStopped = true; stop(); refresh(); return; }
    if (!hasSynth()) { msg.textContent = 'Этот браузер не умеет озвучивать текст.'; return; }
    if (!training && plays >= maxPlays) return;
    msg.textContent = '';
    userStopped = false;
    plays++;
    bar.style.width = '0%';
    refresh();
    const t0 = Date.now();
    let ok = false;
    try {
      if (isDialogue && lines.length) {
        ok = await playDialogue(lines, {
          rate, voice: voiceName,
          onLine: (i, l) => {
            bar.style.width = `${Math.round((i / lines.length) * 100)}%`;
            nowLine.textContent = `Реплика ${i + 1} из ${lines.length} · ${l.speaker}`;
          },
        });
      } else {
        ok = await playText(item.body, { rate, voice: voiceName, onProgress: (f) => { bar.style.width = `${Math.round(f * 100)}%`; } });
      }
    } catch { ok = false; }
    if (!alive) return;
    if (ok) bar.style.width = '100%';
    nowLine.textContent = '';
    // Сразу упало без звука: прослушивание не засчитываем
    if (!ok && !userStopped && Date.now() - t0 < 1000) {
      plays = Math.max(0, plays - 1);
      msg.textContent = 'Не удалось воспроизвести звук. Проверьте немецкий голос в системе.';
    }
    refresh();
  }

  // Квиз -> сохранение попытки -> текст
  let attemptPayload = null;
  let submitting = false;
  async function saveAttempt() {
    if (submitting || !attemptPayload) return;
    submitting = true;
    try {
      const r = await postTextAttempt(id, attemptPayload);
      const line = r && Number.isFinite(r.total) && r.total > 0 ? `Результат сохранён: ${r.correct} из ${r.total}` : 'Аудирование засчитано.';
      resultHost.replaceChildren(h('p', null, h('strong', { text: line })));
      attemptPayload = null;
    } catch (e) {
      resultHost.replaceChildren(
        h('p', { class: 'error', text: `Не удалось сохранить: ${describeError(e)}` }),
        h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: () => { submitting = false; saveAttempt(); } }));
      return;
    }
    submitting = false;
  }

  async function startQuiz() {
    if (quizStarted) return;
    quizStarted = true;
    toQuiz.hidden = true;
    let res = { answers: [] };
    if (questions.length) {
      res = await mountQuiz(quizHost, questions, { revealAfter: training ? 'each' : 'end', showEvidence: !training });
    }
    stop();
    refresh();
    attemptPayload = {
      mode: 'listen', answers: res.answers, plays_used: clampInt(plays, 0, 127), seconds: clampInt(secs, 0, 14400),
    };
    if (!alive) return;
    saveAttempt();
    showTranscript();
  }

  function showTranscript() {
    const body = h('div', { class: 'card-box stack' });
    renderTappableText(body, item.body, { dialogue: isDialogue, glossary: item.glossary });
    transcriptHost.replaceChildren(
      h('h3', { text: 'Текст' }),
      h('p', { class: 'muted', text: 'Нажмите на слово, чтобы увидеть перевод.' }),
      body,
      h('button', { class: 'btn primary', type: 'button', text: 'Диктовка по предложениям', onclick: startDictation }));
  }

  // Диктовка по предложениям
  function startDictation() {
    const sentences = splitSentences(item.body, isDialogue);
    if (!sentences.length) { dictHost.replaceChildren(h('p', { class: 'muted', text: 'В тексте нет подходящих предложений.' })); return; }
    const maxP = DICT_PLAYS[difficulty];
    const hard = difficulty === 'hard';
    const t0 = Date.now();
    let idx = 0;
    let correct = 0;
    let sim = 0;
    let dPlays = 0;
    let checked = false;
    let left = maxP;
    let posted = false;

    const draw = () => {
      checked = false;
      left = maxP;
      const target = sentences[idx];
      const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', lang: 'de', placeholder: 'Напишите услышанное' });
      input.style.minHeight = '44px';
      const fb = h('div', { class: 'feedback stack' });
      const playS = h('button', { class: 'btn', type: 'button' });
      const slowS = difficulty === 'easy' ? h('button', { class: 'btn', type: 'button', text: '🐢 Медленно' }) : null;
      const label = () => { playS.textContent = `▶ Слушать (${left === Infinity ? '∞' : left})`; };
      const doPlay = async (r) => {
        if (isPlaying()) { stop(); return; }
        if (left <= 0) return;
        if (left !== Infinity) left--;
        dPlays++;
        label();
        try { await playText(target, { rate: r, voice: voiceName }); } catch { /* ignore */ }
      };
      label();
      playS.onclick = () => doPlay(rate);
      if (slowS) slowS.onclick = () => doPlay(0.7);
      const next = h('button', { class: 'btn primary', type: 'button', text: idx === sentences.length - 1 ? 'Итог' : 'Дальше', hidden: true, onclick: advance });
      const check = h('button', { class: 'btn primary', type: 'button', text: 'Проверить', onclick: () => grade(input.value.trim()) });
      const skip = h('button', { class: 'btn', type: 'button', text: 'Не расслышал(а)', onclick: () => grade('') });
      function grade(answer) {
        if (checked) return;
        checked = true;
        stop();
        const g = answer ? safeGrade(answer, target, hard) : { result: 'wrong', similarity: 0, diff: [], note: '' };
        if (g.result === 'correct') correct++;
        sim += Number.isFinite(g.similarity) ? g.similarity : 0;
        const verdict = g.result === 'correct' ? 'Верно' : g.result === 'almost' ? 'Почти' : answer ? 'Неверно' : 'Пропущено';
        const diffBox = h('p');
        if (answer) renderDiff(diffBox, g.diff);
        fb.replaceChildren(h('p', null, h('strong', { text: verdict })), g.note ? h('p', { text: g.note }) : null, diffBox,
          h('p', null, 'Эталон: ', h('strong', { text: target })));
        check.hidden = true;
        skip.hidden = true;
        next.hidden = false;
        next.focus();
      }
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.repeat) return;
        e.preventDefault();
        if (checked) advance(); else grade(input.value.trim());
      });
      dictHost.replaceChildren(h('div', { class: 'card-box stack' },
        h('p', { class: 'muted', text: `Предложение ${idx + 1} из ${sentences.length}` }),
        h('div', { class: 'actions' }, playS, slowS), input,
        h('div', { class: 'actions' }, check, skip, next), fb));
      input.focus();
    };

    const advance = () => {
      if (!checked) return;
      if (idx < sentences.length - 1) { idx++; draw(); return; }
      finishDict();
    };

    const finishDict = async () => {
      stop();
      const total = sentences.length;
      const pct = Math.round((sim / total) * 100);
      const summary = h('div', { class: 'card-box stack center' },
        h('p', null, h('strong', { text: `Точно: ${correct} из ${total} · сходство ${pct}%` })));
      const status2 = h('p', { class: 'muted', text: 'Сохраняем…' });
      summary.append(status2, h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '#/listen', text: 'К списку' }),
        h('a', { class: 'btn primary', href: '#/listen?new=1', text: 'Новый текст' })));
      dictHost.replaceChildren(summary);
      const send = async () => {
        if (posted) return;
        try {
          await postTextAttempt(id, {
            mode: 'dictation', correct, total, plays_used: clampInt(dPlays, 0, 127),
            seconds: clampInt((Date.now() - t0) / 1000, 0, 14400),
          });
          posted = true;
          status2.textContent = 'Результат сохранён.';
        } catch (e) {
          status2.textContent = `Не удалось сохранить: ${describeError(e)}`;
          summary.append(h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: send }));
        }
      };
      send();
    };

    draw();
  }

  container.replaceChildren(
    h('a', { href: '#/listen', text: '← Аудирование' }),
    h('h2', { text: String(item.title || 'Аудирование') }),
    h('p', { class: 'muted', text: [isDialogue ? 'Диалог' : 'Монолог', item.level, item.topic].filter(Boolean).join(' · ') }),
    h('div', { class: 'card-box stack' },
      voiceHint, status, playBtn, track, nowLine,
      h('label', { class: 'stack' }, rateLabel, rateInput),
      h('label', null, trainBox, ' Тренировка: без ограничения прослушиваний'),
      msg, toQuiz),
    quizHost, resultHost, transcriptHost, dictHost);
  refresh();

  // Подсказка про голос: список голосов приходит асинхронно
  voicesReady().then((ok) => { if (alive && !ok && hasSynth()) voiceHint.hidden = false; }).catch(() => {});

  return cleanup;
}

export async function mount(container, ctx) {
  const id = routeId(ctx, 'listen');
  return id ? mountPlayer(container, ctx, id) : mountList(container);
}
