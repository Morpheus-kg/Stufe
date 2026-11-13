// Озвучка через Web Speech API (немецкий голос)

const synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
let preferredVoice = '';
let cache = [];

function refresh() {
  if (!synth) return [];
  try { cache = synth.getVoices() || []; } catch { cache = []; }
  return cache;
}
if (synth) {
  refresh();
  try { synth.addEventListener('voiceschanged', refresh); } catch { /* старые браузеры */ }
}

/** Голоса с языком de-* */
export function listGermanVoices() {
  return refresh().filter((v) => /^de([-_]|$)/i.test(v.lang || ''));
}

export function hasGermanVoice() {
  return listGermanVoices().length > 0;
}

/** Ждём загрузки списка голосов (он приходит асинхронно). Возвращает true, если есть немецкий голос */
export function voicesReady(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!synth || hasGermanVoice()) return resolve(hasGermanVoice());
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (hasGermanVoice() || Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve(hasGermanVoice());
      }
    }, 150);
  });
}

/** Предпочитаемый голос (settings.tts_voice) */
export function setPreferredVoice(name) {
  preferredVoice = typeof name === 'string' ? name : '';
}

/**
 * Произнести текст. Никогда не бросает исключений; resolve(true) — дочитали, false — не удалось.
 * @param {string} text
 * @param {{rate?: number, voice?: string}} [opts]
 */
export function speak(text, opts = {}) {
  return new Promise((resolve) => {
    const clean = String(text ?? '').trim().slice(0, 500);
    if (!synth || !clean) return resolve(false);
    let timer = null;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = 'de-DE';
      const r = Number(opts.rate);
      u.rate = Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 0.9;
      const voices = listGermanVoices();
      const want = opts.voice !== undefined ? opts.voice : preferredVoice;
      const v = (want && voices.find((x) => x.name === want)) || voices.find((x) => /de[-_]DE/i.test(x.lang)) || voices[0];
      if (v) { u.voice = v; u.lang = v.lang; }
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      // Страховка: в некоторых браузерах onend не приходит
      timer = setTimeout(() => finish(false), 15000 + clean.length * 120);
      synth.speak(u);
    } catch {
      finish(false);
    }
  });
}