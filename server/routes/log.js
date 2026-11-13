// /api/log: учёт внешней практики (аудио, речь, чтение) с изоляцией по user_id
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc } from '../time.js';

export const mountPath = '/api/log';
const router = Router();
export default router;

const COLUMN = { audio: 'ext_audio_min', speaking: 'ext_speaking_min', reading: 'ext_reading_min' };

const bodySchema = z.object({
  kind: z.enum(['audio', 'speaking', 'reading']),
  minutes: z.number().int().min(1).max(600),
});

router.post('/external', requireAuth, asyncHandler(async (req, res) => {
  const { kind, minutes } = validate(bodySchema, req.body, 'Некорректные данные');
  const col = COLUMN[kind];
  await query(
    `INSERT INTO daily_stats (user_id, day, ${col}) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE ${col} = ${col} + VALUES(${col})`,
    [req.user.id, localDay(nowUtc()), minutes],
  );
  res.json({ ok: true });
}));
