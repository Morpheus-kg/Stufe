// Клиент API v2: по одной функции на endpoint. Возвращает JSON или бросает ApiError.
import { ApiError } from './api.js';

function redirectToLogin() {
  if (location.hash !== '#/login') location.hash = '#/login';
}

async function request(method, path, opts = {}) {
  const { body, raw, query, headers, timeoutMs = 30000 } = opts;
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const hdrs = { ...(headers || {}) };
  let payload;
  if (raw !== undefined) {
    payload = raw; // Blob для распознавания речи
  } else if (body !== undefined) {
    hdrs['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: hdrs, body: payload, signal: ctrl.signal });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', e && e.name === 'AbortError' ? 'Сервер не отвечает' : 'Нет соединения с сервером');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : {};
    if (res.status === 401) redirectToLogin();
    const extra = { ...(data && typeof data === 'object' ? data : {}), ...err };
    delete extra.error;
    throw new ApiError(
      res.status,
      err.code || (res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL'),
      err.message || 'Ошибка сервера',
      extra
    );
  }
  return data;
}

const enc = (id) => encodeURIComponent(id);

// --- план, навыки, экзамен ---
export const getPlan = () => request('GET', '/plan/today');
export const getSkills = () => request('GET', '/skills/summary');
export const getExam = () => request('GET', '/exam');
export const postExam = (fields) => request('POST', '/exam', { body: fields || {} });
export const deleteExam = (id) => request('DELETE', `/exam/${enc(id)}`);

// --- тексты ---
export const listTexts = (params = {}) => {
  const { kind, limit, offset } = params;
  return request('GET', '/texts', { query: { kind, limit, offset } });
};
export const getText = (id) => request('GET', `/texts/${enc(id)}`);
export const createText = (fields) => request('POST', '/texts', { body: fields || {} });
export const deleteText = (id) => request('DELETE', `/texts/${enc(id)}`);
/** postTextAttempt(id, {mode, answers?, plays_used?, seconds, correct?, total?}) */
export const postTextAttempt = (id, body) => request('POST', `/texts/${enc(id)}/attempts`, { body: body || {} });
export const generateText = (body) => request('POST', '/ai/generate-text', { body: body || {}, timeoutMs: 120000 });
/** analyzeText(textId) | ({text_id}) */
export function analyzeText(a) {
  const body = a && typeof a === 'object' ? { ...a } : { text_id: a };
  return request('POST', '/ai/analyze-text', { body, timeoutMs: 120000 });
}

// --- словарь и добавление карточек ---
/** lookupWord(word, context?) | ({word, context?}) */
export function lookupWord(a, context) {
  const body = a && typeof a === 'object' ? { ...a } : { word: a, ...(context ? { context } : {}) };
  return request('POST', '/lookup', { body, timeoutMs: 60000 });
}
export const cardFromLookup = (body) => request('POST', '/cards/from-lookup', { body: body || {} });
/** cardsBulk(items) | ({items}) */
export const cardsBulk = (arg) => request('POST', '/cards/bulk', { body: Array.isArray(arg) ? { items: arg } : (arg || {}) });
/** cardsFromErrors(items) | ({items}) */
export const cardsFromErrors = (arg) => request('POST', '/cards/from-errors', { body: Array.isArray(arg) ? { items: arg } : (arg || {}) });

// --- переводы и пересказ ---
export const translateSet = (body) => request('POST', '/translate/set', { body: body || {}, timeoutMs: 90000 });
/** translateSetCheck(id, answers, seconds?, provider?) */
export function translateSetCheck(id, answers, seconds, provider) {
  const headers = Number.isFinite(Number(seconds)) && seconds !== null && seconds !== undefined
    ? { 'X-Seconds': String(Math.max(0, Math.round(Number(seconds)))) }
    : undefined;
  return request('POST', `/translate/set/${enc(id)}/check`, {
    body: {
      answers: Array.isArray(answers) ? answers : [],
      ...(provider && provider !== 'auto' ? { provider } : {}),
    },
    headers,
    timeoutMs: 180000,
  });
}
export const translateSets = (limit = 20) => request('GET', '/translate/sets', { query: { limit } });
export const translateSetGet = (id) => request('GET', `/translate/sets/${enc(id)}`);
/** checkBatch({kind:'basket', items}) */
export const checkBatch = (body) => request('POST', '/ai/check-batch', { body: body || {}, timeoutMs: 120000 });
export const retellTask = (body) => request('POST', '/retell/task', { body: body || {}, timeoutMs: 90000 });
export const retellEvaluate = (body) => request('POST', '/retell/evaluate', { body: body || {}, timeoutMs: 120000 });

// --- говорение и письмо ---
/** speakingTranscribe(blob, durationS): сырое аудио в теле запроса */
export function speakingTranscribe(blob, durationS) {
  const type = String((blob && blob.type) || 'audio/webm').split(';')[0] || 'audio/webm';
  return request('POST', '/speaking/transcribe', {
    raw: blob,
    headers: { 'Content-Type': type, 'X-Duration-S': String(Math.max(0, Math.round(Number(durationS) || 0))) },
    timeoutMs: 90000,
  });
}
export const speakingPrompt = (body) => request('POST', '/speaking/prompt', { body: body || {}, timeoutMs: 90000 });
export const speakingEvaluate = (body) => request('POST', '/speaking/evaluate', { body: body || {}, timeoutMs: 120000 });
export function speakingEvaluateAudio(blob, { durationS = 0, prompt = '', targetCardIds = [] } = {}) {
  const type = String((blob && blob.type) || 'audio/webm').split(';')[0] || 'audio/webm';
  return request('POST', '/speaking/evaluate-audio', {
    raw: blob,
    headers: {
      'Content-Type': type,
      'X-Duration-S': String(Math.max(0, Math.round(Number(durationS) || 0))),
      'X-Prompt': encodeURIComponent(String(prompt || '').slice(0, 1000)),
      'X-Target-Cards': Array.isArray(targetCardIds) ? targetCardIds.join(',') : '',
    },
    timeoutMs: 120000,
  });
}
export const discussionStart = (body) => request('POST', '/speaking/discussion/start', { body: body || {}, timeoutMs: 90000 });
export const discussionTurn = (id, body) => request('POST', `/speaking/discussion/${enc(id)}/turn`, { body: body || {}, timeoutMs: 90000 });
export const discussionFinish = (id, body) => request('POST', `/speaking/discussion/${enc(id)}/finish`, { body: body || {}, timeoutMs: 120000 });
export const generateTextGaps = (id, provider) => request('POST', `/texts/${enc(id)}/gaps`, { body: provider ? { provider } : {}, timeoutMs: 90000 });
export const writingTask = (body) => request('POST', '/writing/task', { body: body || {}, timeoutMs: 90000 });
export const writingEvaluate = (body) => request('POST', '/writing/evaluate', { body: body || {}, timeoutMs: 120000 });

// --- числа ---
/** numbersPostAttempts({items, seconds}) | (items, seconds) */
export function numbersPostAttempts(a, seconds) {
  const body = Array.isArray(a) ? { items: a, seconds: Math.round(Number(seconds) || 0) } : { ...(a || {}) };
  return request('POST', '/numbers/attempts', { body });
}
export const numbersStats = () => request('GET', '/numbers/stats');

// --- ИИ ---
export const getAiProviders = () => request('GET', '/ai/providers', { timeoutMs: 10000 });