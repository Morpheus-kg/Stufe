// Речь: расшифровка (Whisper через Groq), задания и оценка (M8c) с изоляцией по user_id
import express from 'express';
import { ApiError, asyncHandler, sendError } from '../errors.js';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc, toSql } from '../time.js';
import { chatJSON, chatAudioJSON } from '../ai/llm.js';
import { logActivity } from '../activities.js';
import {
  PRON_NOTE, SPEAKING_TOPICS, SpeakingEvalAISchema, SpeakingAudioEvalAISchema, SpeakingEvaluateReq, SpeakingPromptAISchema,
  SpeakingPromptReq, DiscussionStartAISchema, DiscussionTurnAISchema, DiscussionFinishAISchema,
  DiscussionStartReq, DiscussionTurnReq, DiscussionFinishReq,
  cleanLine, countWords, displayCard, findUsedTargets, loadPromptText,
  parseOrBadRequest, pickFrom, scoreFromCriteria, wrapUserData,
} from '../ai/schemas_v2c.js';

export const mountPath = '/api/speaking';
const router = express.Router();

export const __deps = {
  query,
  chatJSON,
  chatAudioJSON,
  logActivity,
  fetch: (...a) => globalThis.fetch(...a),
  now: () => nowUtc(),
  random: Math.random,
};

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave'];
const EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav' };
const MIN_AUDIO_BYTES = 100;

const baseMime = (h) => String(h || '').split(';')[0].trim().toLowerCase();

function capFor(feature) {
  const raw = Number.parseInt(process.env[`AI_DAILY_CAP_${feature.toUpperCase()}`] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 100;
}

async function assertCap(feature, day, userId, aiMode) {
  if (aiMode === 'off') {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ отключён администратором');
  }
  if (aiMode === 'own') return;

  const rows = await __deps.query(
    'SELECT COALESCE(SUM(calls - failures), 0) AS calls FROM ai_usage WHERE user_id = ? AND day = ? AND feature = ?',
    [userId, day, feature],
  );
  const used = Number(rows?.[0]?.calls) || 0;
  if (used >= capFor(feature)) {
    throw new ApiError(429, 'AI_CAP', 'Дневной лимит распознавания речи исчерпан. Попробуй завтра или выбери распознавание в браузере.');
  }

  const globalCapRaw = Number.parseInt(process.env[`AI_GLOBAL_CAP_${feature.toUpperCase()}`] ?? '', 10);
  if (Number.isFinite(globalCapRaw) && globalCapRaw >= 0) {
    const gRows = await __deps.query(
      'SELECT COALESCE(SUM(calls - failures), 0) AS calls FROM ai_usage WHERE day = ? AND feature = ? /* scope-ok: global cap */',
      [day, feature],
    );
    if ((Number(gRows?.[0]?.calls) || 0) >= globalCapRaw) {
      throw new ApiError(429, 'AI_CAP', 'Общий дневной лимит распознавания речи исчерпан. Попробуйте завтра.');
    }
  }
}

async function countUsage(day, provider, feature, failed, userId) {
  const f = failed ? 1 : 0;
  try {
    await __deps.query(
      'INSERT INTO ai_usage (day, user_id, provider, feature, calls, failures) VALUES (?, ?, ?, ?, 1, ?) ON DUPLICATE KEY UPDATE calls = calls + 1, failures = failures + ?',
      [day, userId, provider, feature, f, f],
    );
  } catch {
    console.warn('[speaking] не удалось записать ai_usage');
  }
}

async function callWhisper(buf, mime, key) {
  const model = process.env.GROQ_MODEL_STT || 'whisper-large-v3-turbo';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `audio.${EXT[mime] || 'webm'}`);
  form.append('model', model);
  form.append('language', 'de');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  let resp;
  try {
    resp = await __deps.fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Сервис распознавания речи не ответил. Попробуй ещё раз или выбери распознавание в браузере.');
  }
  if (!resp || !resp.ok) {
    console.warn('[speaking] whisper HTTP', resp?.status);
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Сервис распознавания речи сейчас недоступен. Попробуй позже или выбери распознавание в браузере.');
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Сервис распознавания речи вернул неверный ответ. Попробуй ещё раз.');
  }
  return typeof data?.text === 'string' ? data.text.trim().slice(0, 4000) : '';
}

