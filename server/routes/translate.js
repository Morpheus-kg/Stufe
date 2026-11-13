// Наборы переводов и пакетная проверка (M8b) с изоляцией по user_id
import express from 'express';
import { query } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc, toSql, toIso } from '../time.js';
import { chatJSON } from '../ai/llm.js';
import { checkBatch, loadPromptText, esc } from '../ai/batchcheck.js';
import { getUserTopErrors } from '../error_profile.js';
import { setRequestSchema, setGeneratedSchema, checkRequestSchema, basketRequestSchema } from '../ai/schemas_v2b.js';

export const mountPath = '/api';
const router = express.Router();

async function logActivitySafe(entry) {
  try {
    const mod = await import('../activities.js');
    await mod.logActivity(entry);
  } catch { /* не критично */ }
}

const defaultDeps = { query, chat: chatJSON, log: logActivitySafe };

function jparse(s, fallback) {
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}
const display = (c) => `${c.article ? `${c.article} ` : ''}${c.term}`;
const iso = (v) => (v ? toIso(v) : null);
const secondsOf = (h) => {
  const n = parseInt(h, 10);
  return Number.isFinite(n) ? Math.min(86400, Math.max(0, n)) : 0;
};

async function pickCards(deps, ids, kind, limit = 3, userId) {
  if (ids?.length) {
    return deps.query('SELECT * FROM cards WHERE user_id = ? AND active = 1 AND id IN (?)', [userId, [...new Set(ids)].slice(0, 8)]);
  }
  if (kind === 'transform') return [];
  const due = await deps.query(
    'SELECT * FROM cards WHERE user_id = ? AND active = 1 AND id IN (SELECT card_id FROM card_state WHERE user_id = ? AND (due <= ? OR lapses > 0)) ORDER BY RAND() LIMIT ?',
    [userId, userId, toSql(nowUtc()), limit]);
  if (due.length) return due;
  return deps.query('SELECT * FROM cards WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT ?', [userId, limit]);
}

function buildSetUser({ kind, count, level, topic, focus, cards, weaknesses = [] }) {
  const lines = [`KIND: ${kind}`, `COUNT: ${count}`, `LEVEL: ${level}`, '<<<DATA'];
  if (topic) lines.push(`TOPIC: ${esc(topic)}`);
  if (kind === 'transform') lines.push(`FOCUS: ${focus || 'mix'}`);
  if (weaknesses.length) lines.push(`PRACTICE_GRAMMAR_WEAKNESSES: ${weaknesses.join(', ')}`);
  if (cards.length) {
    lines.push('TARGET_WORDS:');
    for (const c of cards) lines.push(`- id=${c.id} ${esc(display(c))} (${esc(c.translation)})`);
  }
  lines.push('>>>DATA');
  return lines.join('\n');
}

export async function generateSet(body, deps = defaultDeps, userId) {
  const kind = body.kind;
  const count = body.count || 5;
  const level = body.level || 'B2';
  const [cards, topErrors] = await Promise.all([
    pickCards(deps, body.card_ids, kind, 3, userId),
    getUserTopErrors(userId, 3, deps.query),
  ]);
  const weaknesses = topErrors.map((e) => e.category);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const system = await loadPromptText(kind === 'transform' ? 'transform_set' : 'translate_set');
  const opts = {
    userId,
    feature: 'translate', tier: 'strong', system, temperature: 0.7, maxTokens: 2500,
    user: buildSetUser({ kind, count, level, topic: body.topic, focus: body.focus, cards, weaknesses }),
    schema: setGeneratedSchema,
  };
  if (body.provider && body.provider !== 'auto') opts.preferProvider = body.provider;
  const { data, provider } = await deps.chat(opts);

  const parsed = setGeneratedSchema.safeParse(data);
  const items = [];
  if (parsed.success) {
    for (const it of parsed.data.items) {
      const source_text = String(it.source_text || '').trim().slice(0, 600);
      const reference = String(it.reference || '').trim().slice(0, 800);
      if (!source_text || !reference) continue;
      const cardId = byId.has(it.card_id) ? it.card_id : null;
      items.push({
        idx: items.length + 1, source_text, reference,
        instruction_ru: kind === 'transform'
          ? (String(it.instruction_ru || '').trim().slice(0, 300) || 'Преобразуйте предложение по образцу B2.') : null,
        card_id: cardId,
        hint_words: cardId ? [{ card_id: cardId, display: display(byId.get(cardId)) }] : [],
      });
      if (items.length >= count) break;
    }
  }
  if (!items.length) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул неподходящий набор. Попробуйте ещё раз.');

  const res = await deps.query(
    'INSERT INTO translation_sets (user_id, kind, level, topic, focus, items, target_card_ids, provider, local_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, kind, level, body.topic || null, kind === 'transform' ? (body.focus || null) : null, JSON.stringify(items),
      JSON.stringify(cards.map((c) => c.id)), provider || null, localDay(nowUtc())]);
  return {
    id: res.insertId, kind,
    items: items.map((i) => ({
      idx: i.idx, source_text: i.source_text,
      ...(i.instruction_ru ? { instruction_ru: i.instruction_ru } : {}),
      hint_words: i.hint_words,
    })),
  };
}

async function targetsFor(deps, ids, userId) {
  const clean = [...new Set(ids.filter(Boolean))];
  const map = new Map();
  if (!clean.length) return map;
  const rows = await deps.query('SELECT id, article, term FROM cards WHERE user_id = ? AND id IN (?)', [userId, clean]);
  for (const c of rows) map.set(c.id, display(c));
  return map;
}

