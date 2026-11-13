// /api/export и /api/export/restore: полный бэкап и восстановление с изоляцией по user_id
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { MODE_VALUES } from '../keys.js';
import { getSettings, saveSettings, settingsPatchSchema, FIELD_SCHEMAS } from '../settings.js';
import { localDay, nowUtc, toIso, toSql } from '../time.js';
import { toCard } from './cards.js';
import { prepareCards, saveCards } from './import.js';

export const mountPath = '/api/export';
const router = Router();
export default router;

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function int(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}
const num = (v, def = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
const sqlOrNull = (v) => { try { return v ? toSql(v) : null; } catch { return null; } };

// ---------- экспорт ----------
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const data = await tx(async (conn) => {
    const q = async (sql, params) => (await conn.query(sql, params))[0];
    return {
      cards: await q('SELECT * FROM cards WHERE user_id = ? ORDER BY id', [userId]),
      states: await q('SELECT * FROM card_state WHERE user_id = ? ORDER BY card_id, mode', [userId]),
      logs: await q('SELECT * FROM review_log WHERE user_id = ? ORDER BY id', [userId]),
      sentences: await q('SELECT * FROM sentences WHERE user_id = ? ORDER BY id', [userId]),
      stats: await q('SELECT * FROM daily_stats WHERE user_id = ? ORDER BY day', [userId]),
    };
  });
  const now = nowUtc();
  res.set('Content-Disposition', `attachment; filename="german-trainer-${localDay(now)}.json"`);
  res.json({
    version: 1,
    exported_at: now.toISOString(),
    cards: data.cards.map(toCard),
    card_state: data.states.map((s) => ({ ...s, due: toIso(s.due), last_review: toIso(s.last_review) })),
    review_log: data.logs.map((r) => ({
      client_uuid: r.client_uuid, card_id: r.card_id, mode: r.mode, rating: r.rating, correct: !!r.correct,
      response_ms: r.response_ms, user_answer: r.user_answer, hints_used: r.hints_used,
      answered_at: toIso(r.answered_at), local_day: r.local_day, created_at: toIso(r.created_at),
    })),
    sentences: data.sentences.map((s) => ({
      id: s.id, card_id: s.card_id, text: s.text, corrected: s.corrected, errors: parseJson(s.errors, []),
      is_correct: !!s.is_correct, provider: s.provider, created_at: toIso(s.created_at),
    })),
    settings: await getSettings(null, userId),
    daily_stats: data.stats,
  });
}));

// ---------- экспорт колоды (v2 gt-deck) ----------
router.get('/deck', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const includeProgress = req.query.progress !== '0';
  const data = await tx(async (conn) => {
    const [cards] = await conn.query('SELECT * FROM cards WHERE user_id = ? AND active = 1 ORDER BY id', [userId]);
    const [states] = includeProgress
      ? await conn.query('SELECT * FROM card_state WHERE user_id = ? ORDER BY card_id, mode', [userId])
      : [[]];
    return { cards, states };
  });
  const byCard = new Map();
  for (const s of data.states) {
    if (!MODE_VALUES.includes(s.mode)) continue;
    const list = byCard.get(s.card_id) || [];
    list.push({
      mode: s.mode,
      state: s.state,
      due: toIso(s.due),
      stability: s.stability,
      difficulty: s.difficulty,
      elapsed_days: s.elapsed_days,
      scheduled_days: s.scheduled_days,
      learning_steps: s.learning_steps,
      reps: s.reps,
      lapses: s.lapses,
      last_review: toIso(s.last_review),
    });
    byCard.set(s.card_id, list);
  }
  const now = nowUtc();
  res.set('Content-Disposition', `attachment; filename="german-trainer-deck-${localDay(now)}.json"`);
  res.json({
    format: 'gt-deck',
    version: 2,
    exported_at: now.toISOString(),
    cards: data.cards.map((r) => {
      const c = toCard(r);
      const prog = byCard.get(c.id);
      return prog && prog.length ? { ...c, progress: prog } : c;
    }),
  });
}));

