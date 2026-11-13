// /api/cards: список, добавление, правка, мягкое удаление — с изоляцией по user_id (A4)
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { ARTICLES, LEVEL_VALUES, POS_VALUES, normalizeKey, splitArticle } from '../keys.js';
import { enrichCards, makeCloze } from '../ai/enrich.js';
import { LEARNED_STABILITY } from '../srs/queue.js';

export const mountPath = '/api/cards';
const router = Router();
export default router;

const COLS = 'id, term, article, plural, pos, translation, grammar, rektion, example, example_translation, '
  + 'example_cloze, cloze_answer, examples_json, level, topic, source, check_flag, enriched, active';

function parseExamplesJson(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

/** Строка БД -> Card JSON (без dedupe_key, булевы как true/false) */
export function toCard(r) {
  const out = {
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
  if (r.rektion !== undefined) out.rektion = r.rektion ?? null;
  if (r.examples_json !== undefined) out.examples = parseExamplesJson(r.examples_json);
  return out;
}

// ---------- схемы ----------
const nullable = (v) => (v === undefined ? undefined : (v || null));
const optText = (max) => z.string().max(max).nullish().transform((v) => (typeof v === 'string' ? (v.trim() || null) : v));
const reqText = (max) => z.string().max(max).transform((s) => s.trim()).pipe(z.string().min(1));
const optEnum = (values) => z.union([z.enum(values), z.literal('')]).nullish().transform(nullable);

const createSchema = z.object({
  term: reqText(255),
  translation: reqText(500),
  article: optEnum(ARTICLES),
  plural: optText(255),
  pos: optEnum(POS_VALUES),
  grammar: optText(2000),
  rektion: optText(100),
  example: optText(2000),
  example_translation: optText(2000),
  level: optEnum(LEVEL_VALUES),
  topic: optText(50),
});

const patchSchema = z.object({
  term: reqText(255),
  translation: reqText(500),
  article: optEnum(ARTICLES),
  plural: optText(255),
  pos: optEnum(POS_VALUES),
  grammar: optText(2000),
  rektion: optText(100),
  example: optText(2000),
  example_translation: optText(2000),
  example_cloze: optText(2000),
  cloze_answer: optText(255),
  level: optEnum(LEVEL_VALUES),
  topic: reqText(50),
  source: optText(255),
  check_flag: z.boolean(),
  enriched: z.boolean(),
  active: z.boolean(),
}).partial();

const NOT_NULL = new Set(['pos', 'level', 'topic']);

const listSchema = z.object({
  query: z.string().max(100).optional(),
  topic: z.string().max(50).optional(),
  pos: z.enum(POS_VALUES).optional(),
  check: z.enum(['0', '1']).optional(),
  status: z.enum(['new', 'learning', 'learned']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

const learnedSchema = z.object({
  learned: z.boolean().default(true),
});

function toCardWithStatus(r) {
  const base = toCard(r);
  const reps = Number(r.total_reps) || 0;
  const stab = Number(r.max_stab) || 0;
  const learning_status = reps === 0 ? 'new' : stab >= LEARNED_STABILITY ? 'learned' : 'learning';
  return {
    ...base,
    learning_status,
    stability: Math.round(stab * 10) / 10,
    reps,
  };
}

function parseId(raw) {
  if (!/^\d{1,10}$/.test(String(raw))) throw new ApiError(404, 'NOT_FOUND', 'Карточка не найдена');
  return Number(raw);
}

/** Убирает дублирующий артикль в начале term ('die Armut' при article=die) */
function stripArticle(term, article) {
  const m = new RegExp(`^${article}\\s+(.+)$`, 'iu').exec(term);
  return m ? m[1].trim() : term;
}

/**
 * Данные новой карточки из проверенного тела POST (чистая функция).
 */
export function normalizeNewCard(body) {
  let term = body.term.normalize('NFC').replace(/\s+/g, ' ').trim();
  let article = body.article ?? null;
  let pos = body.pos ?? null;
  if (article) {
    term = stripArticle(term, article);
  } else if (pos === null || pos === 'noun') {
    const s = splitArticle(term);
    if (s.article) { article = s.article; term = s.term; pos = pos ?? 'noun'; }
  }
  if (!pos) pos = article ? 'noun' : 'phrase';
  const key = normalizeKey(article, term);
  if (!key) throw new ApiError(400, 'BAD_REQUEST', 'Некорректное слово');
  const needed = [body.pos, body.grammar, body.level, body.topic, ...(pos === 'noun' ? [article, body.plural] : [])];
  return {
    term, article, pos,
    plural: body.plural ?? null,
    translation: body.translation,
    grammar: body.grammar ?? null,
    example: body.example ?? null,
    example_translation: body.example_translation ?? null,
    example_cloze: null,
    cloze_answer: null,
    level: body.level ?? 'B2',
    topic: body.topic ?? 'Sonstiges',
    source: null,
    check_flag: 0,
    enriched: !body.example && needed.every((v) => v !== null && v !== undefined) ? 1 : 0,
    dedupe_key: key,
  };
}

const WRITE_COLS = ['term', 'article', 'plural', 'pos', 'translation', 'grammar', 'example', 'example_translation',
  'example_cloze', 'cloze_answer', 'level', 'topic', 'source', 'check_flag', 'enriched', 'dedupe_key'];

/**
 * Создаёт карточку для userId. Дубликат активной -> 409 CONFLICT с existing_id.
 * Дубликат мягко удалённой -> карточка восстанавливается с новыми данными.
 */
export async function createCard(db, body, userId) {
  const c = normalizeNewCard(body);
  const [found] = await db.query(
    userId !== undefined
      ? 'SELECT id, active FROM cards WHERE user_id = ? AND dedupe_key = ? LIMIT 1'
      : 'SELECT id, active FROM cards WHERE dedupe_key = ? LIMIT 1 /* scope-ok */',
    userId !== undefined ? [userId, c.dedupe_key] : [c.dedupe_key],
  );
  const conflict = (id) => new ApiError(409, 'CONFLICT', 'Такая карточка уже есть', { existing_id: id });
  let id;
  if (found.length) {
    if (found[0].active) throw conflict(found[0].id);
    id = found[0].id;
    if (userId !== undefined) {
      await db.query(
        `UPDATE cards SET ${WRITE_COLS.map((k) => `\`${k}\` = ?`).join(', ')}, active = 1 WHERE id = ? AND user_id = ?`,
        [...WRITE_COLS.map((k) => c[k]), id, userId],
      );
    } else {
      await db.query(
        `UPDATE cards SET ${WRITE_COLS.map((k) => `\`${k}\` = ?`).join(', ')}, active = 1 WHERE id = ? /* scope-ok */`,
        [...WRITE_COLS.map((k) => c[k]), id],
      );
    }
  } else {
    try {
      if (userId !== undefined) {
        const [ins] = await db.query(
          `INSERT INTO cards (user_id, ${WRITE_COLS.join(', ')}) VALUES (?, ${WRITE_COLS.map(() => '?').join(', ')})`,
          [userId, ...WRITE_COLS.map((k) => c[k])],
        );
        id = ins.insertId;
      } else {
        const [ins] = await db.query(
          `INSERT INTO cards (${WRITE_COLS.join(', ')}) VALUES (${WRITE_COLS.map(() => '?').join(', ')}) /* scope-ok */`,
          [...WRITE_COLS.map((k) => c[k])],
        );
        id = ins.insertId;
      }
    } catch (err) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err;
      const [again] = await db.query(
        userId !== undefined
          ? 'SELECT id FROM cards WHERE user_id = ? AND dedupe_key = ? LIMIT 1'
          : 'SELECT id FROM cards WHERE dedupe_key = ? LIMIT 1 /* scope-ok */',
        userId !== undefined ? [userId, c.dedupe_key] : [c.dedupe_key],
      );
      throw conflict(again[0]?.id ?? null);
    }
  }
  const [rows] = await db.query(
    `SELECT ${COLS} FROM cards WHERE id = ? ${userId !== undefined ? 'AND user_id = ?' : '/* scope-ok */'}`,
    userId !== undefined ? [id, userId] : [id],
  );
  return toCard(rows[0]);
}

// ---------- маршруты ----------
const COLS_C = 'c.id, c.term, c.article, c.plural, c.pos, c.translation, c.grammar, c.rektion, c.example, c.example_translation, '
  + 'c.example_cloze, c.cloze_answer, c.examples_json, c.level, c.topic, c.source, c.check_flag, c.enriched, c.active';

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const raw = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== ''));
  const q = validate(listSchema, raw, 'Некорректные параметры');
  const where = ['c.active = 1'];
  const params = [];
  if (q.query) {
    const like = `%${q.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push("(c.term LIKE ? OR c.translation LIKE ? OR CONCAT_WS(' ', c.article, c.term) LIKE ?)");
    params.push(like, like, like);
  }
  if (q.topic) { where.push('c.topic = ?'); params.push(q.topic); }
  if (q.pos) { where.push('c.pos = ?'); params.push(q.pos); }
  if (q.check === '1') where.push('c.check_flag = 1');
  if (q.status === 'new') {
    where.push('(cs.total_reps IS NULL OR cs.total_reps = 0)');
  } else if (q.status === 'learning') {
    where.push('(cs.total_reps > 0 AND COALESCE(cs.max_stab, 0) < ?)');
    params.push(LEARNED_STABILITY);
  } else if (q.status === 'learned') {
    where.push('(cs.total_reps > 0 AND COALESCE(cs.max_stab, 0) >= ?)');
    params.push(LEARNED_STABILITY);
  }
  const w = where.join(' AND ');
  const joinSql = 'FROM cards c LEFT JOIN ('
    + 'SELECT card_id, MAX(stability) AS max_stab, SUM(reps) AS total_reps FROM card_state WHERE user_id = ? GROUP BY card_id'
    + ') cs ON cs.card_id = c.id WHERE c.user_id = ? AND ' + w;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${joinSql}`,
    [userId, userId, ...params],
  );
  const [rows] = await pool.query(
    `SELECT ${COLS_C}, COALESCE(cs.max_stab, 0) AS max_stab, COALESCE(cs.total_reps, 0) AS total_reps ${joinSql} ORDER BY c.term ASC, c.id ASC LIMIT ? OFFSET ?`,
    [userId, userId, ...params, q.limit, q.offset],
  );
  res.json({ items: rows.map(toCardWithStatus), total: Number(total) });
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const body = validate(createSchema, req.body, 'Некорректная карточка');
  const card = await createCard(pool, body, userId);
  if (card.example && !card.example_cloze) {
    const cl = makeCloze(card.example, card.term);
    if (cl) {
      await pool.query(
        'UPDATE cards SET example_cloze = ?, cloze_answer = ? WHERE id = ? AND user_id = ?',
        [cl.example_cloze, cl.cloze_answer, card.id, userId],
      );
      card.example_cloze = cl.example_cloze;
      card.cloze_answer = cl.cloze_answer;
    }
  }
  if (!card.enriched) {
    enrichCards(3, userId).catch(() => {});
  }
  res.status(201).json({ ...card, learning_status: 'new', stability: 0, reps: 0 });
}));

router.post('/undo-batch', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const batchId = typeof req.body?.batch_id === 'string' ? req.body.batch_id.trim().slice(0, 36) : '';
  if (!batchId) throw new ApiError(400, 'BAD_REQUEST', 'Укажите batch_id');
  const [r] = await pool.query(
    'DELETE c FROM cards c WHERE c.user_id = ? AND c.source_batch = ? '
    + 'AND NOT EXISTS (SELECT 1 FROM card_state cs WHERE cs.user_id = ? AND cs.card_id = c.id)',
    [userId, batchId, userId],
  );
  res.json({ deleted: r?.affectedRows ?? 0 });
}));

router.post('/:id/learned', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = parseId(req.params.id);
  const { learned } = validate(learnedSchema, req.body ?? {}, 'Некорректные параметры');
  const [cur] = await pool.query(
    `SELECT ${COLS} FROM cards WHERE id = ? AND user_id = ? AND active = 1`,
    [id, userId],
  );
  if (!cur.length) throw new ApiError(404, 'NOT_FOUND', 'Карточка не найдена');
  if (learned) {
    const isNounWithArt = cur[0].pos === 'noun' && ['der', 'die', 'das'].includes(cur[0].article);
    const modes = isNounWithArt ? ['ru_de', 'cloze', 'article'] : ['ru_de', 'cloze'];
    for (const mode of modes) {
      await pool.query(
        'INSERT INTO card_state (user_id, card_id, mode, state, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, last_review) '
        + 'VALUES (?, ?, ?, 2, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 90 DAY), 90, 3, 0, 90, 0, 5, 0, UTC_TIMESTAMP()) '
        + 'ON DUPLICATE KEY UPDATE state = 2, due = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 90 DAY), '
        + 'stability = GREATEST(stability, 90), scheduled_days = GREATEST(scheduled_days, 90), reps = GREATEST(reps, 5), last_review = UTC_TIMESTAMP()',
        [userId, id, mode],
      );
    }
    if (!isNounWithArt) {
      await pool.query("DELETE FROM card_state WHERE user_id = ? AND card_id = ? AND mode = 'article'", [userId, id]);
    }
  } else {
    await pool.query('DELETE FROM card_state WHERE user_id = ? AND card_id = ?', [userId, id]);
  }
  res.json({
    ...toCard(cur[0]),
    learning_status: learned ? 'learned' : 'new',
    stability: learned ? 90 : 0,
    reps: learned ? 5 : 0,
  });
}));

router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = parseId(req.params.id);
  const body = validate(patchSchema, req.body, 'Некорректные поля');
  const upd = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || (v === null && NOT_NULL.has(k))) continue;
    upd[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  if (!Object.keys(body).length) throw new ApiError(400, 'BAD_REQUEST', 'Нет полей для изменения');

  const [cur] = await pool.query(
    `SELECT ${COLS}, dedupe_key FROM cards WHERE id = ? AND user_id = ?`, /* scope-ok: user owned */
    [id, userId],
  );
  if (!cur.length) throw new ApiError(404, 'NOT_FOUND', 'Карточка не найдена');
  const merged = { ...cur[0], ...upd };

  if ('term' in upd) {
    if (merged.article) merged.term = stripArticle(merged.term.replace(/\s+/g, ' '), merged.article);
    else if (merged.pos === 'noun') {
      const s = splitArticle(merged.term);
      if (s.article) { merged.article = s.article; merged.term = s.term; upd.article = s.article; }
    }
    upd.term = merged.term;
  }
  if ('example' in upd && merged.example && !('example_cloze' in upd)) {
    const cl = makeCloze(merged.example, merged.cloze_answer || merged.term) || makeCloze(merged.example, merged.term);
    if (cl) {
      upd.example_cloze = cl.example_cloze;
      upd.cloze_answer = cl.cloze_answer;
    }
  }
  const key = normalizeKey(merged.article, merged.term);
  if (!key) throw new ApiError(400, 'BAD_REQUEST', 'Некорректное слово');
  if (key !== cur[0].dedupe_key) {
    const [dup] = await pool.query(
      'SELECT id FROM cards WHERE user_id = ? AND dedupe_key = ? AND id <> ? LIMIT 1',
      [userId, key, id],
    );
    if (dup.length) throw new ApiError(409, 'CONFLICT', 'Такая карточка уже есть', { existing_id: dup[0].id });
    upd.dedupe_key = key;
  }
  const keys = Object.keys(upd);
  if (keys.length) {
    try {
      await pool.query(
        `UPDATE cards SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
        [...keys.map((k) => upd[k]), id, userId],
      );
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') throw new ApiError(409, 'CONFLICT', 'Такая карточка уже есть');
      throw err;
    }
    if (merged.pos !== 'noun' || !['der', 'die', 'das'].includes(merged.article)) {
      await pool.query(
        "DELETE FROM card_state WHERE user_id = ? AND card_id = ? AND mode = 'article'",
        [userId, id],
      );
    }
  }
  const [rows] = await pool.query(
    `SELECT ${COLS} FROM cards WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  res.json(toCard(rows[0]));
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = parseId(req.params.id);
  const [cur] = await pool.query('SELECT id FROM cards WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur.length) throw new ApiError(404, 'NOT_FOUND', 'Карточка не найдена');
  await pool.query('UPDATE cards SET active = 0 WHERE id = ? AND user_id = ?', [id, userId]);
  res.status(204).end();
}));
