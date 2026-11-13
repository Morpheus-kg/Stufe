// Тексты для чтения и аудирования, попытки (CONTRACT v2, 4.1) с изоляцией по user_id
import { Router } from 'express';
import { z } from 'zod';
import { pool, query, tx } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc, toIso } from '../time.js';
import { logActivity, safeJson } from '../activities.js';
import { chatJSON } from '../ai/llm.js';

export const mountPath = '/api/texts';
const router = Router();

const KINDS = ['reading', 'listening', 'dialogue'];
const LEVELS = ['B1', 'B2', 'C1'];
const MODE_ACTIVITY = { read: 'reading', listen: 'listening', dictation: 'dictation_text' };

function dropEmpty(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== ''));
}

const intLike = (min, max) => z.number().min(min).max(max).transform((n) => Math.round(n));
const idParam = z.coerce.number().int().positive().max(2147483647);

export function normalizeBody(s) {
  return String(s).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

export const listQuerySchema = z.object({
  kind: z.enum(KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

export const createTextSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(100000).transform(normalizeBody)
    .refine((s) => s.length >= 50 && s.length <= 20000),
  level: z.enum(LEVELS).optional(),
  topic: z.string().trim().min(1).max(50).optional(),
});

export const attemptSchema = z.object({
  mode: z.enum(['read', 'listen', 'dictation']),
  answers: z.array(z.union([z.number().int().min(0).max(20), z.null()])).max(50).optional(),
  plays_used: intLike(0, 100).optional(),
  seconds: intLike(0, 86400).default(0),
  correct: intLike(0, 100000).optional(),
  total: intLike(0, 100000).optional(),
});

export function countWords(text) {
  const m = String(text ?? '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

export function parseSpeakers(body) {
  const names = [];
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(/^\s*([^\s:][^:\n]{0,39}?)\s*:\s*\S/u);
    if (m && !names.includes(m[1]) && names.length < 6) names.push(m[1]);
  }
  return names.length >= 2 ? names.map((name) => ({ name })) : null;
}

export function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    if (q.type !== 'tf' && q.type !== 'mc') continue;
    if (typeof q.text !== 'string' || !Array.isArray(q.options)) continue;
    if (q.options.length < 2 || !q.options.every((o) => typeof o === 'string')) continue;
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) continue;
    out.push({
      id: typeof q.id === 'string' && q.id ? q.id : `q${out.length + 1}`,
      type: q.type,
      text: q.text,
      options: q.options,
      answer: q.answer,
      explanation_ru: typeof q.explanation_ru === 'string' ? q.explanation_ru : '',
      evidence: typeof q.evidence === 'string' ? q.evidence : '',
    });
  }
  return out;
}

export function scoreAnswers(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [];
  const ans = Array.isArray(answers) ? answers : [];
  let correct = 0;
  qs.forEach((q, i) => {
    if (Number.isInteger(ans[i]) && ans[i] === q.answer) correct += 1;
  });
  return { correct, total: qs.length };
}

export function toTextItem(row) {
  const speakersRaw = safeJson(row.speakers, null);
  const speakers = Array.isArray(speakersRaw)
    ? speakersRaw
      .map((s) => (typeof s === 'string' ? { name: s } : s))
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => ({ name: s.name.trim() }))
    : [];
  const idsRaw = safeJson(row.target_card_ids, []);
  const ids = Array.isArray(idsRaw)
    ? [...new Set(idsRaw.filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  let createdAt = null;
  try { createdAt = toIso(row.created_at); } catch { createdAt = null; }
  const out = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    speakers: speakers.length ? speakers : null,
    level: row.level,
    topic: row.topic,
    source: row.source,
    target_card_ids: ids,
    questions: normalizeQuestions(safeJson(row.questions, [])),
    glossary: Array.isArray(safeJson(row.glossary, [])) ? safeJson(row.glossary, []) : [],
    word_count: Number(row.word_count) || 0,
    provider: row.provider ?? null,
    created_at: createdAt,
  };
  if (row.gap_exercises) {
    const gaps = safeJson(row.gap_exercises, null);
    if (gaps && typeof gaps === 'object') out.gap_exercises = gaps;
  }
  return out;
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const raw = Object.fromEntries(Object.entries(req.query ?? {}).filter(([, v]) => v !== ''));
  const q = validate(listQuerySchema, raw, 'Неверные параметры списка текстов');
  const extraWhere = q.kind ? 'AND kind = ?' : '';
  const params = q.kind ? [userId, q.kind] : [userId];
  const [{ n } = { n: 0 }] = await query(`SELECT COUNT(*) AS n FROM texts WHERE user_id = ? ${extraWhere}`, params);
  const rows = await query(
    `SELECT * FROM texts WHERE user_id = ? ${extraWhere} ORDER BY created_at DESC, id DESC LIMIT ${q.limit} OFFSET ${q.offset}`,
    params,
  );
  res.json({ items: rows.map(toTextItem), total: Number(n) || 0 });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = validate(idParam, req.params.id, 'Неверный id текста');
  const rows = await query('SELECT * FROM texts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Текст не найден');
  res.json(toTextItem(rows[0]));
}));

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const b = validate(createTextSchema, dropEmpty(req.body), 'Неверные данные текста: тело должно быть от 50 до 20000 символов');
  const speakers = b.kind === 'dialogue' ? parseSpeakers(b.body) : null;
  const [ins] = await pool.query(
    `INSERT INTO texts (user_id, kind, title, body, speakers, level, topic, source, target_card_ids, questions, word_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pasted', '[]', '[]', ?)`,
    [userId, b.kind, b.title, b.body, speakers ? JSON.stringify(speakers) : null,
      b.level ?? 'B2', b.topic ?? 'Sonstiges', countWords(b.body)],
  );
  const rows = await query('SELECT * FROM texts WHERE id = ? AND user_id = ?', [ins.insertId, userId]);
  if (!rows.length) throw new ApiError(500, 'INTERNAL', 'Не удалось сохранить текст');
  res.status(201).json(toTextItem(rows[0]));
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = validate(idParam, req.params.id, 'Неверный id текста');
  const [r] = await pool.query('DELETE FROM texts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r?.affectedRows) throw new ApiError(404, 'NOT_FOUND', 'Текст не найден');
  res.status(204).end();
}));

