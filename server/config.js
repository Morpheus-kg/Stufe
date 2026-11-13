// Конфигурация из переменных окружения (единая точка доступа)
import crypto from 'node:crypto';

// dotenv нужен только локально, в production его нет
if (process.env.NODE_ENV !== 'production') {
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
  } catch { /* нет dotenv — не страшно */ }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

/** Целое из env с границами; при мусоре — значение по умолчанию */
function int(name, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

function validTz(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const appPassword = env.APP_PASSWORD ?? '';
let sessionSecret = env.SESSION_SECRET ?? '';

if (isProd) {
  // В production без секретов не стартуем
  if (!appPassword) throw new Error('APP_PASSWORD не задан');
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET должен быть не короче 16 символов');
} else if (sessionSecret.length < 16) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET не задан: временный секрет, сессии сбросятся при перезапуске');
}

export const config = Object.freeze({
  port: int('PORT', 3000, 1, 65535),
  nodeEnv: env.NODE_ENV || 'development',
  isProd,
  tzName: validTz(env.TZ_NAME) ? env.TZ_NAME : 'Asia/Bishkek',
  dayRolloverHour: 4, // «сегодня» переключается в 04:00 по местному времени
  appPassword,
  sessionSecret,
  db: Object.freeze({
    host: env.MYSQLHOST || 'localhost',
    port: int('MYSQLPORT', 3306, 1, 65535),
    user: env.MYSQLUSER || 'root',
    password: env.MYSQLPASSWORD ?? '',
    database: env.MYSQLDATABASE || 'german_trainer',
  }),
  ai: Object.freeze({
    chain: (env.LLM_CHAIN || 'gemini,groq,openrouter').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    capCorrect: int('AI_DAILY_CAP_CORRECT', 200),
    capGenerate: int('AI_DAILY_CAP_GENERATE', 40),
    capEnrich: int('AI_DAILY_CAP_ENRICH', 100),
  }),
});