router.post(
  '/transcribe',
  express.raw({ type: AUDIO_TYPES, limit: '10mb' }),
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 1;
    const aiMode = req.user?.ai_mode ?? 'shared';
    const mime = baseMime(req.headers['content-type']);
    const body = req.body;
    if (!AUDIO_TYPES.includes(mime) || !Buffer.isBuffer(body) || body.length < MIN_AUDIO_BYTES) {
      throw new ApiError(400, 'BAD_REQUEST', 'Нужна аудиозапись (audio/webm, audio/mp4, audio/ogg или audio/wav).');
    }
    const rawDur = Number.parseFloat(String(req.headers['x-duration-s'] ?? ''));
    const durationS = Number.isFinite(rawDur) ? Math.min(3600, Math.max(0, Math.round(rawDur))) : 0;

    const key = process.env.GROQ_KEY;
    if (!key) {
      throw new ApiError(503, 'AI_UNAVAILABLE', 'Распознавание речи на сервере недоступно: не задан ключ Groq. Выбери распознавание в браузере.');
    }
    const day = localDay(__deps.now());
    await assertCap('speak', day, userId, aiMode);

    let failed = true;
    let transcript = '';
    try {
      transcript = await callWhisper(body, mime, key);
      failed = false;
    } finally {
      await countUsage(day, 'groq', 'speak', failed, userId);
    }
    res.json({ transcript, engine: 'whisper', duration_s: durationS });
  }),
);

const usableSentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length >= 10 && t.length <= 180 ? t : null;
};

async function pickShadowSentences(userId) {
  const nowSql = toSql(__deps.now());
  const collect = (rows) => {
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const s = usableSentence(r?.example);
      if (s) out.push({ id: r.id, text: s });
    }
    return out;
  };
  let cands = collect(await __deps.query(
    `SELECT c.id, c.example, MIN(s.due) AS first_due FROM cards c JOIN card_state s ON s.card_id = c.id
     WHERE c.user_id = ? AND s.user_id = ? AND c.active = 1 AND c.example IS NOT NULL AND c.example <> '' AND s.due <= ?
     GROUP BY c.id, c.example ORDER BY first_due ASC LIMIT 15`,
    [userId, userId, nowSql],
  ));
  if (!cands.length) {
    cands = collect(await __deps.query(
      "SELECT id, example FROM cards WHERE user_id = ? AND active = 1 AND example IS NOT NULL AND example <> '' ORDER BY id DESC LIMIT 15",
      [userId],
    ));
  }
  const picked = [];
  let total = 0;
  for (const c of cands) {
    if (picked.length >= 2) break;
    if (picked.length && total + c.text.length > 240) continue;
    picked.push(c);
    total += c.text.length;
  }
  return picked;
}

async function pickTargetCards(userId) {
  const nowSql = toSql(__deps.now());
  const out = [];
  const seen = new Set();
  const add = (rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (out.length >= 3) break;
      if (!r || seen.has(r.id) || !r.term) continue;
      seen.add(r.id);
      out.push({ id: r.id, term: r.term, article: r.article ?? null });
    }
  };
  add(await __deps.query(
    `SELECT c.id, c.term, c.article FROM cards c JOIN card_state s ON s.card_id = c.id
     WHERE c.user_id = ? AND s.user_id = ? AND c.active = 1 AND (s.due <= ? OR s.lapses > 0)
     GROUP BY c.id, c.term, c.article ORDER BY MIN(s.due) ASC LIMIT 3`,
    [userId, userId, nowSql],
  ));
  if (out.length < 3) {
    add(await __deps.query('SELECT id, term, article FROM cards WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 6', [userId]));
  }
  return out;
}

