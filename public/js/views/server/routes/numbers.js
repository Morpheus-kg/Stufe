// Тренажёр чисел: сохранение попыток и статистика с изоляцией по user_id. ИИ не используется.
import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { ApiError, asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc } from '../time.js';
import { logActivity } from '../activities.js';
import { CATEGORIES } from '../../shared/numbers_de.js';

export const mountPath = '/api/numbers';
const router = Router();

const itemSchema = z.object({
  category: z.enum(CATEGORIES),
  level: z.number().int().min(1).max(4),
  expected: z.string().min(1).max(60),
  answer: z.string().max(60),
  correct: z.boolean(),
  response_ms: z.number().int().min(0).max(3600000).nullish(),
  plays: z.number().int().min(1).max(50).nullish(),
  pattern: z.string().max(30).nullish(),
});

const attemptsSchema = z.object({
  items: z.array(itemSchema).min(1).max(50),
  seconds: z.number().int().min(0).max(86400),
});

// Попытки пачкой, одной транзакцией
router.post('/attempts', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const parsed = attemptsSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'BAD_REQUEST', 'Неверные данные попыток.');
  const { items, seconds } = parsed.data;
  const day = localDay(nowUtc());
  const rows = items.map((it) => [
    userId, it.category, it.level, it.expected, it.answer, it.correct ? 1 : 0,
    it.pattern ?? null, it.response_ms ?? null, it.plays ?? 1, day,
  ]);
  const saved = await tx(async (conn) => {
    const [r] = await conn.query(
      'INSERT INTO number_attempts (user_id, category, level, expected, answer, correct, pattern, response_ms, plays, local_day) VALUES ?',
      [rows],
    );
    return r.affectedRows;
  });
  const correct = items.filter((i) => i.correct).length;
  try {
    await logActivity({
      kind: 'numbers', refId: null, seconds,
      score: Math.round((100 * correct) / items.length),
      userId,
    });
  } catch (e) {
    console.error('numbers: logActivity failed:', e && e.code ? e.code : 'error');
  }
  res.json({ saved, correct, total: items.length });
}));

// Статистика за 30 дней
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const since = localDay(new Date(nowUtc().getTime() - 29 * 86400000));

  const catRows = await query(
    'SELECT category, COUNT(*) AS n, AVG(correct) AS acc, AVG(response_ms) AS avg_ms ' +
    'FROM number_attempts WHERE user_id = ? AND local_day >= ? GROUP BY category',
    [userId, since],
  );
  const by_category = {};
  for (const c of CATEGORIES) by_category[c] = { n: 0, accuracy_30d: null, avg_ms: null };
  for (const r of catRows) {
    if (!by_category[r.category]) continue;
    by_category[r.category] = {
      n: Number(r.n),
      accuracy_30d: r.acc === null ? null : Number(Number(r.acc).toFixed(3)),
      avg_ms: r.avg_ms === null ? null : Math.round(Number(r.avg_ms)),
    };
  }

  const patRows = await query(
    'SELECT pattern, COUNT(*) AS cnt FROM number_attempts ' +
    'WHERE user_id = ? AND local_day >= ? AND correct = 0 AND pattern IS NOT NULL GROUP BY pattern ORDER BY cnt DESC LIMIT 20',
    [userId, since],
  );
  const patterns = patRows.map((r) => ({ pattern: String(r.pattern), count: Number(r.cnt) }));

  const recRows = await query(
    'SELECT local_day AS day, COUNT(*) AS n, AVG(correct) AS acc FROM number_attempts ' +
    'WHERE user_id = ? AND local_day >= ? GROUP BY local_day ORDER BY local_day DESC LIMIT 14',
    [userId, since],
  );
  const recent = recRows.reverse().map((r) => ({
    day: String(r.day).slice(0, 10),
    n: Number(r.n),
    accuracy: Number(Number(r.acc).toFixed(3)),
  }));

  res.json({ by_category, patterns, recent });
}));

export default router;