export async function runCheck(id, answers, seconds = 0, deps = defaultDeps, userId, provider) {
  const rows = await deps.query('SELECT id, kind, level, items, checked_at FROM translation_sets WHERE id = ? AND user_id = ?', [id, userId]);
  const row = rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Набор не найден.');
  if (row.checked_at) throw new ApiError(409, 'CONFLICT', 'Этот набор уже проверен.');
  const stored = jparse(row.items, []);
  if (!Array.isArray(stored) || !stored.length) throw new ApiError(500, 'INTERNAL', 'Набор повреждён.');

  const claim = await deps.query('UPDATE translation_sets SET checked_at = ? WHERE id = ? AND user_id = ? AND checked_at IS NULL', [toSql(nowUtc()), id, userId]);
  if (!claim || claim.affectedRows === 0) throw new ApiError(409, 'CONFLICT', 'Этот набор уже проверен.');

  const amap = new Map();
  for (const a of answers || []) amap.set(a.idx, String(a.answer ?? '').trim());
  try {
    const targetsById = await targetsFor(deps, stored.map((i) => i.card_id), userId);
    const items = stored.map((i) => ({
      idx: i.idx, source: i.source_text, instruction: i.instruction_ru || '', reference: i.reference,
      answer: amap.get(i.idx) || '', card_id: i.card_id || null,
    }));
    const result = await checkBatch(items, { kind: row.kind, level: row.level, feature: 'translate', chat: deps.chat, targetsById, userId, provider });
    await deps.query('UPDATE translation_sets SET answers = ?, result = ?, score = ?, local_day = ? WHERE id = ? AND user_id = ?',
      [JSON.stringify(stored.map((i) => ({ idx: i.idx, answer: amap.get(i.idx) || '' }))), JSON.stringify(result), result.score, localDay(nowUtc()), id, userId]);
    await deps.log({ kind: 'translation', refId: id, seconds, score: result.score, userId });
    return { id, ...result };
  } catch (e) {
    try { await deps.query('UPDATE translation_sets SET checked_at = NULL WHERE id = ? AND user_id = ?', [id, userId]); } catch { /* ignore */ }
    throw e;
  }
}

export async function runBasket(items, seconds = 0, deps = defaultDeps, userId, provider) {
  const idxs = new Set(items.map((i) => i.idx));
  if (idxs.size !== items.length) throw new ApiError(400, 'BAD_REQUEST', 'Номера предложений повторяются.');
  const targetsById = await targetsFor(deps, items.map((i) => i.card_id), userId);
  const result = await checkBatch(items.map((i) => ({
    idx: i.idx, source: i.source, answer: i.answer, reference: i.reference || '', card_id: i.card_id || null,
  })), { kind: 'basket', level: 'B2', feature: 'translate', chat: deps.chat, targetsById, userId, provider });

  const stored = items.map((i) => ({ idx: i.idx, source_text: i.source, reference: i.reference || '', card_id: i.card_id || null, hint_words: [] }));
  const now = toSql(nowUtc());
  const res = await deps.query(
    'INSERT INTO translation_sets (user_id, kind, level, items, target_card_ids, answers, result, score, local_day, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, 'basket', 'B2', JSON.stringify(stored), JSON.stringify([...new Set(items.map((i) => i.card_id).filter(Boolean))]),
      JSON.stringify(items.map((i) => ({ idx: i.idx, answer: i.answer }))), JSON.stringify(result), result.score, localDay(nowUtc()), now]);
  await deps.log({ kind: 'translation', refId: res.insertId, seconds, score: result.score, userId });
  return { id: res.insertId, ...result };
}

router.post('/translate/set', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(setRequestSchema, req.body || {}, 'Некорректные параметры набора.');
  res.json(await generateSet(body, defaultDeps, req.user.id));
}));

router.post('/translate/set/:id/check', requireAuth, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'BAD_REQUEST', 'Некорректный номер набора.');
  const body = validate(checkRequestSchema, req.body || {}, 'Некорректные ответы.');
  res.json(await runCheck(id, body.answers, secondsOf(req.get('X-Seconds')), defaultDeps, req.user.id, body.provider));
}));

router.post('/ai/check-batch', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(basketRequestSchema, req.body || {}, 'Некорректный список предложений.');
  res.json(await runBasket(body.items, secondsOf(req.get('X-Seconds')), defaultDeps, req.user.id, body.provider));
}));

router.get('/translate/sets', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const rows = await query('SELECT id, kind, score, items, created_at, checked_at FROM translation_sets WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
  res.json({
    items: rows.map((r) => ({
      id: r.id, kind: r.kind, score: r.score ?? null, n: jparse(r.items, []).length,
      created_at: iso(r.created_at), checked_at: iso(r.checked_at),
    })),
  });
}));

router.get('/translate/sets/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'BAD_REQUEST', 'Некорректный номер набора.');
  const rows = await query('SELECT * FROM translation_sets WHERE id = ? AND user_id = ?', [id, userId]);
  const r = rows[0];
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'Набор не найден.');
  const checked = !!r.checked_at;
  const items = jparse(r.items, []).map((i) => ({
    idx: i.idx, source_text: i.source_text,
    ...(i.instruction_ru ? { instruction_ru: i.instruction_ru } : {}),
    hint_words: i.hint_words || [],
    ...(checked ? { reference: i.reference } : {}),
  }));
  res.json({ id: r.id, kind: r.kind, items, answers: jparse(r.answers, null), result: jparse(r.result, null) });
}));

export default router;
