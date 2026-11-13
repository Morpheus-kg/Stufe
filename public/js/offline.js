// Офлайн-очередь ответов (IndexedDB) и кэш сегодняшней сессии.
// Работает и без IndexedDB (приватный режим): тогда очередь живёт в памяти.
import { postReviews } from './api.js';
import { MODES } from '/shared/constants.js';

const DB_NAME = 'german_trainer';
const DB_VERSION = 1;
const PENDING = 'pending_reviews';
const SESSION = 'session_cache';
const SESSION_KEY = 'today';

const BATCH_SIZE = 50;
const MAX_ACTIVE_MS_PER_REVIEW = 120000; // «активное время» одного ответа не больше 2 минут
const MAX_ACTIVE_SECONDS = 3600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const memPending = new Map(); // запасное хранилище, если IndexedDB недоступна
let memSession = null;
let dbPromise = null;

// ---------- IndexedDB ----------

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PENDING)) {
          db.createObjectStore(PENDING, { keyPath: 'client_uuid' });
        }
        if (!db.objectStoreNames.contains(SESSION)) {
          db.createObjectStore(SESSION, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

// Выполняет один запрос в транзакции; результат — после complete
async function run(storeName, mode, makeRequest) {
  const db = await openDb();
  if (!db) throw new Error('idb-unavailable');
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, mode);
      const req = makeRequest(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb-abort'));
    } catch (e) {
      reject(e);
    }
  });
}

async function putPending(review) {
  try {
    await run(PENDING, 'readwrite', (s) => s.put(review));
  } catch {
    memPending.set(review.client_uuid, review);
  }
}

async function readPending() {
  const map = new Map();
  try {
    const rows = await run(PENDING, 'readonly', (s) => s.getAll());
    for (const r of rows || []) if (r && r.client_uuid) map.set(r.client_uuid, r);
  } catch { /* читаем только память */ }
  for (const [k, v] of memPending) map.set(k, v);
  return [...map.values()].sort((a, b) => Date.parse(a.answered_at) - Date.parse(b.answered_at));
}

async function removePending(uuids) {
  if (!uuids.length) return;
  for (const u of uuids) memPending.delete(u);
  try {
    await run(PENDING, 'readwrite', (s) => {
      for (const u of uuids) s.delete(u);
      return undefined;
    });
  } catch { /* не критично: повторная отправка идемпотентна */ }
}

// ---------- Подготовка записи ----------