router.post('/prompt', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const body = parseOrBadRequest(SpeakingPromptReq, req.body);

  if (body.kind === 'shadow') {
    const picked = await pickShadowSentences(userId);
    if (!picked.length) {
      throw new ApiError(404, 'NOT_FOUND', 'Нет карточек с примерами для повторения вслух. Добавь слова с примерами.');
    }
    const expected = picked.map((p) => p.text).join(' ');
    return res.json({
      kind: 'shadow',
      prompt_ru: 'Послушай и повтори вслух как можно точнее:',
      prompt_de: expected,
      expected,
      target_card_ids: picked.map((p) => p.id),
      time_limit_s: 60,
    });
  }

  const topic = cleanLine(body.topic, 60) || pickFrom(SPEAKING_TOPICS, __deps.random);
  const format = Number(__deps.random()) < 0.5 ? 'talk' : 'discussion';
  const targets = await pickTargetCards(userId);
  const user = [
    `FORMAT: ${format}`,
    `LEVEL: ${body.level}`,
    wrapUserData('TOPIC', topic, 200),
    wrapUserData('TARGET_WORDS', targets.map(displayCard).join(', ') || '(none)', 300),
  ].join('\n');
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
  const { data } = await __deps.chatJSON({
    userId,
    feature: 'speak',
    tier: 'fast',
    system: loadPromptText('speaking_prompt.txt'),
    user,
    schema: SpeakingPromptAISchema,
    temperature: 0.7,
    maxTokens: 700,
    ...(prefer ? { preferProvider: prefer } : {}),
  });
  const words = targets.length ? `\n\nПопробуй использовать слова: ${targets.map(displayCard).join(', ')}.` : '';
  res.json({
    kind: 'free',
    prompt_ru: `${data.prompt_ru}${words}`,
    prompt_de: data.prompt_de,
    expected: null,
    target_card_ids: targets.map((t) => t.id),
    time_limit_s: 120,
  });
}));

async function loadCards(ids, userId) {
  const list = Array.isArray(ids) ? [...new Set(ids)].slice(0, 8) : [];
  if (!list.length) return [];
  const rows = await __deps.query(
    `SELECT id, term, article, plural, cloze_answer FROM cards WHERE user_id = ? AND id IN (${list.map(() => '?').join(',')})`,
    [userId, ...list],
  );
  return Array.isArray(rows) ? rows : [];
}

