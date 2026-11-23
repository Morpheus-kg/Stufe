// Пересказ: русский текст -> немецкий текст (M8b) с изоляцией по user_id
import express from 'express';
import { query } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc, toSql } from '../time.js';
import { chatJSON } from '../ai/llm.js';
import { loadPromptText, esc, sanitizeErrors } from '../ai/batchcheck.js';
import { recordUserErrors } from '../error_profile.js';
import {
  retellTaskRequestSchema, retellEvaluateRequestSchema, retellTaskGeneratedSchema, retellEvalSchema,
} from '../ai/schemas_v2b.js';

export const mountPath = '/api/retell';
const router = express.Router();

export const RANDOM_TOPICS = [
  'Arbeit und Bewerbung', 'Wohnen', 'Umwelt', 'Medien und Social Media', 'Gesundheit', 'Bildung', 'Reisen',
  'Konsum und Werbung', 'Integration und Gesellschaft', 'Technik', 'Freizeit', 'Familie', 'Stadt und Land',
];

async function logActivitySafe(entry) {
  try { await (await import('../activities.js')).logActivity(entry); } catch { /* не критично */ }
}
const defaultDeps = { query, chat: chatJSON, log: logActivitySafe, random: Math.random };

const jparse = (s, f) => { try { return JSON.parse(s) ?? f; } catch { return f; } };
const display = (c) => `${c.article ? `${c.article} ` : ''}${c.term}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
export const countWords = (t) => (String(t || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

export function scoreFromCriteria(c) {
  const sum = ['content', 'coherence', 'vocabulary', 'grammar'].reduce((s, k) => s + clamp(c?.[k], 0, 5), 0);
  return Math.round((sum / 20) * 100);
}

export async function createTask(body, deps = defaultDeps, userId) {
  const level = body.level || 'B2';
  const sentences = body.sentences || 7;
  let topic = body.topic;
  if (!topic || topic === 'random') topic = RANDOM_TOPICS[Math.floor(deps.random() * RANDOM_TOPICS.length) % RANDOM_TOPICS.length];

  let cards = [];
  if (body.use_due_words) {
    cards = await deps.query(
      'SELECT * FROM cards WHERE user_id = ? AND active = 1 AND id IN (SELECT card_id FROM card_state WHERE user_id = ? AND (due <= ? OR lapses > 0)) ORDER BY RAND() LIMIT 3',
      [userId, userId, toSql(nowUtc())]);
  }
  const lines = [`TOPIC: ${esc(topic)}`, `LEVEL: ${level}`, `SENTENCES: ${sentences}`, '<<<DATA'];
  if (cards.length) {
    lines.push('TARGET_WORDS:');
    for (const c of cards) lines.push(`- ${esc(display(c))}`);
  }
  lines.push('>>>DATA');
  const opts = {
    userId,
    feature: 'write', tier: 'strong', system: await loadPromptText('retell_task'), user: lines.join('\n'),
    schema: retellTaskGeneratedSchema, temperature: 0.7, maxTokens: 2000,
  };
  if (body.provider && body.provider !== 'auto') opts.preferProvider = body.provider;
  const { data, provider } = await deps.chat(opts);
  const parsed = retellTaskGeneratedSchema.safeParse(data);
  if (!parsed.success) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул неподходящее задание. Попробуйте ещё раз.');

  const prompt_ru = parsed.data.prompt_ru.trim().slice(0, 3000);
  const key_points = parsed.data.key_points.map((k) => String(k).trim().slice(0, 300)).filter(Boolean).slice(0, 6);
  const model_text = parsed.data.model_text.trim().slice(0, 4000);
  if (!key_points.length) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул неподходящее задание. Попробуйте ещё раз.');
  const min_words = sentences * 12;
  const hint_words = cards.map((c) => ({ card_id: c.id, display: display(c) }));

  const r = await deps.query(
    'INSERT INTO writing_tasks (user_id, task_type, topic, level, prompt_ru, key_points, model_text, hint_card_ids, min_words, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, 'retell', topic, level, prompt_ru, JSON.stringify(key_points), model_text, JSON.stringify(hint_words.map((h) => h.card_id)), min_words, provider || null]);
  return { id: r.insertId, topic, level, prompt_ru, hint_words, min_words };
}

export async function evaluate(body, deps = defaultDeps, userId) {
  const rows = await deps.query("SELECT * FROM writing_tasks WHERE id = ? AND user_id = ? AND task_type = 'retell'", [body.task_id, userId]);
  const task = rows[0];
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'Задание не найдено.');
  if (task.attempt_id !== null && task.attempt_id !== undefined) throw new ApiError(409, 'CONFLICT', 'Это задание уже проверено.');
  const claim = await deps.query('UPDATE writing_tasks SET attempt_id = 0 WHERE id = ? AND user_id = ? AND attempt_id IS NULL', [task.id, userId]);
  if (!claim || claim.affectedRows === 0) throw new ApiError(409, 'CONFLICT', 'Это задание уже проверено.');

  try {
    const keyPoints = jparse(task.key_points, []);
    const text = body.text.trim();
    const user = [
      'РУССКИЙ ТЕКСТ, КЛЮЧЕВЫЕ МЫСЛИ, ОБРАЗЕЦ И ТЕКСТ УЧЕНИКА:', '<<<DATA',
      `RUSSIAN_TEXT: ${esc(task.prompt_ru)}`, 'KEY_POINTS:',
      ...keyPoints.map((k, i) => `${i + 1}. ${esc(k)}`),
      `MODEL_TEXT: ${esc(task.model_text)}`, `USER_TEXT: ${esc(text)}`, '>>>DATA',
    ].join('\n');
    const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
    const { data } = await deps.chat({
      userId,
      feature: 'write', tier: 'strong', system: await loadPromptText('retell_eval'), user,
      schema: retellEvalSchema, temperature: 0.2, maxTokens: 2500,
      ...(prefer ? { preferProvider: prefer } : {}),
    });
    const p = retellEvalSchema.safeParse(data);
    if (!p.success) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул неподходящую оценку. Попробуйте ещё раз.');
    const ev = p.data;

    const criteria = {
      content: clamp(ev.criteria.content, 0, 5), coherence: clamp(ev.criteria.coherence, 0, 5),
      vocabulary: clamp(ev.criteria.vocabulary, 0, 5), grammar: clamp(ev.criteria.grammar, 0, 5),
    };
    const byN = new Map((ev.key_points || []).map((k) => [Math.round(k.n), k]));
    const improvements = (ev.improvements_ru || []).map((s) => String(s).slice(0, 300)).filter(Boolean).slice(0, 3);
    if (ev.not_german) improvements.unshift('Текст не похож на немецкий: пишите пересказ по-немецки.');
    const words = countWords(text);
    const result = {
      score: scoreFromCriteria(criteria), criteria,
      key_points: keyPoints.map((k, i) => ({
        text_ru: k, conveyed: byN.get(i + 1)?.conveyed === true, comment_ru: String(byN.get(i + 1)?.comment_ru || '').slice(0, 300),
      })),
      errors: sanitizeErrors(ev.errors),
      corrected_text: String(ev.corrected_text || '').trim().slice(0, 4000) || text,
      model_text: task.model_text || '',
      improvements_ru: improvements.slice(0, 3),
      words,
    };
    const ins = await deps.query(
      'INSERT INTO writing_attempts (user_id, task_id, task_type, prompt, text, words, seconds, result, score, local_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, task.id, 'retell', task.prompt_ru, text, words, body.seconds || 0, JSON.stringify(result), result.score, localDay(nowUtc())]);
    await deps.query('UPDATE writing_tasks SET attempt_id = ? WHERE id = ? AND user_id = ?', [ins.insertId, task.id, userId]);
    if (result.errors?.length) {
      recordUserErrors(userId, result.errors, deps.query).catch(() => {});
    }
    await deps.log({ kind: 'writing', refId: ins.insertId, seconds: body.seconds || 0, score: result.score, userId });
    return { id: ins.insertId, ...result };
  } catch (e) {
    try { await deps.query('UPDATE writing_tasks SET attempt_id = NULL WHERE id = ? AND user_id = ? AND attempt_id = 0', [task.id, userId]); } catch { /* ignore */ }
    throw e;
  }
}

router.post('/task', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(retellTaskRequestSchema, req.body || {}, 'Некорректные параметры задания.');
  res.json(await createTask(body, defaultDeps, req.user.id));
}));

router.post('/evaluate', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(retellEvaluateRequestSchema, req.body || {}, 'Текст должен быть от 30 до 3000 символов.');
  res.json(await evaluate(body, defaultDeps, req.user.id));
}));

export default router;