function newUuid() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function toIso(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Оставляем только поля контракта, мусор отбрасываем; null, если запись непригодна
function cleanReview(r) {
  if (!r || typeof r !== 'object') return null;
  const cardId = Number(r.card_id);
  const rating = Number(r.rating);
  if (!Number.isInteger(cardId) || cardId < 1) return null;
  if (!MODES.includes(r.mode)) return null;
  if (![1, 2, 3, 4].includes(rating)) return null;

  const out = {
    client_uuid: typeof r.client_uuid === 'string' && UUID_RE.test(r.client_uuid) ? r.client_uuid : newUuid(),
    card_id: cardId,
    mode: r.mode,
    rating,
    correct: !!r.correct,
    answered_at: toIso(r.answered_at) || new Date().toISOString(),
  };
  const ms = Number(r.response_ms);
  if (r.response_ms != null && Number.isFinite(ms) && ms >= 0) out.response_ms = Math.min(Math.round(ms), 3600000);
  if (typeof r.user_answer === 'string') out.user_answer = r.user_answer.slice(0, 1000);
  const hints = Number(r.hints_used);
  if (r.hints_used != null && Number.isFinite(hints)) out.hints_used = Math.min(255, Math.max(0, Math.round(hints)));
  return out;
}

// ---------- Публичный API ----------

/** Кладёт ответ в очередь. Возвращает client_uuid или null, если запись некорректна. */
export async function enqueueReview(r) {
  const clean = cleanReview(r);
  if (!clean) return null;
  await putPending(clean);
  return clean.client_uuid;
}

/** Сколько ответов ждут отправки. */
export async function pendingCount() {
  return (await readPending()).length;
}

const isStr = (x) => typeof x === 'string';
const asList = (x) => (Array.isArray(x) ? x.filter(isStr) : []);
const isAuthError = (e) => !!e && (e.status === 401 || e.code === 'UNAUTHORIZED');
const isBadRequest = (e) => !!e && (e.status === 400 || e.code === 'BAD_REQUEST');

function buildBody(batch) {
  const ms = batch.reduce((sum, r) => sum + Math.min(r.response_ms || 0, MAX_ACTIVE_MS_PER_REVIEW), 0);
  const active = Math.min(MAX_ACTIVE_SECONDS, Math.round(ms / 1000));
  const body = { reviews: batch };
  if (active > 0) body.active_seconds = active;
  return body;
}

// Разбор ответа сервера: удаляем из очереди всё, что сервер принял/опознал
async function applyResponse(batch, res, totals) {
  const known = new Set(batch.map((r) => r.client_uuid));
  const applied = asList(res?.applied).filter((u) => known.has(u));
  const dups = asList(res?.duplicates).filter((u) => known.has(u));
  const rejected = Array.isArray(res?.rejected)
    ? res.rejected.map((x) => x?.client_uuid).filter((u) => isStr(u) && known.has(u))
    : [];
  const done = [...applied, ...dups, ...rejected];
  if (!done.length) return false; // непонятный ответ — оставляем в очереди
  await removePending(done);
  totals.sent += applied.length;
  totals.duplicates += dups.length;
  totals.rejected += rejected.length;
  return done.length === batch.length;
}

// Пакет отклонён целиком (400) — шлём по одному, битые записи выбрасываем
async function sendOneByOne(batch, totals) {
  for (const r of batch) {
    try {
      const res = await postReviews(buildBody([r]));
      if (!(await applyResponse([r], res, totals))) return false;
    } catch (e) {
      if (isBadRequest(e)) {
        await removePending([r.client_uuid]);
        totals.dropped += 1;
      } else {
        return false;
      }
    }
  }
  return true;
}

async function sendBatch(batch, totals) {
  try {
    const res = await postReviews(buildBody(batch));
    return await applyResponse(batch, res, totals);
  } catch (e) {
    if (isAuthError(e)) return false;
    if (isBadRequest(e)) return sendOneByOne(batch, totals);
    return false; // сеть, 5xx, лимиты: попробуем позже
  }
}

async function flushOnce(totals) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    totals.offline = true;
    return false;
  }
  const rows = await readPending();
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    if (!(await sendBatch(rows.slice(i, i + BATCH_SIZE), totals))) return false;
  }
  return true;
}

let flushPromise = null;
let flushAgain = false;

/**
 * Отправляет накопленные ответы. Никогда не бросает исключений.
 * Параллельные вызовы сливаются в один; если во время отправки пришёл новый ответ — делаем ещё проход.
 * Возвращает {sent, duplicates, rejected, dropped, pending, offline}.
 */
export function flush() {
  if (flushPromise) {
    flushAgain = true;
    return flushPromise;
  }
  flushPromise = (async () => {
    const totals = { sent: 0, duplicates: 0, rejected: 0, dropped: 0, pending: 0, offline: false };
    try {
      do {
        flushAgain = false;
        const ok = await flushOnce(totals);
        if (!ok) break;
      } while (flushAgain);
      totals.pending = await pendingCount();
    } catch { /* очередь остаётся как есть */ } finally {
      flushPromise = null;
    }
    return totals;
  })();
  return flushPromise;
}

/** Сохраняет сессию «на сегодня» для офлайн-режима. */
export async function cacheSession(s) {
  if (!s || typeof s !== 'object') return false;
  const record = { key: SESSION_KEY, session: s, cached_at: new Date().toISOString() };
  try {
    await run(SESSION, 'readwrite', (st) => st.put(record));
    memSession = null;
  } catch {
    memSession = record;
  }
  return true;
}

/** Возвращает последнюю сохранённую сессию или null. */
export async function loadSession() {
  try {
    const rec = await run(SESSION, 'readonly', (st) => st.get(SESSION_KEY));
    if (rec && rec.session) return rec.session;
  } catch { /* пробуем память */ }
  return memSession ? memSession.session : null;
}

// Автозапуск отправки: при старте, при появлении сети и при возврате на вкладку
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flush(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flush();
  });
  setTimeout(() => { flush(); }, 0);
}