router.post('/evaluate', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const body = parseOrBadRequest(SpeakingEvaluateReq, req.body);
  const transcript = body.transcript.trim();
  if (!transcript) {
    throw new ApiError(400, 'BAD_REQUEST', 'Расшифровка пустая: речь не распознана. Попробуй записать ещё раз.');
  }
  const durationS = body.duration_s ?? 0;
  const cards = await loadCards(body.target_card_ids, userId);
  const used = findUsedTargets(transcript, cards);

  const user = [
    `DURATION_S: ${durationS}`,
    `WORDS: ${countWords(transcript)}`,
    wrapUserData('TASK', body.prompt, 2000),
    wrapUserData('TARGET_WORDS', cards.map(displayCard).join(', ') || '(none)', 300),
    wrapUserData('TRANSCRIPT', transcript, 4000),
  ].join('\n');
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
  const { data } = await __deps.chatJSON({
    userId,
    feature: 'speak',
    tier: 'strong',
    system: loadPromptText('speaking_eval.txt'),
    user,
    schema: SpeakingEvalAISchema,
    temperature: 0.2,
    maxTokens: 900,
    ...(prefer ? { preferProvider: prefer } : {}),
  });
  const result = {
    score: scoreFromCriteria(data.criteria),
    criteria: data.criteria,
    strengths_ru: data.strengths_ru,
    improvements_ru: data.improvements_ru,
    used_target_words: used,
    corrected_sample: data.corrected_sample,
    note_ru: [data.note_ru, PRON_NOTE].filter(Boolean).join(' '),
  };

  const day = localDay(__deps.now());
  const saved = await __deps.query(
    `INSERT INTO speaking_attempts (user_id, kind, prompt, expected, transcript, engine, duration_s, result, score, local_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, body.kind, body.prompt, null, transcript, body.engine.slice(0, 20),
      durationS, JSON.stringify(result), result.score, day],
  );
  try {
    await __deps.logActivity({ kind: 'speaking', refId: saved?.insertId ?? null, seconds: durationS, score: result.score, userId });
  } catch {
    console.warn('[speaking] не удалось записать активность');
  }
  res.json(result);
}));

const AUDIO_EVAL_SYSTEM = `You are a certified Goethe-Zertifikat B2/C1 German speaking examiner evaluating a Russian-speaking learner directly from their recorded audio.
Listen carefully to the audio and return ONLY a JSON object with:
- "transcript": exact German transcription of what the speaker said
- "criteria": {"content":0..5,"vocabulary":0..5,"grammar":0..5,"coherence":0..5,"pronunciation":0..5}
- "wpm": estimated words per minute (integer)
- "fluency_ru": 1-2 sentences in Russian on speech tempo, pauses, hesitation and sentence intonation
- "pronunciation_ru": 1-2 sentences in Russian on German phonetics (Umlaute ä/ö/ü, vowel length, ich/ach-Laut, -ig, word stress)
- "strengths_ru": up to 3 short strengths in Russian
- "improvements_ru": up to 3 actionable improvements in Russian
- "corrected_sample": improved natural B2/C1 version of the user's monologue in German
- "note_ru": brief concluding examiner note in Russian`;

router.post(
  '/evaluate-audio',
  express.raw({ type: AUDIO_TYPES, limit: '10mb' }),
  asyncHandler(async (req, res) => {
    const userId = req.user?.id ?? 1;
    const mime = baseMime(req.headers['content-type']);
    const body = req.body;
    if (!AUDIO_TYPES.includes(mime) || !Buffer.isBuffer(body) || body.length < MIN_AUDIO_BYTES) {
      throw new ApiError(400, 'BAD_REQUEST', 'Нужна аудиозапись (audio/webm, audio/mp4, audio/ogg или audio/wav).');
    }
    const rawDur = Number.parseFloat(String(req.headers['x-duration-s'] ?? ''));
    const durationS = Number.isFinite(rawDur) ? Math.min(3600, Math.max(0, Math.round(rawDur))) : 0;
    let promptText = '';
    try {
      promptText = decodeURIComponent(String(req.headers['x-prompt'] ?? '')).trim().slice(0, 2000);
    } catch {
      promptText = String(req.headers['x-prompt'] ?? '').trim().slice(0, 2000);
    }
    if (!promptText) promptText = 'Freier Monolog (B2)';
    const rawCardIds = String(req.headers['x-target-cards'] ?? '')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isInteger(x) && x > 0)
      .slice(0, 8);
    const cards = await loadCards(rawCardIds, userId);

    const userMsg = [
      `DURATION_S: ${durationS}`,
      wrapUserData('TASK', promptText, 2000),
      wrapUserData('TARGET_WORDS', cards.map(displayCard).join(', ') || '(none)', 300),
    ].join('\n');

    const { data } = await __deps.chatAudioJSON({
      userId,
      feature: 'speak',
      tier: 'strong',
      system: AUDIO_EVAL_SYSTEM,
      user: userMsg,
      audioBuffer: body,
      mimeType: mime,
      schema: SpeakingAudioEvalAISchema,
      temperature: 0.2,
      maxTokens: 1400,
    });

    const transcript = (data.transcript || '').trim();
    const used = findUsedTargets(transcript, cards);
    const computedWpm = durationS > 5 && transcript
      ? Math.round((countWords(transcript) / durationS) * 60)
      : (data.wpm ?? null);
    const result = {
      score: scoreFromCriteria(data.criteria),
      criteria: data.criteria,
      transcript,
      wpm: computedWpm,
      fluency_ru: data.fluency_ru || null,
      pronunciation_ru: data.pronunciation_ru || null,
      strengths_ru: data.strengths_ru,
      improvements_ru: data.improvements_ru,
      used_target_words: used,
      corrected_sample: data.corrected_sample,
      note_ru: data.note_ru || 'Оценка выполнена мультимодально по аудиозаписи (Gemini Audio).',
    };

    const day = localDay(__deps.now());
    const saved = await __deps.query(
      `INSERT INTO speaking_attempts (user_id, kind, prompt, expected, transcript, engine, duration_s, result, score, local_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'free', promptText, null, transcript || '(audio)', 'gemini-audio',
        durationS, JSON.stringify(result), result.score, day],
    );
    try {
      await __deps.logActivity({ kind: 'speaking', refId: saved?.insertId ?? null, seconds: durationS, score: result.score, userId });
    } catch { /* ignore */ }
    res.json(result);
  }),
);

// ---------- Интерактивный режим дискуссии (Sprechen — Diskussion, Goethe B2 Teil 2) ----------
const DISC_START_SYSTEM = `You are a speaking partner in a Goethe-Zertifikat B2 Teil 2 discussion.
Given TOPIC, LEVEL and TARGET_WORDS, adopt a clear, slightly provocative stance so the learner has to argue and respond.
Return ONLY JSON:
{"persona_ru":"Краткое описание роли собеседника на русском (1 предложение)","opening_de":"Естественная первая реплика собеседника по-немецки (2-3 предложения с вопросом к ученику в конце)","opening_ru":"Перевод первой реплики на русский","suggested_redemittel":["3-4 подходящие немецкие фразы Redemittel для ответа"]}`;