// ---------- восстановление (только безопасный merge) ----------
const arr = (max) => z.array(z.unknown()).max(max).default([]);
const restoreSchema = z.object({
  format: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]).default(1),
  cards: z.array(z.unknown()).max(20000),
  card_state: arr(100000),
  review_log: arr(200000),
  sentences: arr(50000),
  settings: z.record(z.string(), z.unknown()).optional(),
  daily_stats: arr(5000),
});

/** Пакетная вставка; возвращает число записанных строк */
async function bulk(conn, sqlHead, rows, sqlTail = '') {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const [r] = await conn.query(`${sqlHead} VALUES ? ${sqlTail}`, [rows.slice(i, i + 500)]);
    written += sqlTail ? Math.min(500, rows.length - i) : r.affectedRows;
  }
  return written;
}

const STATE_COLS = ['card_id', 'mode', 'user_id', 'state', 'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days',
  'learning_steps', 'reps', 'lapses', 'last_review'];
const STATE_UPSERT = `ON DUPLICATE KEY UPDATE ${['state', 'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days',
  'learning_steps', 'lapses', 'last_review', 'reps']
  .map((c) => (c === 'reps' ? 'reps = IF(VALUES(reps) > reps, VALUES(reps), reps)' : `${c} = IF(VALUES(reps) > reps, VALUES(${c}), ${c})`))
  .join(', ')}`;

const STAT_COLS = ['user_id', 'day', 'reviews', 'correct', 'new_cards', 'active_seconds', 'ext_audio_min', 'ext_speaking_min', 'ext_reading_min'];

