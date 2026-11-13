// Клиент API: по одной функции на endpoint. Возвращает JSON или бросает ApiError.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP-статус (0 = нет сети)
   * @param {string} code код ошибки из контракта
   * @param {string} message текст на русском
   * @param {object} [extra] тело ошибки (например, existing_id)
   */
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = extra || null;
    if (extra && extra.existing_id !== undefined) this.existing_id = extra.existing_id;
  }
}

function redirectToLogin() {
  if (location.hash !== '#/login') location.hash = '#/login';
}

async function request(method, path, opts = {}) {
  const { body, query, headers, timeoutMs = 30000 } = opts;
  let url = '/api' + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
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
    // Неверный пароль на /auth/login — не «разлогин»
    if (res.status === 401 && !path.startsWith('/auth/login')) redirectToLogin();
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

// --- auth ---
export const login = (username, password) => {
  if (typeof username === 'object' && username !== null) {
    return request('POST', '/auth/login', { body: username });
  }
  if (password !== undefined) {
    return request('POST', '/auth/login', { body: { username, password } });
  }
  return request('POST', '/auth/login', { body: { password: username } });
};
export const logout = () => request('POST', '/auth/logout');
export const me = () => request('GET', '/auth/me', { timeoutMs: 8000 });

// --- сессия и повторения ---
export const getToday = () => request('GET', '/session/today');

/** postReviews({reviews, active_seconds?}) или postReviews(reviewsArray, activeSeconds?) */
export function postReviews(arg, activeSeconds) {
  const body = Array.isArray(arg) ? { reviews: arg } : { ...(arg || {}) };
  if (Array.isArray(arg) && Number.isFinite(activeSeconds)) body.active_seconds = Math.round(activeSeconds);
  return request('POST', '/reviews', { body });
}

// --- ИИ ---
/** correctSentence({card_id?, text}) | (text, cardId?) | (cardId, text) */
export function correctSentence(a, b) {
  let body;
  if (a && typeof a === 'object') body = { ...a };
  else if (typeof a === 'number') body = { card_id: a, text: b };
  else body = { text: a, ...(b !== undefined && b !== null ? { card_id: b } : {}) };
  return request('POST', '/ai/correct-sentence', { body, timeoutMs: 90000 });
}

/** generateWords({topic, count?, pos_mix?}) | (topic, count?, posMix?) */
export function generateWords(a, count, posMix) {
  const body = a && typeof a === 'object' ? { ...a } : { topic: a, ...(count ? { count } : {}), ...(posMix ? { pos_mix: posMix } : {}) };
  return request('POST', '/ai/generate-words', { body, timeoutMs: 120000 });
}

export const enrichRun = (limit) => request('POST', '/enrich/run', { body: limit ? { limit } : {}, timeoutMs: 120000 });
export const enrichStatus = () => request('GET', '/enrich/status');
export const getAiUsage = () => request('GET', '/ai/usage');

// --- статистика и настройки ---
export const getStats = () => request('GET', '/stats/summary');
export const getSettings = () => request('GET', '/settings', { timeoutMs: 10000 });
export const putSettings = (partial) => request('PUT', '/settings', { body: partial || {} });

// --- импорт / экспорт ---
/** importCards({filename?, cards}) или importCards(cardsArray) */
export function importCards(arg) {
  const body = Array.isArray(arg) ? { cards: arg } : arg;
  return request('POST', '/import', { body, timeoutMs: 120000 });
}
export const exportAll = () => request('GET', '/export', { timeoutMs: 120000 });
export const exportDeck = (progress = true) =>
  request('GET', '/export/deck', { query: { progress: progress ? '1' : '0' }, timeoutMs: 120000 });
/** restoreAll(data) — безопасное восстановление слиянием (mode='merge') */
export function restoreAll(data) {
  return request('POST', '/export/restore', {
    body: data,
    query: { mode: 'merge' },
    timeoutMs: 120000,
  });
}

// --- карточки ---
export function getCards(params = {}) {
  const { query, topic, pos, status, check, limit = 50, offset = 0 } = params;
  return request('GET', '/cards', { query: { query, topic, pos, status, check: check ? 1 : '', limit, offset } });
}
export const patchCard = (id, fields) => request('PATCH', `/cards/${encodeURIComponent(id)}`, { body: fields || {} });
export const deleteCard = (id) => request('DELETE', `/cards/${encodeURIComponent(id)}`);
export const createCard = (fields) => request('POST', '/cards', { body: fields || {} });
export const setCardLearned = (id, learned = true) =>
  request('POST', `/cards/${encodeURIComponent(id)}/learned`, { body: { learned: !!learned } });

// --- внешняя практика ---
/** logExternal({kind, minutes}) | (kind, minutes) */
export function logExternal(a, minutes) {
  const body = a && typeof a === 'object' ? { ...a } : { kind: a, minutes };
  return request('POST', '/log/external', { body });
}