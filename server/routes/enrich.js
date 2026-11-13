// Маршруты обогащения карточек с изоляцией по user_id
import { Router } from 'express';
import { ApiError, asyncHandler } from '../errors.js';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { enrichCards } from '../ai/enrich.js';
import { isAiAvailable } from '../ai/llm.js';
import { enrichRunSchema, parseOrThrow } from '../ai/schemas.js';

export const mountPath = '/api/enrich';
const router = Router();
export default router;

// R6: блокировка обогащения на пользователя
const runningUsers = new Set();

async function countPending(userId) {
  const rows = await query('SELECT COUNT(*) AS n FROM cards WHERE user_id=? AND enriched=0 AND active=1', [userId]);
  return Number(rows?.[0]?.n) || 0;
}

router.post(
  '/run',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = parseOrThrow(enrichRunSchema, req.body);
    if (runningUsers.has(userId)) throw new ApiError(409, 'CONFLICT', 'Обогащение уже выполняется.');
    runningUsers.add(userId);
    try {
      const { processed, flagged } = await enrichCards(body.limit ?? 25, userId);
      res.json({ processed, flagged, remaining: await countPending(userId) });
    } finally {
      runningUsers.delete(userId);
    }
  }),
);

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const flaggedRows = await query('SELECT COUNT(*) AS n FROM cards WHERE user_id=? AND check_flag=1 AND active=1', [userId]);
    res.json({
      pending: await countPending(userId),
      flagged: Number(flaggedRows?.[0]?.n) || 0,
      ai_available: await isAiAvailable(userId),
    });
  }),
);
