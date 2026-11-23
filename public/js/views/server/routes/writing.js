// Свободное письмо: задания в стиле Goethe и оценка (M8c) с изоляцией по user_id
import express from 'express';
import { ApiError, asyncHandler } from '../errors.js';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc } from '../time.js';
import { chatJSON } from '../ai/llm.js';
import { logActivity } from '../activities.js';
import { recordUserErrors } from '../error_profile.js';
import {
  MIN_WORDS_BY_TYPE, WRITING_TOPICS, WRITING_TYPES, WritingEvalAISchema, WritingEvaluateReq,
  WritingTaskAISchema, WritingTaskReq, cleanErrors, cleanLine, countWords, loadPromptText,
  parseOrBadRequest, pickFrom, scoreFromCriteria, wrapUserData,
} from '../ai/schemas_v2c.js';

export const mountPath = '/api/writing';
const router = express.Router();

export const __deps = { query, chatJSON, logActivity, now: () => nowUtc(), random: Math.random };

router.post('/task', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const body = parseOrBadRequest(WritingTaskReq, req.body);
  const topic = cleanLine(body.topic, 80) || pickFrom(WRITING_TOPICS, __deps.random);
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
  const { data, provider } = await __deps.chatJSON({
    userId,
    feature: 'write',
    tier: 'fast',
    system: loadPromptText('writing_task.txt'),
    user: [`TYPE: ${body.type}`, wrapUserData('TOPIC', topic, 200)].join('\n'),
    schema: WritingTaskAISchema,
    temperature: 0.7,
    maxTokens: 700,
    ...(prefer ? { preferProvider: prefer } : {}),
  });
  const minWords = MIN_WORDS_BY_TYPE[body.type] ?? 120;
  const saved = await __deps.query(
    `INSERT INTO writing_tasks (user_id, task_type, topic, level, prompt_de, key_points, min_words, provider)
     VALUES (?, ?, ?, 'B2', ?, ?, ?, ?)`,
    [userId, body.type, topic, data.prompt_de, JSON.stringify(data.bullets_de), minWords, provider ? String(provider).slice(0, 30) : null],
  );
  res.json({
    id: saved?.insertId,
    type: body.type,
    prompt_de: data.prompt_de,
    bullets_de: data.bullets_de,
    min_words: minWords,
  });
}));

const parseList = (v) => {
  try {
    const a = JSON.parse(String(v ?? '[]'));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const ALREADY = 'Это задание уже проверено. Создай новое задание.';

router.post('/evaluate', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const body = parseOrBadRequest(WritingEvaluateReq, req.body);
  const text = body.text.trim();
  if (text.length < 30) {
    throw new ApiError(400, 'BAD_REQUEST', 'Текст слишком короткий: нужно не меньше 30 символов.');
  }
  const rows = await __deps.query(
    'SELECT id, task_type, topic, prompt_de, key_points, min_words, attempt_id FROM writing_tasks WHERE id = ? AND user_id = ?',
    [body.task_id, userId],
  );
  const task = Array.isArray(rows) ? rows[0] : null;
  if (!task) throw new ApiError(404, 'NOT_FOUND', 'Задание не найдено.');
  if (!WRITING_TYPES.includes(task.task_type)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Это задание на пересказ, его проверяют в разделе пересказа.');
  }
  if (task.attempt_id != null) throw new ApiError(409, 'CONFLICT', ALREADY);

  const claim = await __deps.query(
    'UPDATE writing_tasks SET attempt_id = 0 WHERE id = ? AND user_id = ? AND attempt_id IS NULL',
    [task.id, userId],
  );
  if (!claim || claim.affectedRows !== 1) throw new ApiError(409, 'CONFLICT', ALREADY);

  const release = async () => {
    try {
      await __deps.query('UPDATE writing_tasks SET attempt_id = NULL WHERE id = ? AND user_id = ? AND attempt_id = 0', [task.id, userId]);
    } catch {
      console.warn('[writing] не удалось освободить задание', task.id);
    }
  };

  try {
    const words = countWords(text);
    const minWords = Number(task.min_words) || MIN_WORDS_BY_TYPE[task.task_type] || 120;
    const bullets = parseList(task.key_points);
    const taskText = [String(task.prompt_de ?? ''), ...bullets.map((b) => `- ${b}`)].join('\n');
    const user = [
      `TYPE: ${task.task_type}`,
      `WORDS: ${words}`,
      `MIN_WORDS: ${minWords}`,
      wrapUserData('WRITING TASK', taskText, 2000),
      wrapUserData('USER TEXT', text, 3000),
    ].join('\n');
    const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
    const { data } = await __deps.chatJSON({
      userId,
      feature: 'write',
      tier: 'strong',
      system: loadPromptText('writing_eval.txt'),
      user,
      schema: WritingEvalAISchema,
      temperature: 0.2,
      maxTokens: 2500,
      ...(prefer ? { preferProvider: prefer } : {}),
    });

    const improvements = [...(data.feedback_ru ? [data.feedback_ru] : []), ...data.improvements_ru].slice(0, 3);
    const result = {
      score: scoreFromCriteria(data.criteria),
      criteria: data.criteria,
      errors: cleanErrors(data.errors),
      corrected_text: data.corrected_text || text,
      improvements_ru: improvements,
    };

    const day = localDay(__deps.now());
    const seconds = body.seconds ?? 0;
    const saved = await __deps.query(
      `INSERT INTO writing_attempts (user_id, task_id, task_type, prompt, text, words, seconds, result, score, local_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, task.id, task.task_type, taskText.slice(0, 5000), text, words, seconds, JSON.stringify(result), result.score, day],
    );
    const attemptId = saved?.insertId;
    await __deps.query('UPDATE writing_tasks SET attempt_id = ? WHERE id = ? AND user_id = ?', [attemptId, task.id, userId]);
    if (result.errors?.length) {
      recordUserErrors(userId, result.errors, __deps.query).catch(() => {});
    }
    try {
      await __deps.logActivity({ kind: 'writing', refId: attemptId ?? null, seconds, score: result.score, userId });
    } catch {
      console.warn('[writing] не удалось записать активность');
    }
    res.json(result);
  } catch (e) {
    await release();
    throw e;
  }
}));

export default router;
