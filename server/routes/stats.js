// Статистика для экрана «Статистика»: GET /api/stats/summary с изоляцией по user_id
import { Router } from 'express';
import { query } from '../db.js';
import { localDay, nowUtc } from '../time.js';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { MODES, ERROR_CATEGORIES } from '../../shared/constants.js';

export const mountPath = '/api/stats';

const router = Router();

const WINDOW_DAYS = 30;        // окно для графика, удержания, точности
const MATURE_STABILITY = 21;   // дней: порог «выученной» карточки
const STREAK_SCAN_DAYS = 5000; // сколько последних дней с ответами читаем для серии
const SENTENCES_SCAN = 500;    // сколько последних предложений разбираем по категориям ошибок
const WEAK_LIMIT = 10;

const CARD_FIELDS = [
  'id', 'term', 'article', 'plural', 'pos', 'translation', 'grammar', 'example',
  'example_translation', 'example_cloze', 'cloze_answer', 'level', 'topic', 'source',
];

// Безопасное число (mysql2 отдаёт SUM как строку/null)
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

// Доля с тремя знаками; null, если данных нет
const ratio = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 1000 : null);

// DATE -> 'YYYY-MM-DD' (dateStrings:true, но на всякий случай обрабатываем Date)
function dayStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

/** Сдвиг календарного дня 'YYYY-MM-DD' на delta дней (чистая арифметика в UTC). */
export function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Серия: подряд идущие дни с >=1 ответом; сегодня может быть ещё пустым. */
export function computeStreak(days, today) {
  let cursor = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// Строка БД -> Card JSON (без dedupe_key, булевы как true/false)
function toCard(row) {
  const card = {};
  for (const k of CARD_FIELDS) card[k] = row[k] ?? null;
  card.id = num(row.id);
  card.check_flag = !!row.check_flag;
  card.enriched = !!row.enriched;
  card.active = !!row.active;
  return card;
}

// errors хранится как LONGTEXT с JSON: парсим всегда в try/catch
function parseErrors(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

router.get('/summary', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const today = localDay(nowUtc());
  const from = addDays(today, -(WINDOW_DAYS - 1));

  const [
    dayRows, retRows, modeRows, streakRows, todayStatRows, extRows,
    levelRows, topicRows, stateRows, weakRows, sentRows,
  ] = await Promise.all([
    // ответы по дням (из review_log — единый источник с графиком)
    query(
      `SELECT local_day AS day, COUNT(*) AS reviews, SUM(correct) AS correct
         FROM review_log WHERE user_id = ? AND local_day BETWEEN ? AND ? GROUP BY local_day`,
      [userId, from, today],
    ),
    // удержание: только повторные показы (у пары карточка+режим уже был ответ раньше)
    query(
      `SELECT COUNT(*) AS total, SUM(r.correct) AS correct
         FROM review_log r
        WHERE r.user_id = ? AND r.local_day BETWEEN ? AND ?
          AND EXISTS (SELECT 1 FROM review_log p
                       WHERE p.user_id = ? AND p.card_id = r.card_id AND p.mode = r.mode AND p.id < r.id)`,
      [userId, from, today, userId],
    ),
    query(
      `SELECT mode, COUNT(*) AS total, SUM(correct) AS correct
         FROM review_log WHERE user_id = ? AND local_day BETWEEN ? AND ? GROUP BY mode`,
      [userId, from, today],
    ),
    query(
      `SELECT DISTINCT local_day AS day FROM review_log
        WHERE user_id = ?
        ORDER BY local_day DESC LIMIT ${STREAK_SCAN_DAYS}`,
      [userId],
    ),
    query('SELECT new_cards, active_seconds FROM daily_stats WHERE user_id = ? AND day = ?', [userId, today]),
    query(
      `SELECT COALESCE(SUM(ext_audio_min), 0) AS audio,
              COALESCE(SUM(ext_speaking_min), 0) AS speaking,
              COALESCE(SUM(ext_reading_min), 0) AS reading
         FROM daily_stats WHERE user_id = ? AND day BETWEEN ? AND ?`,
      [userId, from, today],
    ),
    query('SELECT level, COUNT(*) AS n FROM cards WHERE user_id = ? AND active = 1 GROUP BY level', [userId]),
    query('SELECT topic, COUNT(*) AS n FROM cards WHERE user_id = ? AND active = 1 GROUP BY topic', [userId]),
    // разбивка активных карточек: новые / в изучении / выученные
    query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.card_id IS NULL OR s.total_reps = 0 THEN 1 ELSE 0 END) AS new_cnt,
              SUM(CASE WHEN s.total_reps > 0 AND s.max_stab >= ? THEN 1 ELSE 0 END) AS mature_cnt,
              SUM(CASE WHEN s.total_reps > 0 AND s.max_stab < ? THEN 1 ELSE 0 END) AS learning_cnt,
              SUM(c.check_flag) AS flagged,
              SUM(CASE WHEN c.enriched = 0 THEN 1 ELSE 0 END) AS pending
         FROM cards c
         LEFT JOIN (SELECT card_id, MAX(stability) AS max_stab, SUM(reps) AS total_reps
                      FROM card_state WHERE user_id = ? GROUP BY card_id) s ON s.card_id = c.id
        WHERE c.user_id = ? AND c.active = 1`,
      [MATURE_STABILITY, MATURE_STABILITY, userId, userId],
    ),
    query(
      `SELECT c.*, w.lapses
         FROM (SELECT card_id, SUM(lapses) AS lapses FROM card_state
                WHERE user_id = ?
                GROUP BY card_id HAVING SUM(lapses) > 0) w
         JOIN cards c ON c.id = w.card_id AND c.user_id = ?
        WHERE c.user_id = ? AND c.active = 1
        ORDER BY w.lapses DESC, c.id ASC LIMIT ${WEAK_LIMIT}`,
      [userId, userId, userId],
    ),
    query(`SELECT errors FROM sentences WHERE user_id = ? ORDER BY id DESC LIMIT ${SENTENCES_SCAN}`, [userId]),
  ]);

  // График за 30 дней: заполняем пропущенные дни нулями
  const byDay = new Map(dayRows.map((r) => [dayStr(r.day), r]));
  const last30 = [];
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const day = addDays(from, i);
    const r = byDay.get(day);
    last30.push({ day, reviews: num(r?.reviews), correct: num(r?.correct) });
  }
  const todayRow = byDay.get(today);
  const todayStat = todayStatRows[0] || {};

  const ret = retRows[0] || {};

  const modeMap = new Map(modeRows.map((r) => [r.mode, r]));
  const accuracyByMode = {};
  for (const m of MODES) {
    const r = modeMap.get(m);
    accuracyByMode[m] = r ? ratio(num(r.correct), num(r.total)) : null;
  }

  const streakDays = new Set(streakRows.map((r) => dayStr(r.day)));

  const st = stateRows[0] || {};
  const ext = extRows[0] || {};

  // Категории ошибок из проверенных предложений
  const errorCategories = {};
  for (const row of sentRows) {
    for (const e of parseErrors(row.errors)) {
      if (!e || typeof e !== 'object' || typeof e.category !== 'string') continue;
      const cat = ERROR_CATEGORIES.includes(e.category) ? e.category : 'sonstiges';
      errorCategories[cat] = (errorCategories[cat] || 0) + 1;
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    streak_days: computeStreak(streakDays, today),
    today: {
      reviews: num(todayRow?.reviews),
      correct: num(todayRow?.correct),
      new_cards: num(todayStat.new_cards),
      active_seconds: num(todayStat.active_seconds),
    },
    last_30_days: last30,
    retention_30d: ratio(num(ret.correct), num(ret.total)),
    cards: {
      total: num(st.total),
      by_level: Object.fromEntries(levelRows.map((r) => [String(r.level), num(r.n)])),
      by_topic: Object.fromEntries(topicRows.map((r) => [String(r.topic), num(r.n)])),
      new: num(st.new_cnt),
      learning: num(st.learning_cnt),
      mature: num(st.mature_cnt),
      flagged_check: num(st.flagged),
      pending_enrich: num(st.pending),
    },
    accuracy_by_mode: accuracyByMode,
    weak_cards: weakRows.map((r) => ({ card: toCard(r), lapses: num(r.lapses) })),
    error_categories: errorCategories,
    external_minutes_30d: {
      audio: num(ext.audio),
      speaking: num(ext.speaking),
      reading: num(ext.reading),
    },
  });
}));

export default router;
