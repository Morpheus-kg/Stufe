// AudioPlayerService: локальная предсгенерированная озвучка (Piper TTS из /audio/de/)
// с graceful fallback на window.speechSynthesis и строгим Promise по ended/error.

const MANIFEST_URL = '/audio/de/manifest.json';
const DEFAULT_BASE_PATH = '/audio/de/';
// Минимальный валидный тихий WAV (44 байта) для разблокировки autoplay на Android Chrome по клику
const SILENT_WAV_URI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

// Должно 1-в-1 совпадать с scripts/generate_audio.py::normalize_audio_key
const EDGE_PUNCT_RE = /^[\s.,!?;:()[\]{}"'„“”«»…—–-]+|[\s.,!?;:()[\]{}"'„“”«»…—–-]+$/g;
const QUOTES_RE = /[„“”«»"]/g;
const APOS_RE = /[’`´]/g;
const WS_RE = /\s+/g;

/**
 * Канонический ключ фразы для поиска в manifest.json.
 * Идентичен Python-функции normalize_audio_key(): NFC, единые пробелы, снятие краевой пунктуации,
 * lowerCase с сохранением умляутов и ß.
 * @param {string} text
 * @returns {string}
 */
export function normalizeAudioKey(text) {
  if (text == null) return '';
  let s = String(text).normalize('NFC');
  s = s.replace(APOS_RE, "'").replace(QUOTES_RE, '');
  s = s.replace(WS_RE, ' ').trim();
  s = s.replace(EDGE_PUNCT_RE, '');
  s = s.replace(WS_RE, ' ').trim();
  return s.toLowerCase();
}

function clampRate(rate, fallback = 0.9) {
  const n = Number(rate);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : fallback;
}

/**
 * Фабрика AudioPlayerService (с инъекцией зависимостей для unit-тестов).
 * @param {object} [deps]
 */
export function createAudioPlayer(deps = {}) {
  const fetchFn = deps.fetch ?? (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  const createAudio = deps.createAudio ?? (typeof Audio === 'function' ? () => new Audio() : null);
  const getSynth = deps.getSynth ?? (() => (typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null));
  const createUtterance = deps.createUtterance ?? ((text) => new SpeechSynthesisUtterance(text));
  const manifestUrl = deps.manifestUrl ?? MANIFEST_URL;

  let entries = new Map();
  let basePath = DEFAULT_BASE_PATH;
  let manifestLoaded = false;
  let manifestLoading = null;

  let token = 0;
  let playing = false;
  let activeCancel = null;
  let sharedAudio = null;
  let preferredVoice = '';

  function ensureSharedAudio() {
    if (!sharedAudio && createAudio) {
      try { sharedAudio = createAudio(); } catch { sharedAudio = null; }
    }
    return sharedAudio;
  }

  /** Прогрев HTMLAudioElement в обработчике жеста пользователя (Android Chrome PWA autoplay). */
  function unlock() {
    const audio = ensureSharedAudio();
    if (!audio) return;
    try {
      audio.muted = true;
      audio.src = SILENT_WAV_URI;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          try { audio.pause(); audio.currentTime = 0; audio.muted = false; } catch { /* ignore */ }
        }).catch(() => {
          try { audio.muted = false; } catch { /* ignore */ }
        });
      } else {
        audio.muted = false;
      }
    } catch {
      try { audio.muted = false; } catch { /* ignore */ }
    }
  }

  function setPreferredVoice(name) {
    preferredVoice = typeof name === 'string' ? name : '';
  }

  async function loadManifest(force = false) {
    if (manifestLoaded && !force) return;
    if (manifestLoading && !force) return manifestLoading;
    if (!fetchFn) {
      manifestLoaded = true;
      return;
    }
    manifestLoading = (async () => {
      try {
        const res = await fetchFn(manifestUrl, { cache: force ? 'no-cache' : 'default' });
        if (!res || !res.ok) {
          if (force) entries = new Map();
          manifestLoaded = true;
          return;
        }
        const data = await res.json();
        const nextMap = new Map();
        if (data && typeof data === 'object') {
          if (typeof data.basePath === 'string' && data.basePath.startsWith('/')) {
            basePath = data.basePath.endsWith('/') ? data.basePath : `${data.basePath}/`;
          }
          const raw = data.entries && typeof data.entries === 'object' ? data.entries : {};
          for (const [k, v] of Object.entries(raw)) {
            const nk = normalizeAudioKey(k);
            if (!nk || !v || typeof v !== 'object') continue;
            const rec = {};
            if (typeof v.normal === 'string' && v.normal) rec.normal = v.normal;
            if (typeof v.slow === 'string' && v.slow) rec.slow = v.slow;
            if (rec.normal || rec.slow) nextMap.set(nk, rec);
          }
        }
        entries = nextMap;
      } catch {
        // Манифест необязателен: тихо падаем в speechSynthesis
      } finally {
        manifestLoaded = true;
        manifestLoading = null;
      }
    })();
    return manifestLoading;
  }

  function resolveStaticUrl(text, opts = {}) {
    const key = normalizeAudioKey(text);
    if (!key) return null;
    const rec = entries.get(key);
    if (!rec) return null;
    const wantSlow = opts.slow === true || (Number.isFinite(Number(opts.rate)) && Number(opts.rate) <= 0.85);
    const file = (wantSlow && rec.slow) ? rec.slow : (rec.normal || rec.slow);
    return file ? `${basePath}${file}` : null;
  }

  function hasStatic(text, opts = {}) {
    return resolveStaticUrl(text, opts) !== null;
  }

  /**
   * Мгновенно останавливает текущее воспроизведение и резолвит ожидающий Promise.
   */
  function stop() {
    token += 1;
    playing = false;
    if (activeCancel) {
      const fn = activeCancel;
      activeCancel = null;
      try { fn(); } catch { /* ignore */ }
    }
    const synth = getSynth();
    if (synth) {
      try { synth.cancel(); } catch { /* ignore */ }
    }
  }

  function playStatic(url, opts, myToken) {
    return new Promise((resolve) => {
      const audio = ensureSharedAudio();
      if (!audio || myToken !== token) return resolve({ ok: false, source: 'static', interrupted: myToken !== token });

      let settled = false;
      let timer = null;

      const detach = () => {
        audio.onended = null;
        audio.onerror = null;
        audio.onloadedmetadata = null;
        if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      };

      const finish = (ok, interrupted = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        if (activeCancel === cancelMe) activeCancel = null;
        if (myToken === token) playing = false;
        resolve({ ok, source: 'static', ...(interrupted ? { interrupted: true } : {}) });
      };

      const cancelMe = () => {
        detach();
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch { /* ignore */ }
        finish(false, true);
      };

      const onAbort = () => cancelMe();
      activeCancel = cancelMe;
      if (opts.signal) {
        if (opts.signal.aborted) { cancelMe(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const armSafety = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), ms);
      };

      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          armSafety(Math.max(4000, Math.round(audio.duration * 1000) + 2500));
        }
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);

      armSafety(20000);
      try {
        audio.muted = false;
        audio.playbackRate = 1.0;
        audio.src = url;
        if (typeof audio.load === 'function') audio.load();
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => finish(false));
        }
      } catch {
        finish(false);
      }
    });
  }

  function pickVoice(synth, lang, preferName) {
    let voices = [];
    try { voices = synth.getVoices() || []; } catch { voices = []; }
    const baseLang = String(lang || 'de-DE').split(/[-_]/)[0].toLowerCase();
    const matching = voices.filter((v) => new RegExp(`^${baseLang}([-_]|$)`, 'i').test(v.lang || ''));
    if (!matching.length) return null;
    if (preferName) {
      const exact = matching.find((v) => v.name === preferName);
      if (exact) return exact;
    }
    const regionRe = new RegExp(`^${String(lang || 'de-DE').replace(/[-_]/, '[-_]')}$`, 'i');
    return matching.find((v) => regionRe.test(v.lang || '')) || matching[0];
  }

  function playSpeechSynthesis(text, opts, myToken) {
    return new Promise((resolve) => {
      const synth = getSynth();
      if (!synth || myToken !== token) return resolve({ ok: false, source: 'none', interrupted: myToken !== token });

      let settled = false;
      let timer = null;
      const lang = opts.lang || 'de-DE';
      const rate = clampRate(opts.rate, opts.slow ? 0.75 : 0.9);

      const finish = (ok, interrupted = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
        if (activeCancel === cancelMe) activeCancel = null;
        if (myToken === token) playing = false;
        resolve({ ok, source: 'speechSynthesis', ...(interrupted ? { interrupted: true } : {}) });
      };

      const cancelMe = () => {
        try { synth.cancel(); } catch { /* ignore */ }
        finish(false, true);
      };

      const onAbort = () => cancelMe();
      activeCancel = cancelMe;
      if (opts.signal) {
        if (opts.signal.aborted) { cancelMe(); return; }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        synth.cancel();
        const u = createUtterance(text);
        u.lang = lang;
        u.rate = rate;
        const wantVoice = opts.voice !== undefined ? opts.voice : (lang.toLowerCase().startsWith('de') ? preferredVoice : '');
        const v = pickVoice(synth, lang, wantVoice);
        if (v) {
          u.voice = v;
          u.lang = v.lang || lang;
        }
        u.onend = () => finish(true);
        u.onerror = () => finish(false);
        timer = setTimeout(() => {
          try { synth.cancel(); } catch { /* ignore */ }
          finish(false);
        }, Math.round(12000 + (text.length * 140) / Math.max(0.5, rate)));
        synth.speak(u);
      } catch {
        finish(false);
      }
    });
  }

  /**
   * Воспроизвести текст: сначала предсгенерированный локальный файл (для de-DE),
   * при отсутствии/ошибке — graceful fallback на speechSynthesis.
   * Возвращает Promise<{ok, source, interrupted?}>, резолвящийся строго по ended/error/stop.
   * @param {string} text
   * @param {{slow?:boolean, rate?:number, lang?:string, voice?:string, signal?:AbortSignal}} [opts]
   */
  async function play(text, opts = {}) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!clean) return { ok: false, source: 'none' };
    if (opts.signal && opts.signal.aborted) return { ok: false, source: 'none', interrupted: true };

    stop();
    const myToken = token;
    playing = true;

    const lang = opts.lang || 'de-DE';
    const isGerman = /^de([-_]|$)/i.test(lang);

    if (isGerman) {
      if (!manifestLoaded) {
        await Promise.race([loadManifest(), new Promise((r) => setTimeout(r, 1500))]);
      }
      if (myToken !== token || (opts.signal && opts.signal.aborted)) {
        if (myToken === token) playing = false;
        return { ok: false, source: 'none', interrupted: true };
      }

      const staticUrl = resolveStaticUrl(clean, opts);
      if (staticUrl) {
        const res = await playStatic(staticUrl, opts, myToken);
        if (res.ok || res.interrupted || myToken !== token) return res;
        // Файл недоступен/битый -> плавный fallback на speechSynthesis
        playing = true;
      }
    }

    if (myToken !== token || (opts.signal && opts.signal.aborted)) {
      if (myToken === token) playing = false;
      return { ok: false, source: 'none', interrupted: true };
    }

    return playSpeechSynthesis(clean, opts, myToken);
  }

  return {
    loadManifest,
    unlock,
    setPreferredVoice,
    hasStatic,
    play,
    stop,
    isPlaying: () => playing,
  };
}

export const audioPlayer = createAudioPlayer();
export default audioPlayer;