const DISC_TURN_SYSTEM = `You are a German discussion partner in a Goethe-Zertifikat B2 Teil 2 dialogue.
Continue the discussion naturally in 2-3 sentences: react to the learner's argument, introduce a counter-argument or follow-up question, and keep the debate lively.
Also provide a brief grammatical/lexical micro-correction of the learner's last turn if needed.
Return ONLY JSON:
{"reply_de":"Ответ собеседника по-немецки (2-3 предложения + вопрос)","reply_ru":"Перевод ответа на русский","micro_fix_de":"Исправленный вариант реплики ученика по-немецки (или пусто, если всё отлично)","micro_fix_ru":"Краткий комментарий по ошибке на русском (или пусто)","suggested_redemittel":["2-3 фразы Redemittel для следующего хода"]}`;

const DISC_FINISH_SYSTEM = `You are a Goethe-Zertifikat B2 examiner evaluating a multi-turn discussion between a learner ("user") and an interlocutor ("assistant").
Evaluate the learner's turns on 0..5 criteria: argumentation, interaction, vocabulary, grammar.
Return ONLY JSON:
{"criteria":{"argumentation":0..5,"interaction":0..5,"vocabulary":0..5,"grammar":0..5},"used_redemittel":["использованные учеником речевые клише"],"strengths_ru":["до 3 сильных сторон на русском"],"improvements_ru":["до 3 рекомендаций на русском"],"summary_ru":"Краткий итог дискуссии на русском"}`;