router.post('/:id/attempts', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = validate(idParam, req.params.id, 'Неверный id текста');
  const b = validate(attemptSchema, dropEmpty(req.body), 'Неверные данные попытки');
  const rows = await query('SELECT id, questions FROM texts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Текст не найден');

  let correct;
  let total;
  if (b.mode === 'dictation') {
    total = b.total ?? 0;
    correct = Math.min(b.correct ?? 0, total);
  } else {
    ({ correct, total } = scoreAnswers(normalizeQuestions(safeJson(rows[0].questions, [])), b.answers));
  }
  const score = total > 0 ? Math.round((100 * correct) / total) : null;
  const day = localDay(nowUtc());

  const attemptId = await tx(async (conn) => {
    const [ins] = await conn.query(
      `INSERT INTO text_attempts (user_id, text_id, mode, answers, correct, total, plays_used, seconds, local_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, id, b.mode, b.answers ? JSON.stringify(b.answers) : null, correct, total,
        b.plays_used ?? 0, b.seconds, day],
    );
    await logActivity({ kind: MODE_ACTIVITY[b.mode], refId: id, seconds: b.seconds, score, userId }, conn);
    return ins.insertId;
  });
  res.status(201).json({ id: attemptId, correct, total });
}));

const gapExerciseAISchema = z.object({
  gapped_body: z.string().min(20).max(25000),
  options: z.array(z.string().min(5).max(500)).min(4).max(10),
  gaps: z.array(z.object({
    num: z.coerce.number().int().min(1).max(10),
    answer_index: z.coerce.number().int().min(0).max(9),
    connector: z.string().max(80).optional().default(''),
    explanation_ru: z.string().max(400).optional().default(''),
  })).min(3).max(8),
});

const GAP_SYSTEM_PROMPT = `You create a Goethe-Zertifikat B2/C1 Lesen (Sentence & Connector Insertion) exercise from a German text.
1. Choose 4 or 5 sentences in the text that contain or logically depend on discourse connectors (e.g. deshalb, trotzdem, dennoch, allerdings, folglich, außerdem, darüber hinaus, hingegen, nämlich).
2. Replace those 4-5 sentences in the text with numbered markers [1], [2], [3], [4] (and [5]). Keep the rest of the text intact in "gapped_body".
3. Put the removed sentences plus 2 plausible distractor sentences (also using B2 connectors) in shuffled order into the "options" array.
4. In "gaps", specify for each gap number (1..N):
   - "num": gap number (1..N)
   - "answer_index": 0-based index in "options"
   - "connector": the key German connector/reference word in that sentence
   - "explanation_ru": brief explanation in Russian why this sentence and connector fit the context before/after the gap.
Return ONLY valid JSON: {"gapped_body":"...","options":["..."],"gaps":[{"num":1,"answer_index":0,"connector":"...","explanation_ru":"..."}]}`;

router.post('/:id/gaps', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = validate(idParam, req.params.id, 'Неверный id текста');
  const rows = await query('SELECT * FROM texts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Текст не найден');
  const row = rows[0];
  const existing = row.gap_exercises ? safeJson(row.gap_exercises, null) : null;
  if (existing && Array.isArray(existing.gaps) && existing.gaps.length) {
    return res.json(existing);
  }
  const prefer = typeof req.body?.provider === 'string' && req.body.provider !== 'auto' ? req.body.provider : undefined;
  const { data } = await chatJSON({
    userId,
    feature: 'text',
    tier: 'fast',
    system: GAP_SYSTEM_PROMPT,
    user: `LEVEL: ${row.level || 'B2'}\nTITLE: ${row.title}\n\nTEXT:\n${String(row.body).slice(0, 8000)}`,
    schema: gapExerciseAISchema,
    temperature: 0.3,
    maxTokens: 2200,
    ...(prefer ? { preferProvider: prefer } : {}),
  });
  try {
    await pool.query(
      'UPDATE texts SET gap_exercises = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify(data), id, userId],
    );
  } catch { /* колонка может отсутствовать до миграции */ }
  res.json(data);
}));

export default router;
