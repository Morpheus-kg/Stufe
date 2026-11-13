// Журнал активностей (CONTRACT v2, раздел 2) и общие хелперы M7 с изоляцией по user_id
import { pool } from './db.js';
import { localDay, nowUtc } from './time.js';

export const ACTIVITY_KINDS = [
  'reading', 'listening', 'dictation_text', 'numbers',
  'translation', 'speaking', 'writing', 'lookup',
];

// Навыки плана: vocab = карточки (в activities их нет)
export const SKILLS = ['hoeren', 'lesen', 'sprechen', 'schreiben', 'vocab'];

// Соответствие вида активности навыку (lookup не относится ни к одному)
export const KIND_TO_SKILL = Object.freeze({
  reading: 'lesen',
  listening: 'hoeren',
  dictation_text: 'hoeren',
  numbers: 'hoeren',
  speaking: 'sprechen',
  writing: 'schreiben',
  translation: 'schreiben',
});

export function skillOfKind(kind) {
  return Object.hasOwn(KIND_TO_SKILL, kind) ? KIND_TO_SKILL[kind] : null;
}

/** Округлённое целое в диапазоне; мусор -> fallback */
export function clampInt(v, min, max, fallback = min) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Безопасный JSON.parse (LONGTEXT из БД бывает битым) */
export function safeJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try {
    const v = JSON.parse(text);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Значение DATE из БД -> 'YYYY-MM-DD' (или null) */
export function dayStr(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

/** Строка 'YYYY-MM-DD' — существующая календарная дата */
export function isValidDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Сдвиг даты 'YYYY-MM-DD' на delta дней */
export function shiftDay(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/**
 * Записывает активность. db — соединение из tx() или пул (по умолчанию пул).
 * @param {object} input {kind, refId, seconds, score, userId}
 * @param {object} [db]
 * @param {number} [explicitUserId]
 * @returns {Promise<number|null>} id строки или null
 */
export async function logActivity(input, db, explicitUserId) {
  try {
    const { kind, refId = null, seconds = 0, score = null } = input ?? {};
    const userId = explicitUserId ?? input?.userId;
    if (!userId || !ACTIVITY_KINDS.includes(kind)) return null;
    const ref = Number.isInteger(refId) && refId > 0 ? refId : null;
    const secs = clampInt(seconds, 0, 86400, 0);
    const sc = score === null || score === undefined || score === ''
      ? null
      : clampInt(score, 0, 100, 0);
    const [res] = await (db ?? pool).query(
      'INSERT INTO activities (user_id, kind, ref_id, seconds, score, local_day) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, kind, ref, secs, sc, localDay(nowUtc())],
    );
    return res?.insertId ?? null;
  } catch (e) {
    console.error('logActivity: не удалось записать', e?.code ?? e?.name ?? 'error');
    return null;
  }
}