router.post('/discussion/start', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const body = parseOrBadRequest(DiscussionStartReq, req.body);
  const topic = cleanLine(body.topic, 80) || pickFrom(SPEAKING_TOPICS, __deps.random);
  const targets = await pickTargetCards(userId);
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;

  const user = [
    `LEVEL: ${body.level}`,
    wrapUserData('TOPIC', topic, 200),
    wrapUserData('TARGET_WORDS', targets.map(displayCard).join(', ') || '(none)', 300),
  ].join('\n');

  const { data } = await __deps.chatJSON({
    userId,
    feature: 'speak',
    tier: 'fast',
    system: DISC_START_SYSTEM,
    user,
    schema: DiscussionStartAISchema,
    temperature: 0.7,
    maxTokens: 700,
    ...(prefer ? { preferProvider: prefer } : {}),
  });

  const turns = [{ role: 'assistant', text_de: data.opening_de, text_ru: data.opening_ru }];
  const day = localDay(__deps.now());
  const ins = await __deps.query(
    `INSERT INTO speaking_sessions (user_id, topic, level, persona, target_card_ids, turns_json, status, local_day)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [userId, topic, body.level, data.persona_ru, JSON.stringify(targets.map((t) => t.id)), JSON.stringify(turns), day],
  );
  res.json({
    session_id: ins?.insertId ?? 1,
    topic,
    level: body.level,
    persona_ru: data.persona_ru,
    target_words: targets.map(displayCard),
    turns,
    suggested_redemittel: data.suggested_redemittel,
  });
}));

router.post('/discussion/:id/turn', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const sessionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new ApiError(404, 'NOT_FOUND', 'Сессия не найдена.');
  const body = parseOrBadRequest(DiscussionTurnReq, req.body);

  const rows = await __deps.query(
    'SELECT * FROM speaking_sessions WHERE id = ? AND user_id = ? LIMIT 1',
    [sessionId, userId],
  );
  const sess = rows?.[0];
  if (!sess) throw new ApiError(404, 'NOT_FOUND', 'Сессия дискуссии не найдена.');
  if (sess.status === 'finished') throw new ApiError(400, 'BAD_REQUEST', 'Дискуссия уже завершена.');

  let turns = [];
  try { turns = JSON.parse(sess.turns_json || '[]'); } catch { turns = []; }
  turns.push({ role: 'user', text_de: body.text });

  const historyText = turns.map((t) => `${t.role === 'user' ? 'LEARNER' : 'PARTNER'}: ${t.text_de}`).join('\n');
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
  const { data } = await __deps.chatJSON({
    userId,
    feature: 'speak',
    tier: 'fast',
    system: DISC_TURN_SYSTEM,
    user: [
      `LEVEL: ${sess.level}`,
      wrapUserData('TOPIC', sess.topic, 200),
      wrapUserData('DIALOGUE', historyText, 4000),
    ].join('\n'),
    schema: DiscussionTurnAISchema,
    temperature: 0.6,
    maxTokens: 700,
    ...(prefer ? { preferProvider: prefer } : {}),
  });

  turns[turns.length - 1].micro_fix_de = data.micro_fix_de || '';
  turns[turns.length - 1].micro_fix_ru = data.micro_fix_ru || '';
  turns.push({ role: 'assistant', text_de: data.reply_de, text_ru: data.reply_ru });

  await __deps.query(
    'UPDATE speaking_sessions SET turns_json = ? WHERE id = ? AND user_id = ?',
    [JSON.stringify(turns), sessionId, userId],
  );

  const userTurnCount = turns.filter((t) => t.role === 'user').length;
  res.json({
    session_id: sessionId,
    reply_de: data.reply_de,
    reply_ru: data.reply_ru,
    micro_fix_de: data.micro_fix_de,
    micro_fix_ru: data.micro_fix_ru,
    suggested_redemittel: data.suggested_redemittel,
    user_turns: userTurnCount,
    can_finish: userTurnCount >= 2,
    turns,
  });
}));

router.post('/discussion/:id/finish', asyncHandler(async (req, res) => {
  const userId = req.user?.id ?? 1;
  const sessionId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw new ApiError(404, 'NOT_FOUND', 'Сессия не найдена.');
  const body = parseOrBadRequest(DiscussionFinishReq, req.body);

  const rows = await __deps.query(
    'SELECT * FROM speaking_sessions WHERE id = ? AND user_id = ? LIMIT 1',
    [sessionId, userId],
  );
  const sess = rows?.[0];
  if (!sess) throw new ApiError(404, 'NOT_FOUND', 'Сессия дискуссии не найдена.');

  let turns = [];
  try { turns = JSON.parse(sess.turns_json || '[]'); } catch { turns = []; }
  const userTurns = turns.filter((t) => t.role === 'user');
  if (!userTurns.length) throw new ApiError(400, 'BAD_REQUEST', 'Сначала ответьте хотя бы на одну реплику собеседника.');

  let targetIds = [];
  try { targetIds = JSON.parse(sess.target_card_ids || '[]'); } catch { targetIds = []; }
  const cards = await loadCards(targetIds, userId);
  const allUserText = userTurns.map((t) => t.text_de).join(' ');
  const usedTargets = findUsedTargets(allUserText, cards);

  const historyText = turns.map((t) => `${t.role === 'user' ? 'LEARNER' : 'PARTNER'}: ${t.text_de}`).join('\n');
  const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
  const { data } = await __deps.chatJSON({
    userId,
    feature: 'speak',
    tier: 'strong',
    system: DISC_FINISH_SYSTEM,
    user: [
      `LEVEL: ${sess.level}`,
      wrapUserData('TOPIC', sess.topic, 200),
      wrapUserData('DIALOGUE', historyText, 4500),
    ].join('\n'),
    schema: DiscussionFinishAISchema,
    temperature: 0.2,
    maxTokens: 900,
    ...(prefer ? { preferProvider: prefer } : {}),
  });

  const score = scoreFromCriteria(data.criteria);
  const result = {
    score,
    criteria: data.criteria,
    used_redemittel: data.used_redemittel,
    used_target_words: usedTargets,
    strengths_ru: data.strengths_ru,
    improvements_ru: data.improvements_ru,
    summary_ru: data.summary_ru,
  };

  await __deps.query(
    "UPDATE speaking_sessions SET status = 'finished', feedback_json = ?, score = ? WHERE id = ? AND user_id = ?",
    [JSON.stringify(result), score, sessionId, userId],
  );
  try {
    await __deps.logActivity({ kind: 'speaking', refId: sessionId, seconds: body.duration_s ?? 120, score, userId });
  } catch { /* ignore */ }

  res.json(result);
}));

router.use((err, req, res, next) => {
  if (err && typeof err.type === 'string' && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const msg = err.type === 'entity.too.large' ? 'Запись слишком большая (максимум 10 МБ).' : 'Не удалось прочитать запрос.';
    return sendError(res, err.status, 'BAD_REQUEST', msg);
  }
  return next(err);
});

export default router;
