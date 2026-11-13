// Плеер длинных текстов и диалогов поверх Web Speech API (немецкий голос).
// Текст режется на короткие фразы: длинные реплики в Chrome обрываются.
import { listGermanVoices, hasGermanVoice } from './tts.js';

const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
const MAX_CHUNK = 220;              // максимум символов в одной фразе
const PITCHES = [1, 1.25, 0.8];     // высота, если голосов меньше, чем говорящих

let token = 0;                      // номер текущего воспроизведения; stop() его меняет
let playing = false;
let activeAudio = null;
let serverTtsAvailable = true;

/** Можно ли озвучивать: всегда true (серверная нейросетевая озвучка Edge TTS + браузерный синтез) */
export function canPlay() {
  return serverTtsAvailable || (!!synth && hasGermanVoice());
}

export function isPlaying() {
  return playing;
}

/** Остановить воспроизведение (все ожидающие промисы завершатся значением false) */
export function stop() {
  token++;
  playing = false;
  if (activeAudio) {
    try { activeAudio.pause(); activeAudio.src = ''; } catch { /* ignore */ }
    activeAudio = null;
  }
  if (synth) {
    try { synth.cancel(); } catch { /* ignore */ }
  }
}

function clampRate(r) {
  const n = Number(r);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : 0.9;
}

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch { /* колбэк не должен ломать плеер */ }
}

/** Разбить текст на фразы не длиннее MAX_CHUNK (без lookbehind: старые Safari) */
export function splitChunks(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  for (const sentence of clean.replace(/([.!?…]+)\s+/g, '$1\u0001').split('\u0001')) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= MAX_CHUNK) { out.push(s); continue; }
    let cur = '';
    for (const w of s.split(' ')) {
      if (cur && cur.length + 1 + w.length > MAX_CHUNK) { out.push(cur); cur = w; }
      else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Немецкие голоса: предпочитаемый первым, затем de-DE, без дублей по имени */
function pickVoices(preferName) {
  const seen = new Set();
  const list = listGermanVoices().filter((v) => {
    if (!v || seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });
  const score = (v) => (preferName && v.name === preferName ? 2 : 0) + (/de[-_]DE/i.test(v.lang || '') ? 1 : 0);
  return list.sort((a, b) => score(b) - score(a));
}

/** Произнести одну фразу; resolve(true) — дочитали, false — ошибка или остановка */
function speakOne(text, { rate, pitch, voice }, myToken) {
  return new Promise((resolve) => {
    if (!synth || myToken !== token) return resolve(false);
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'de-DE';
      u.rate = rate;
      u.pitch = pitch;
      if (voice) { u.voice = voice; u.lang = voice.lang || 'de-DE'; }
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      // Страховка: в некоторых браузерах onend не приходит
      timer = setTimeout(() => {
        if (done) return;
        try { synth.cancel(); } catch { /* ignore */ }
        finish(false);
      }, 10000 + (text.length * 150) / Math.max(0.5, rate));
      synth.speak(u);
    } catch {
      finish(false);
    }
  });
}

/** Произнести фразу через серверный Edge Neural TTS (мужской/женский голос); при сбое — браузерный синтез */
async function speakEdgeOrBrowser(text, { rate, pitch, voice, role = 'female' }, myToken) {
  if (myToken !== token) return false;
  if (serverTtsAvailable && typeof Audio !== 'undefined') {
    try {
      const qs = new URLSearchParams({ text, role, rate: String(rate) });
      const resp = await fetch(`/api/tts/speak?${qs.toString()}`, { credentials: 'same-origin' });
      if (resp.ok && myToken === token) {
        const blob = await resp.blob();
        if (blob && blob.size > 100 && myToken === token) {
          const url = URL.createObjectURL(blob);
          const ok = await new Promise((resolve) => {
            const audio = new Audio(url);
            activeAudio = audio;
            const done = (res) => {
              if (activeAudio === audio) activeAudio = null;
              try { URL.revokeObjectURL(url); } catch { /* ignore */ }
              resolve(res);
            };
            audio.onended = () => done(true);
            audio.onerror = () => done(false);
            audio.play().catch(() => done(false));
          });
          if (ok) return true;
        }
      } else if (resp.status === 503) {
        serverTtsAvailable = false;
      }
    } catch {
      serverTtsAvailable = false;
    }
  }
  return speakOne(text, { rate, pitch, voice }, myToken);
}

/**
 * Прочитать связный текст.
 * @param {string} text
 * @param {{rate?: number, voice?: string, onProgress?: (fraction:number, chunkIndex:number)=>void}} [opts]
 * @returns {Promise<boolean>} true — дочитали до конца
 */
export async function playText(text, opts = {}) {
  const chunks = splitChunks(text);
  if (!chunks.length) return false;
  stop();
  const my = token;
  playing = true;
  const voice = pickVoices(opts.voice)[0] || null;
  const rate = clampRate(opts.rate);
  for (let i = 0; i < chunks.length; i++) {
    if (my !== token) return false;
    safeCall(opts.onProgress, i / chunks.length, i);
    const ok = await speakEdgeOrBrowser(chunks[i], { rate, pitch: 1, voice, role: 'female' }, my);
    if (!ok || my !== token) {
      if (my === token) playing = false;
      return false;
    }
  }
  if (my !== token) return false;
  playing = false;
  safeCall(opts.onProgress, 1, chunks.length);
  return true;
}

/**
 * Прочитать диалог двумя разными немецкими голосами:
 * на сервере — ConradNeural (мужской) и KatjaNeural (женский); в браузере — разные голоса/высота.
 * @param {{speaker: string, text: string}[]} lines
 * @param {{rate?: number, voice?: string, onLine?: (index:number, line:object)=>void}} [opts]
 * @returns {Promise<boolean>}
 */
export async function playDialogue(lines, opts = {}) {
  const list = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ speaker: String((l && l.speaker) ?? '').trim(), text: String((l && l.text) ?? '').trim() }))
    .filter((l) => l.text);
  if (!list.length) return false;
  stop();
  const my = token;
  playing = true;
  const voices = pickVoices(opts.voice);
  const rate = clampRate(opts.rate);
  const speakers = [];
  for (const l of list) if (!speakers.includes(l.speaker)) speakers.push(l.speaker);
  const n = Math.max(1, voices.length);
  const ROLES = ['male', 'female', 'alt_male', 'alt_female'];
  for (let i = 0; i < list.length; i++) {
    if (my !== token) return false;
    const line = list[i];
    const si = Math.max(0, speakers.indexOf(line.speaker));
    const voice = voices.length ? voices[si % voices.length] : null;
    const pitch = PITCHES[Math.floor(si / n) % PITCHES.length];
    const role = ROLES[si % ROLES.length];
    safeCall(opts.onLine, i, line);
    for (const chunk of splitChunks(line.text)) {
      const ok = await speakEdgeOrBrowser(chunk, { rate, pitch, voice, role }, my);
      if (!ok || my !== token) {
        if (my === token) playing = false;
        return false;
      }
    }
  }
  if (my !== token) return false;
  playing = false;
  return true;
}
