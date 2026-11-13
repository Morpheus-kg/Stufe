// Журнал пробных экзаменов и обратный отсчёт (CONTRACT v2, 4.1) с изоляцией по user_id
import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { localDay, nowUtc } from '../time.js';
import { dayStr, isValidDay } from '../activities.js';

export const mountPath = '/api/exam';
const router = Router();

export const PASS_PCT = 60;
const EXAM_SKILLS = ['lesen', 'hoeren', 'schreiben', 'sprechen', 'gesamt'];

const round1 = (n) => Math.round(n * 10) / 10;
const idParam = z.coerce.number().int().positive().max(2147483647);

export const examBodySchema = z.object({
  taken_on: z.string().refine((d) => isValidDay(d) && d >= '2000-01-01' && d <= '2100-12-31'),
  skill: z.enum(EXAM_SKILLS),
  points: z.number().min(0).max(9999.9),
  max_points: z.number().gt(0).max(9999.9).default(100),
  source: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(255).nullish(),
}).refine((v) => v.points <= v.max_points, { path: ['points'] });

export function computeDaysLeft(examDate, today) {
  if (!isValidDay(examDate) || !isValidDay(today)) return null;
  const [y1, m1, d1] = examDate.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

export function toExamItem(row) {
  const points = Number(row.points);
  const max = Number(row.max_points);
  const ok = Number.isFinite(points) && Number.isFinite(max) && max > 0;
  return {
    id: row.id,
    taken_on: dayStr(row.taken_on),
    skill: row.skill,
    points: Number.isFinite(points) ? points : 0,
    max_points: Number.isFinite(max) ? max : 100,
    pct: ok ? round1((points / max) * 100) : 0,
    source: row.source ?? null,
    note: row.note ?? null,
  };
}

export function latestBySkill(items) {
  const best = {};
  for (const it of items) {
    const cur = best[it.skill];
    if (!cur || it.taken_on > cur.taken_on || (it.taken_on === cur.taken_on && it.id > cur.id)) {
      best[it.skill] = it;
    }
  }
  const out = {};
  for (const [skill, it] of Object.entries(best)) out[skill] = { pct: it.pct, taken_on: it.taken_on };
  return out;
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const settings = await getSettings(null, userId);
  const examDate = isValidDay(settings?.exam_date) ? settings.exam_date : '';
  const rows = await query('SELECT * FROM exam_log WHERE user_id = ? ORDER BY taken_on DESC, id DESC LIMIT 1000', [userId]);
  const items = rows.map(toExamItem).filter((it) => it.taken_on);
  res.json({
    exam_date: examDate,
    days_left: examDate ? computeDaysLeft(examDate, localDay(nowUtc())) : null,
    items,
    latest_by_skill: latestBySkill(items),
    pass_pct: PASS_PCT,
  });
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const b = validate(examBodySchema, req.body ?? {}, 'Неверные данные результата экзамена');
  const [ins] = await pool.query(
    `INSERT INTO exam_log (user_id, taken_on, skill, points, max_points, source, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, b.taken_on, b.skill, round1(b.points), round1(b.max_points), b.source || null, b.note || null],
  );
  const rows = await query('SELECT * FROM exam_log WHERE id = ? AND user_id = ?', [ins.insertId, userId]);
  if (!rows.length) throw new ApiError(500, 'INTERNAL', 'Не удалось сохранить результат');
  res.status(201).json(toExamItem(rows[0]));
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = validate(idParam, req.params.id, 'Неверный id записи');
  const [r] = await pool.query('DELETE FROM exam_log WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r?.affectedRows) throw new ApiError(404, 'NOT_FOUND', 'Запись не найдена');
  res.status(204).end();
}));

export default router;
