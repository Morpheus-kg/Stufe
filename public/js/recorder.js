// Запись звука через MediaRecorder. Аудио живёт только в памяти, нигде не сохраняется.

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
const MAX_BYTES = 9.5 * 1024 * 1024; // сервер принимает до 10 МБ

/** Поддерживается ли запись */
export function recorderSupported() {
  return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
}

function pickMime() {
  try {
    for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m;
  } catch { /* старые браузеры */ }
  return '';
}

/**
 * @param {{maxSeconds?: number}} [opts]
 * @returns {{supported:boolean, start():Promise<void>, stop():Promise<{blob:Blob, duration_s:number}>, cancel():void, isRecording():boolean}}
 */
export function createRecorder(opts = {}) {
  const maxSeconds = Number(opts.maxSeconds) > 0 ? Number(opts.maxSeconds) : 180;
  let mr = null;
  let stream = null;
  let chunks = [];
  let t0 = 0;
  let timer = null;
  let finished = null;
  let cancelled = false;

  const release = () => {
    clearTimeout(timer);
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } }
    stream = null;
  };

  async function start() {
    if (!recorderSupported()) throw new Error('Запись звука не поддерживается');
    if (mr && mr.state !== 'inactive') return;
    cancelled = false;
    chunks = [];
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = pickMime();
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { release(); throw e; }
    const baseType = (mr.mimeType || mime || 'audio/webm').split(';')[0];
    finished = new Promise((resolve, reject) => {
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onerror = () => { release(); reject(new Error('Ошибка записи')); };
      mr.onstop = () => {
        const duration_s = Math.max(0, Math.round((Date.now() - t0) / 1000));
        release();
        if (cancelled) { chunks = []; return reject(new Error('cancelled')); }
        // Параметры codecs убираем: сервер сверяет тип по основной части
        const blob = new Blob(chunks, { type: baseType });
        chunks = [];
        if (blob.size > MAX_BYTES) return reject(new Error('Запись слишком длинная'));
        resolve({ blob, duration_s });
      };
    });
    finished.catch(() => {}); // не оставляем необработанный reject
    t0 = Date.now();
    mr.start(1000);
    timer = setTimeout(() => { try { if (mr && mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ } }, maxSeconds * 1000);
  }

  function stop() {
    if (!mr || !finished) return Promise.reject(new Error('Запись не начата'));
    try { if (mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ }
    return finished;
  }

  function cancel() {
    cancelled = true;
    try { if (mr && mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ }
    release();
  }

  return { supported: recorderSupported(), start, stop, cancel, isRecording: () => !!mr && mr.state === 'recording' };
}