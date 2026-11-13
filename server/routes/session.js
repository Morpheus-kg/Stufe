// GET /api/session/today — очередь на сегодня, изолированная по user_id (A4)
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { localDay } from '../time.js';
import { buildQueue } from '../srs/queue.js';

export const mountPath = '/api/session';

const router = Router();

const CARD_COLS = 'id, term, article, plural, pos, translation, grammar, example, example_translation, '
  + 'example_cloze, cloze_answer, level, topic, source, check_flag, enriched, active';

const STATE_COLS = 'cs.card_id, cs.mode, cs.state, cs.due, cs.stability, cs.difficulty, cs.elapsed_days, cs.scheduled_days, '
  + 'cs.learning_steps, cs.reps, cs.lapses, cs.last_review';

function rowToCard(r) {
  return {
    id: r.id,
    term: r.term,
    article: r.article ?? null,
    plural: r.plural ?? null,
    pos: r.pos,
    translation: r.translation,
    grammar: r.grammar ?? null,
    example: r.example ?? null,
    example_translation: r.example_translation ?? null,
    example_cloze: r.example_cloze ?? null,
    cloze_answer: r.cloze_answer ?? null,
    level: r.level,
    topic: r.topic,
    source: r.source ?? null,
    check_flag: !!r.check_flag,
    enriched: !!r.enriched,
    active: !!r.active,
  };
}

router.get('/today', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const today = localDay(now);
  const settings = await getSettings(null, userId);

  const [cardRows, stateRows, introRows, lapsedRows, doneRows, ladderRows, passedTodayRows] = await Promise.all([
    query(`SELECT ${CARD_COLS} FROM cards WHERE user_id = ? AND active = 1`, [userId]),
    query(
      `SELECT ${STATE_COLS} FROM card_state cs JOIN cards c ON c.id = cs.card_id WHERE c.user_id = ?`,
      [userId],
    ),
    // введённые сегодня: первый review_log карточки пришёлся на сегодня
    query(
      'SELECT card_id FROM review_log WHERE user_id = ? GROUP BY card_id HAVING MIN(local_day) = ? ORDER BY MIN(answered_at) DESC',
      [userId, today],
    ),
    // «Again» сегодня, последние первыми
    query(
      'SELECT card_id FROM review_log WHERE user_id = ? AND local_day = ? AND rating = 1 '
      + 'GROUP BY card_id ORDER BY MAX(answered_at) DESC LIMIT 20',
      [userId, today],
    ),
    query('SELECT COUNT(*) AS c FROM review_log WHERE user_id = ? AND local_day = ?', [userId, today]),
    // Ladder done: режимы введённые сегодня впервые, но карточка была раньше
    query(
      'SELECT COUNT(*) AS c FROM ('
      + 'SELECT card_id, mode FROM review_log WHERE user_id = ? GROUP BY card_id, mode HAVING MIN(local_day) = ?'
      + ') pm JOIN ('
      + 'SELECT card_id, MIN(local_day) AS d FROM review_log WHERE user_id = ? GROUP BY card_id'
      + ') f ON f.card_id = pm.card_id WHERE f.d < ?',
      [userId, today, userId, today],
    ),
    // Пары card_id:mode, у которых последний ответ сегодня был успешным (rating >= 2)
    query(
      'SELECT r.card_id, r.mode, r.rating FROM review_log r '
      + 'JOIN (SELECT card_id, mode, MAX(id) AS max_id FROM review_log WHERE user_id = ? AND local_day = ? GROUP BY card_id, mode) latest '
      + 'ON r.id = latest.max_id WHERE r.user_id = ? AND r.rating >= 2',
      [userId, today, userId],
    ),
  ]);

  const introducedIds = introRows.map((r) => Number(r.card_id));
  const doneReviews = Number(doneRows?.[0]?.c) || 0;
  const ladderDoneToday = Number(ladderRows?.[0]?.c) || 0;
  const doneKeysToday = (passedTodayRows || []).map((r) => `${Number(r.card_id)}:${r.mode}`);
  const goodKeysToday = (passedTodayRows || []).filter((r) => Number(r.rating) >= 3).map((r) => `${Number(r.card_id)}:${r.mode}`);

  const queue = buildQueue({
    cards: cardRows.map(rowToCard),
    states: stateRows,
    introducedToday: introducedIds.length,
    introducedIds,
    lapsedIds: lapsedRows.map((r) => Number(r.card_id)),
    doneToday: doneReviews,
    doneKeysToday,
    goodKeysToday,
    ladderDoneToday,
    localDay: today,
    now,
    settings,
    shuffle: true,
  });

  const newCardIds = new Set(queue.filter((i) => i.kind === 'new').map((i) => i.card_id));
  res.set('Cache-Control', 'no-store');
  res.json({
    date: today,
    queue,
    counts: {
      due: queue.filter((i) => i.kind === 'review').length,
      new: newCardIds.size,
      total: queue.length,
    },
    done_today: { reviews: doneReviews, new_cards: introducedIds.length },
  });
}));

export default router;
