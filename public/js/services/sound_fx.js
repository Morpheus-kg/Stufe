// Генератор коротких звуковых сигналов обратной связи через Web Audio API (без внешних файлов).

export function createSoundFx(deps = {}) {
  const getAudioCtxCtor = deps.getAudioCtxCtor ?? (() => {
    if (typeof window === 'undefined') return null;
    return window.AudioContext || window.webkitAudioContext || null;
  });

  let ctx = null;

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = getAudioCtxCtor();
    if (!Ctor) return null;
    try { ctx = new Ctor(); } catch { ctx = null; }
    return ctx;
  }

  /** Вызвать в обработчике клика пользователя для разблокировки Web Audio на Android Chrome */
  function unlock() {
    const c = ensureContext();
    if (!c) return;
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') {
        c.resume().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  /** Проиграть последовательность тонов и резолвиться строго после окончания звука */
  function playSequence(notes) {
    return new Promise((resolve) => {
      const c = ensureContext();
      if (!c) return resolve();
      try {
        if (c.state === 'suspended' && typeof c.resume === 'function') {
          c.resume().catch(() => {});
        }
        const now = c.currentTime + 0.01;
        let offset = 0;
        for (const n of notes) {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = n.type || 'sine';
          osc.frequency.setValueAtTime(n.freq, now + offset);
          const start = now + offset;
          const end = start + n.dur;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.linearRampToValueAtTime(n.vol ?? 0.14, start + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, end);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(start);
          osc.stop(end + 0.01);
          offset += n.dur + (n.gap || 0);
        }
        const totalMs = Math.ceil((offset + 0.04) * 1000);
        setTimeout(resolve, totalMs);
      } catch {
        resolve();
      }
    });
  }

  return {
    unlock,
    /** Короткий приятный сигнал успеха */
    beepSuccess: () => playSequence([
      { freq: 587.33, dur: 0.075, vol: 0.13, gap: 0.02 },
      { freq: 880.0, dur: 0.11, vol: 0.14 },
    ]),
    /** Мягкий сигнал ошибки */
    beepError: () => playSequence([
      { freq: 290, dur: 0.11, vol: 0.12, type: 'triangle', gap: 0.02 },
      { freq: 220, dur: 0.14, vol: 0.11, type: 'triangle' },
    ]),
    /** Нейтральный короткий сигнал (Hard / начало ответа / пауза) */
    beepTick: () => playSequence([
      { freq: 440, dur: 0.08, vol: 0.10 },
    ]),
  };
}

export const soundFx = createSoundFx();
export default soundFx;
