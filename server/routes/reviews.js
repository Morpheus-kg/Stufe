// POST /api/reviews — пакет ответов (идемпотентно по user_id+client_uuid, A4)
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db.js';
import { ApiError, asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { localDay, toSql } from '../time.js';
import { applyReview, createEmptyState, parseDate } from '../srs/engine.js';
import { MODES } from '../../shared/constants.js';

export const mountPath = '/api/reviews';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const envelope = z.object({
  reviews: z.array(z.unknown()).max(1000),
  active_seconds: z.number().int().min(0).max(43200).nullish(),
});

const reviewItem = z.object({
  client_uuid: z.string().regex(UUID_RE),
  card_id: z.number().int().positive(),
  mode: z.enum(MODES),
  rating: z.number().int().min(1).max(4),
  correct: z.union([z.boolean(), z.literal(0), z.literal(1)]),
  response_ms: z.number().min(0).max(3600000).nullish(),
  user_answer: z.string().nullish(),
  hints_used: z.number().min(0).max(100).nullish(),
  answered_at: z.string().min(10).max(40),
});

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const env = envelope.safeParse(req.body ?? {});
  if (!env.success) {
    throw new ApiError(400, 'BAD_REQUEST', 'Некорректный запрос: ожидается {reviews:[...]}.');
  }

  const now = new Date();
  const rejected = [];
  const valid = [];
  for (const raw of env.data.reviews) {
    const uuid = raw && typeof raw.client_uuid === 'string' ? raw.client_uuid.slice(0, 36) : '';
    const p = reviewItem.safeParse(raw);
    if (!p.success) {
      rejected.push({ client_uuid: uuid, reason: 'invalid_fields' });
      continue;
    }
    const at = parseDate(p.data.answered_at);
    if (!at) {
      rejected.push({ client_uuid: uuid, reason: 'invalid_answered_at' });
      continue;
    }
    valid.push({
      ...p.data,
      correct: p.data.correct === true || p.data.correct === 1,
      response_ms: p.data.response_ms == null ? null : Math.round(p.data.response_ms),
      hints_used: p.data.hints_used == null ? 0 : Math.round(p.data.hints_used),
      user_answer: p.data.user_answer ? p.data.user_answer.slice(0, 2000) : null,
      at: at > now ? now : at,
      ord: valid.length,
    });
  }
  valid.sort((x, y) => x.at - y.at || x.ord - y.ord);

  const settings = await getSettings(null, userId);
  const retention = settings.request_retention;

  const out = await tx(async (conn) => {
    const applied = [];
    const duplicates = [];
    const rejectedDb = [];
    const stats = new Map(); // день -> {reviews, correct, new_cards}

    // Проверяем что карточки принадлежат этому пользователю
    const ids = [...new Set(valid.map((r) => r.card_id))];
    const existing = new Set();
    if (ids.length) {
      const [rows] = await conn.query(
        'SELECT id FROM cards WHERE user_id = ? AND id IN (?)',
        [userId, ids],
      );
      for (const r of rows) existing.add(Number(r.id));
    }

    for (const r of valid) {
      if (!existing.has(r.card_id)) {
        rejectedDb.push({ client_uuid: r.client_uuid, reason: 'card_not_found' });
        continue;
      }
      const day = localDay(r.at);

      // INSERT IGNORE с user_id+client_uuid как уникальным ключом (R8)
      const [ins] = await conn.query(
        'INSERT IGNORE INTO review_log '
        + '(user_id, client_uuid, card_id, mode, rating, correct, response_ms, user_answer, hints_used, answered_at, local_day) '
        + 'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [userId, r.client_uuid, r.card_id, r.mode, r.rating, r.correct ? 1 : 0,
          r.response_ms, r.user_answer, r.hints_used, toSql(r.at), day],
      );
      if (!ins || !ins.affectedRows) {
        duplicates.push(r.client_uuid);
        continue;
      }

      // Состояние карточки (через JOIN для изоляции)
      const [stRows] = await conn.query(
        'SELECT cs.card_id, cs.mode, cs.state, cs.due, cs.stability, cs.difficulty, cs.elapsed_days, '
        + 'cs.scheduled_days, cs.learning_steps, cs.reps, cs.lapses, cs.last_review '
        + 'FROM card_state cs JOIN cards c ON c.id = cs.card_id '
        + 'WHERE cs.card_id = ? AND c.user_id = ? FOR UPDATE',
        [r.card_id, userId],
      );
      const hadAny = stRows.length > 0;
      const cur = stRows.find((x) => x.mode === r.mode) ?? null;

      const curLast = cur ? parseDate(cur.last_review) : null;
      const stale = !!(curLast && r.at < curLast);

      if (!stale) {
        const next = applyReview(cur ?? createEmptyState(r.card_id, r.mode, r.at), r.rating, r.at, {
          requestRetention: retention,
        });
        // card_state.user_id заполняется из карточки (R2)
        await conn.query(
          'INSERT INTO card_state '
          + '(card_id, mode, user_id, state, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, last_review) '
          + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) '
          + 'ON DUPLICATE KEY UPDATE state=VALUES(state), due=VALUES(due), stability=VALUES(stability), '
          + 'difficulty=VALUES(difficulty), elapsed_days=VALUES(elapsed_days), scheduled_days=VALUES(scheduled_days), '
          + 'learning_steps=VALUES(learning_steps), reps=VALUES(reps), lapses=VALUES(lapses), last_review=VALUES(last_review)',
          [r.card_id, r.mode, userId, next.state, toSql(new Date(next.due)), next.stability, next.difficulty,
            next.elapsed_days, next.scheduled_days, next.learning_steps, next.reps, next.lapses,
            toSql(new Date(next.last_review))],
        );
        // Связанный сдвиг интервалов: успешный ответ (rating >= 3) в сложном режиме (cloze/article)
        // мягко сдвигает просроченный ru_de этой же карточки на 1 день вперёд, чтобы не спамить словом.
        if ((r.mode === 'cloze' || r.mode === 'article') && r.rating >= 3) {
          const atSql = toSql(r.at);
          await conn.query(
            "UPDATE card_state SET due = DATE_ADD(?, INTERVAL 1 DAY) WHERE user_id = ? AND card_id = ? AND mode = 'ru_de' AND due <= ?",
            [atSql, userId, r.card_id, atSql],
          );
        }
      }

      const st = stats.get(day) ?? { reviews: 0, correct: 0, new_cards: 0 };
      st.reviews += 1;
      if (r.correct) st.correct += 1;
      if (!hadAny) st.new_cards += 1;
      stats.set(day, st);

      applied.push(r.client_uuid);
    }

    for (const [day, s] of stats) {
      await conn.query(
        'INSERT INTO daily_stats (user_id, day, reviews, correct, new_cards) VALUES (?,?,?,?,?) '
        + 'ON DUPLICATE KEY UPDATE reviews = reviews + VALUES(reviews), correct = correct + VALUES(correct), '
        + 'new_cards = new_cards + VALUES(new_cards)',
        [userId, day, s.reviews, s.correct, s.new_cards],
      );
    }

    const seconds = env.data.active_seconds || 0;
    if (applied.length && seconds > 0) {
      const lastDay = localDay(valid[valid.length - 1]?.at || now);
      await conn.query(
        'INSERT INTO daily_stats (user_id, day, active_seconds) VALUES (?,?,?) '
        + 'ON DUPLICATE KEY UPDATE active_seconds = active_seconds + VALUES(active_seconds)',
        [userId, lastDay, seconds],
      );
    }

    return { applied, duplicates, rejectedDb };
  });

  res.json({
    applied: out.applied,
    duplicates: out.duplicates,
    rejected: [...rejected, ...out.rejectedDb],
  });
}));

export default router;