router.post('/restore', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const mode = req.query.mode ?? 'merge';
  if (mode !== 'merge') {
    throw new ApiError(400, 'BAD_REQUEST', 'Поддерживается только безопасное слияние (mode=merge)');
  }
  const body = validate(restoreSchema, req.body, 'Некорректный файл бэкапа');

  const restored = await tx(async (conn) => {
    const out = { cards: 0, card_state: 0, review_log: 0, sentences: 0, settings: 0, daily_stats: 0 };

    // Карточки: сопоставляем по dedupe_key, старый id -> новый id
    const { prepared } = prepareCards(body.cards, { split: false });
    const { added, merged } = await saveCards(conn, prepared, userId);
    out.cards = added + merged;
    const [idRows] = await conn.query('SELECT id, dedupe_key, pos, article FROM cards WHERE user_id = ?', [userId]);
    const keyToId = new Map(idRows.map((r) => [r.dedupe_key, r.id]));
    const nounArtCardIds = new Set(
      idRows.filter((r) => r.pos === 'noun' && ['der', 'die', 'das'].includes(r.article)).map((r) => r.id),
    );
    const idMap = new Map();
    const inlineStates = [];
    for (const { card, index } of prepared) {
      const newId = keyToId.get(card.dedupe_key);
      const rawCard = body.cards[index];
      const oldId = Number(rawCard?.id);
      if (Number.isInteger(oldId) && oldId > 0 && newId) idMap.set(oldId, newId);
      if (newId && Array.isArray(rawCard?.progress)) {
        for (const p of rawCard.progress) {
          if (isObj(p)) inlineStates.push({ ...p, _resolved_card_id: newId });
        }
      }
    }

    // Состояния FSRS (из card_state + встроенные progress из gt-deck v2)
    const states = [];
    for (const s of [...body.card_state, ...inlineStates]) {
      if (!isObj(s)) continue;
      const cardId = s._resolved_card_id || idMap.get(Number(s.card_id));
      const due = sqlOrNull(s.due);
      if (!cardId || !MODE_VALUES.includes(s.mode) || !due) continue;
      if (s.mode === 'article' && !nounArtCardIds.has(cardId)) continue;
      states.push([cardId, s.mode, userId, int(s.state, 0, 0, 3), due, num(s.stability), num(s.difficulty),
        int(s.elapsed_days, 0, 0, 1e6), int(s.scheduled_days, 0, 0, 1e6), int(s.learning_steps, 0, 0, 100),
        int(s.reps, 0, 0, 1e6), int(s.lapses, 0, 0, 1e6), sqlOrNull(s.last_review)]);
    }
    out.card_state = await bulk(conn, `INSERT INTO card_state (${STATE_COLS.join(', ')})`, states, STATE_UPSERT);

    // Журнал повторов: INSERT IGNORE по (user_id, client_uuid)
    const logs = [];
    for (const r of body.review_log) {
      if (!isObj(r)) continue;
      const cardId = idMap.get(Number(r.card_id));
      const answered = sqlOrNull(r.answered_at);
      if (!cardId || !answered || !UUID_RE.test(String(r.client_uuid)) || !MODE_VALUES.includes(r.mode)) continue;
      const rating = int(r.rating, 0, 0, 4);
      if (rating < 1) continue;
      logs.push([userId, String(r.client_uuid), cardId, r.mode, rating, r.correct === true || r.correct === 1 ? 1 : 0,
        r.response_ms == null ? null : int(r.response_ms, 0, 0, 2147483647),
        typeof r.user_answer === 'string' ? r.user_answer.slice(0, 2000) : null,
        int(r.hints_used, 0, 0, 127), answered,
        DAY_RE.test(String(r.local_day)) ? r.local_day : localDay(answered),
        sqlOrNull(r.created_at) ?? answered]);
    }
    out.review_log = await bulk(conn, 'INSERT IGNORE INTO review_log (user_id, client_uuid, card_id, mode, rating, correct, '
      + 'response_ms, user_answer, hints_used, answered_at, local_day, created_at)', logs);

    // Предложения: пропускаем уже существующие (тот же пользователь, текст и время)
    for (const s of body.sentences) {
      if (!isObj(s) || typeof s.text !== 'string' || typeof s.corrected !== 'string') continue;
      const created = sqlOrNull(s.created_at) ?? toSql(nowUtc());
      const errors = typeof s.errors === 'string' ? s.errors : JSON.stringify(Array.isArray(s.errors) ? s.errors : []);
      const [r] = await conn.query(
        'INSERT INTO sentences (user_id, card_id, text, corrected, errors, is_correct, provider, created_at) '
        + 'SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM sentences WHERE user_id = ? AND text = ? AND created_at = ?)',
        [userId, idMap.get(Number(s.card_id)) ?? null, s.text.slice(0, 20000), s.corrected.slice(0, 20000), errors,
          s.is_correct === true || s.is_correct === 1 ? 1 : 0,
          typeof s.provider === 'string' ? s.provider.slice(0, 30) : null, created,
          userId, s.text.slice(0, 20000), created]);
      out.sentences += r.affectedRows;
    }

    // Статистика по дням: при слиянии берём максимум
    const stats = [];
    for (const d of body.daily_stats) {
      if (!isObj(d) || !DAY_RE.test(String(d.day))) continue;
      stats.push([userId, d.day, ...STAT_COLS.slice(2).map((c) => int(d[c], 0, 0, 1e9))]);
    }
    out.daily_stats = await bulk(conn, `INSERT INTO daily_stats (${STAT_COLS.join(', ')})`, stats,
      `ON DUPLICATE KEY UPDATE ${STAT_COLS.slice(2).map((c) => `${c} = GREATEST(${c}, VALUES(${c}))`).join(', ')}`);

    // Настройки
    if (body.settings) {
      const ok = {};
      for (const [k, v] of Object.entries(body.settings)) {
        if (!FIELD_SCHEMAS[k]) continue;
        const r = settingsPatchSchema.safeParse({ [k]: v });
        if (r.success && r.data[k] !== undefined) ok[k] = r.data[k];
      }
      await saveSettings(ok, conn, userId);
      out.settings = Object.keys(ok).length;
    }
    return out;
  });
  res.json({ restored });
}));
