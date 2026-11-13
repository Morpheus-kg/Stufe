// Настройки приложения: значения по умолчанию + хранение в таблице settings (user_id, key_name)
import { z } from 'zod';
import { query } from './db.js';
import { isValidTimezone, clearUserTzCache } from './time.js';

export const DEFAULTS = Object.freeze({
  new_per_day: 10,
  max_reviews_per_day: 150,
  max_session_items: 40,
  request_retention: 0.9,
  tts_rate: 0.9,
  tts_voice: '',
  theme: 'auto',
  daily_goal_minutes: 15,
  ai_enabled: true,
  // --- v2 (раздел 1.1) ---
  difficulty: 'medium',
  learn_auto_seconds: 6, // 0 = вручную
  auto_next_ms: 900, // 0 = вручную
  ai_provider_generate: 'auto',
  stt_engine: 'browser',
  listening_plays: 2,
  plan_minutes: 20,
  weight_hoeren: 35,
  weight_sprechen: 25,
  weight_lesen: 25,
  weight_schreiben: 5,
  weight_vocab: 10,
  exam_date: '',
  numbers_level: 2,
  timezone: '',
});

/** 'YYYY-MM-DD' — существующая календарная дата */
function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const weight = () => z.number().int().min(0).max(100);

export const FIELD_SCHEMAS = {
  new_per_day: z.number().int().min(0).max(200),
  max_reviews_per_day: z.number().int().min(0).max(1000),
  max_session_items: z.number().int().min(1).max(200),
  request_retention: z.number().min(0.7).max(0.99),
  tts_rate: z.number().min(0.5).max(2),
  tts_voice: z.string().max(200),
  theme: z.enum(['auto', 'light', 'dark']),
  daily_goal_minutes: z.number().int().min(1).max(600),
  ai_enabled: z.boolean(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  learn_auto_seconds: z.number().int().min(0).max(30),
  auto_next_ms: z.number().int().min(0).max(5000),
  ai_provider_generate: z.enum([
    'auto', 'groq', 'gemini', 'openrouter',
    'gemini:strong', 'gemini:fast', 'groq:strong', 'groq:fast', 'openrouter:strong', 'openrouter:fast',
  ]),
  stt_engine: z.enum(['browser', 'whisper']),
  listening_plays: z.union([z.literal(1), z.literal(2)]),
  plan_minutes: z.number().int().min(5).max(120),
  weight_hoeren: weight(),
  weight_sprechen: weight(),
  weight_lesen: weight(),
  weight_schreiben: weight(),
  weight_vocab: weight(),
  exam_date: z.string().refine((v) => v === '' || isRealDate(v)),
  numbers_level: z.number().int().min(1).max(4),
  timezone: z.string().max(64).refine((v) => v === '' || isValidTimezone(v)),
};

/** Частичное обновление: неизвестные ключи отбрасываются */
export const settingsPatchSchema = z.object(FIELD_SCHEMAS).partial();

/** Строка из БД -> типизированное значение (мусор -> значение по умолчанию) */
function parseStored(key, text) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return text === 'true' || text === '1';
  const value = typeof def === 'number' ? Number(text) : String(text);
  const r = FIELD_SCHEMAS[key].safeParse(value);
  return r.success ? r.data : def;
}

/**
 * Все настройки с применёнными значениями по умолчанию.
 * @param {{query: Function}} [db] соединение mysql2 (по умолчанию пул)
 * @param {number} [userId] идентификатор пользователя
 */
export async function getSettings(db, userId) {
  const out = { ...DEFAULTS };
  let rows = [];
  try {
    const run = db
      ? (sql, p) => db.query(sql, p).then(([r]) => r)
      : (sql, p) => query(sql, p);
    if (userId) {
      rows = await run(
        'SELECT key_name, value FROM settings WHERE user_id = ?',
        [userId],
      );
    } else if (db) {
      rows = await run('SELECT key_name, value FROM settings /* scope-ok: unit test mock fallback */', []);
    } else {
      return out;
    }
  } catch (err) {
    if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  for (const r of rows) {
    if (Object.hasOwn(DEFAULTS, r.key_name)) out[r.key_name] = parseStored(r.key_name, r.value);
  }
  return out;
}

/**
 * Сохраняет проверенный patch для userId.
 * db — соединение mysql2 (по умолчанию пул)
 */
export async function saveSettings(patch, db, userId) {
  const run = db ? (sql, p) => db.query(sql, p) : (sql, p) => query(sql, p);
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key) || value === undefined) continue;
    if (userId) {
      await run(
        'INSERT INTO settings (user_id, key_name, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [userId, key, String(value)],
      );
    } else if (db) {
      await run(
        'INSERT INTO settings (key_name, value) VALUES (?, ?) /* scope-ok: unit test mock fallback */ ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [key, String(value)],
      );
    }
    if (key === 'timezone') clearUserTzCache(userId);
  }
}

const WEIGHT_KEYS = ['hoeren', 'sprechen', 'lesen', 'schreiben', 'vocab'];

/**
 * Веса навыков, нормализованные до суммы 1 (для плана дня).
 * Все нули -> значения по умолчанию.
 */
export function getSkillWeights(settings = DEFAULTS) {
  let raw = WEIGHT_KEYS.map((k) => Number(settings?.[`weight_${k}`]));
  if (raw.some((v) => !Number.isFinite(v) || v < 0) || raw.every((v) => v === 0)) {
    raw = WEIGHT_KEYS.map((k) => DEFAULTS[`weight_${k}`]);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(WEIGHT_KEYS.map((k, i) => [k, raw[i] / sum]));
}
