// Распознавание речи: браузерный SpeechRecognition (de-DE) или запись + Whisper на сервере
import { createRecorder, recorderSupported } from './recorder.js';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

/** Что доступно на этом устройстве */
export function sttSupport() {
  return { browser: !!SR, whisper: recorderSupported() };
}

function browserStt(opts) {
  let rec = null;
  let active = false;
  let base = '';      // текст предыдущих сегментов (после автоперезапуска)
  let current = '';   // текст текущего сегмента
  let fatal = null;
  let t0 = 0;
  let endWaiters = [];

  const full = () => `${base} ${current}`.replace(/\s+/g, ' ').trim();

  function spawn() {
    rec = new SR();
    rec.lang = 'de-DE';
    rec.continuous = true;
    rec.interimResults = true;
    current = '';
    rec.onresult = (e) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += ' ' + (e.results[i][0] ? e.results[i][0].transcript : '');
      current = txt.trim();
      if (typeof opts.onInterim === 'function') { try { opts.onInterim(full()); } catch { /* ignore */ } }
    };
    rec.onerror = (e) => {
      const c = e && e.error;
      if (c === 'not-allowed' || c === 'service-not-allowed' || c === 'audio-capture' || c === 'network') {
        fatal = c;
        active = false;
      }
    };
    rec.onend = () => {
      if (active) {
        // браузер сам закрывает сессию после паузы: продолжаем
        base = full();
        try { spawn(); rec.start(); return; } catch { active = false; }
      }
      const w = endWaiters; endWaiters = [];
      w.forEach((f) => f());
    };
  }

  return {
    supported: !!SR,
    async start() {
      if (!SR) throw new Error('Распознавание речи не поддерживается');
      base = ''; current = ''; fatal = null; active = true; t0 = Date.now();
      spawn();
      try { rec.start(); } catch (e) { active = false; throw e; }
    },
    async stop() {
      active = false;
      const ended = new Promise((r) => { endWaiters.push(r); setTimeout(r, 2500); });
      try { if (rec) rec.stop(); } catch { /* ignore */ }
      await ended;
      const transcript = full();
      if (fatal && !transcript) {
        const msg = fatal === 'not-allowed' || fatal === 'service-not-allowed' ? 'Нет доступа к микрофону'
          : fatal === 'network' ? 'Браузерному распознаванию нужна сеть' : 'Микрофон недоступен';
        throw new Error(msg);
      }
      return { transcript, duration_s: Math.max(0, Math.round((Date.now() - t0) / 1000)), engine: 'browser' };
    },
  };
}

function whisperStt() {
  const recorder = createRecorder({ maxSeconds: 180 });
  return {
    supported: recorder.supported,
    start: () => recorder.start(),
    async stop() {
      const { blob, duration_s } = await recorder.stop();
      if (!blob || blob.size < 1000) return { transcript: '', duration_s, engine: 'whisper' };
      const api2 = await import('./api2.js');
      const res = await api2.speakingTranscribe(blob, duration_s);
      return {
        transcript: String((res && res.transcript) || ''),
        duration_s: Number.isFinite(Number(res && res.duration_s)) ? Number(res.duration_s) : duration_s,
        engine: 'whisper',
      };
    },
    cancel: () => recorder.cancel(),
  };
}

/**
 * @param {'browser'|'whisper'} engine
 * @param {{onInterim?: (text:string)=>void}} [opts]
 * @returns {{supported:boolean, start():Promise<void>, stop():Promise<{transcript:string, duration_s:number, engine:string}>, cancel?():void}}
 */
export function createStt(engine, opts = {}) {
  return engine === 'whisper' ? whisperStt() : browserStt(opts);
}