// Время: всё хранится в UTC, «учебный день» считается по таймзоне пользователя (settings.timezone) или TZ_NAME со сдвигом 04:00
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

/** Таймзона текущего запроса (заполняется middleware attachTz); вне запроса — config.tzName */
export const tzStore = new AsyncLocalStorage();

const SQL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;

/** Проверка валидности IANA-таймзоны */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map();
function getDayFormatter(tz) {
  const effectiveTz = tz && isValidTimezone(tz) ? tz.trim() : config.tzName;
  let fmt = fmtCache.get(effectiveTz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTz, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    fmtCache.set(effectiveTz, fmt);
  }
  return fmt;
}

/** Date | ISO | 'YYYY-MM-DD HH:MM:SS' (UTC) | ms -> Date. Мусор -> RangeError */
export function toDate(v) {
  let d;
  if (v instanceof Date) d = new Date(v.getTime());
  else if (typeof v === 'number') d = new Date(v);
  else if (typeof v === 'string') {
    const s = v.trim();
    const m = SQL_RE.exec(s);
    d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(s);
  } else d = new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new RangeError('Некорректная дата');
  return d;
}

/**
 * Учебный день 'YYYY-MM-DD' (переключение в 04:00 местного времени пользователя).
 * @param {Date|string|number} dateOrIso
 * @param {string} [tzName] персональная таймзона пользователя (фолбэк на config.tzName)
 */
export function localDay(dateOrIso, tzName) {
  const shifted = new Date(toDate(dateOrIso).getTime() - config.dayRolloverHour * 3600 * 1000);
  const fmt = getDayFormatter(tzName ?? tzStore.getStore());
  const p = Object.fromEntries(fmt.formatToParts(shifted).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Кэш персональной таймзоны пользователя (TTL 60 с)
const userTzCache = new Map();
const TZ_TTL_MS = 60_000;

export function clearUserTzCache(userId) {
  if (userId !== undefined) userTzCache.delete(userId);
  else userTzCache.clear();
}

export async function getUserTz(userId, db) {
  if (!userId) return config.tzName;
  const hit = userTzCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.tz;
  let tz = config.tzName;
  try {
    const q = db?.query
      ? async (sql, params) => (await db.query(sql, params))[0]
      : (await import('./db.js')).query;
    const rows = await q(
      "SELECT value FROM settings WHERE user_id = ? AND key_name = 'timezone' LIMIT 1",
      [userId],
    );
    const val = rows?.[0]?.value;
    if (val && isValidTimezone(val)) tz = val.trim();
  } catch {
    tz = config.tzName;
  }
  userTzCache.set(userId, { tz, exp: Date.now() + TZ_TTL_MS });
  return tz;
}

export async function localDayForUser(dateOrIso, userId, db) {
  const tz = await getUserTz(userId, db);
  return localDay(dateOrIso, tz);
}

/** Date | ISO -> 'YYYY-MM-DD HH:MM:SS' (UTC) для DATETIME */
export function toSql(date) {
  return toDate(date).toISOString().slice(0, 19).replace('T', ' ');
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC) -> ISO-8601; пусто -> null */
export function toIso(sqlString) {
  if (sqlString === null || sqlString === undefined || sqlString === '') return null;
  return toDate(sqlString).toISOString();
}

/** Текущий момент (Date, UTC) */
export function nowUtc() {
  return new Date();
}
