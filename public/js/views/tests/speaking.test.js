// Тесты M8c: мок ИИ, мок fetch к Whisper, без сети и без MySQL
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import speakingRouter, { __deps as sp, mountPath as spMount } from '../server/routes/speaking.js';
import writingRouter, { __deps as wr, mountPath as wrMount } from '../server/routes/writing.js';
import { ApiError } from '../server/errors.js';
import {
  PRON_NOTE, countWords, findUsedTargets, scoreFromCriteria, cleanErrors,
} from '../server/ai/schemas_v2c.js';

const savedEnv = {
  GROQ_KEY: process.env.GROQ_KEY,
  GROQ_MODEL_STT: process.env.GROQ_MODEL_STT,
  AI_DAILY_CAP_SPEAK: process.env.AI_DAILY_CAP_SPEAK,
};
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---------- фейковая БД ----------
function makeDb(opts = {}) {
  const st = {
    usageCalls: opts.usageCalls ?? 0,
    usageWrites: [],
    attempts: [],
    writingAttempts: [],
    tasks: new Map(),
    nextTask: 1,
    activities: [],
  };
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.includes('FROM ai_usage')) return [{ calls: st.usageCalls }];
    if (s.startsWith('INSERT INTO ai_usage')) {
      const day = params[0];
      const provider = params[2];
      const feature = params[3];
      const failed = params[4];
      st.usageWrites.push([day, provider, feature, failed, failed]);
      return { affectedRows: 1 };
    }
    if (s.includes('JOIN card_state') && s.includes('c.example')) return opts.dueExamples ?? [];
    if (s.includes('JOIN card_state') && s.includes('c.term')) return opts.dueTargets ?? [];
    if (s.startsWith('SELECT id, example FROM cards')) return opts.fallbackExamples ?? [];
    if (s.includes('FROM cards') && s.includes('active') && s.includes('term, article')) return opts.fallbackTargets ?? [];
    if (s.includes('FROM cards') && s.includes('id IN')) {
      return (opts.cards ?? []).filter((c) => params.includes(c.id));
    }
    if (s.startsWith('INSERT INTO speaking_attempts')) {
      const p = typeof params[0] === 'number' ? params.slice(1) : params;
      st.attempts.push(p);
      return { insertId: st.attempts.length, affectedRows: 1 };
    }
    if (s.startsWith('INSERT INTO writing_tasks')) {
      const id = st.nextTask++;
      const p = typeof params[0] === 'number' ? params.slice(1) : params;
      st.tasks.set(id, { id, task_type: p[0], topic: p[1], prompt_de: p[2], key_points: p[3], min_words: p[4], attempt_id: null });
      return { insertId: id, affectedRows: 1 };
    }
    if (s.startsWith('SELECT id, task_type, topic, prompt_de, key_points, min_words, attempt_id FROM writing_tasks')) {
      const t = st.tasks.get(params[0]);
      return t ? [{ ...t }] : [];
    }
    if (s.startsWith('UPDATE writing_tasks SET attempt_id = 0')) {
      const t = st.tasks.get(params[0]);
      if (t && t.attempt_id === null) { t.attempt_id = 0; return { affectedRows: 1 }; }
      return { affectedRows: 0 };
    }
    if (s.startsWith('UPDATE writing_tasks SET attempt_id = NULL')) {
      const t = st.tasks.get(params[0]);
      if (t && t.attempt_id === 0) { t.attempt_id = null; return { affectedRows: 1 }; }
      return { affectedRows: 0 };
    }
    if (s.startsWith('UPDATE writing_tasks SET attempt_id = ?')) {
      const t = st.tasks.get(params[1]);
      if (t) t.attempt_id = params[0];
      return { affectedRows: t ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO writing_attempts')) { st.writingAttempts.push(params); return { insertId: st.writingAttempts.length, affectedRows: 1 }; }
    throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
  };
  return { st, query };
}

const noAi = async () => { throw new Error('AI must not be called'); };

function install(db) {
  for (const d of [sp, wr]) {
    d.query = db.query;
    d.logActivity = async (a) => { db.st.activities.push(a); };
    d.chatJSON = noAi;
    d.random = () => 0;
  }
  sp.fetch = async () => { throw new Error('fetch must not be called'); };
}

// Мок chatJSON: как настоящий, валидирует ответ схемой запроса
function mockAi(calls, raw, provider = 'groq') {
  return async (opts) => {
    calls.push(opts);
    return { data: opts.schema.parse(raw), provider, cached: false };
  };
}

import { Readable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';

const realFetch = globalThis.fetch;

async function invokeApp(app, urlStr, init = {}) {
  const u = new URL(urlStr);
  const method = (init.method || 'GET').toUpperCase();
  const headers = {};
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) headers[k.toLowerCase()] = String(v);
  }
  const bodyBuf = init.body == null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
  if (bodyBuf.length && !headers['content-length']) {
    headers['content-length'] = String(bodyBuf.length);
  }

  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from(bodyBuf.length ? [bodyBuf] : []), {
      method,
      url: u.pathname + u.search,
      originalUrl: u.pathname + u.search,
      headers,
      connection: {},
      socket: {},
      get(name) { return this.headers[String(name).toLowerCase()]; },
      header(name) { return this.headers[String(name).toLowerCase()]; },
    });
    Object.setPrototypeOf(req, IncomingMessage.prototype);

    const chunks = [];
    const resHeaders = new Map();
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(k, v) { resHeaders.set(String(k).toLowerCase(), v); return this; },
      getHeader(k) { return resHeaders.get(String(k).toLowerCase()); },
      removeHeader(k) { resHeaders.delete(String(k).toLowerCase()); },
      writeHead(code, h) {
        this.statusCode = code;
        if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
        return this;
      },
      write(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return true;
      },
      end(chunk) {
        if (chunk) this.write(chunk);
        this.headersSent = true;
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: this.statusCode,
          ok: this.statusCode >= 200 && this.statusCode < 300,
          headers: { get: (k) => resHeaders.get(String(k).toLowerCase()) ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      },
    };
    Object.setPrototypeOf(res, ServerResponse.prototype);
    try {
      app.handle(req, res, (err) => { if (err) reject(err); });
    } catch (e) {
      reject(e);
    }
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(spMount, speakingRouter);
  app.use(wrMount, writingRouter);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err?.status ?? err?.statusCode ?? 500;
    res.status(status).json({ error: { code: err?.code ?? 'INTERNAL', message: String(err?.message ?? '') } });
  });
  const base = 'http://127.0.0.1:0';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return invokeApp(app, String(url), init);
    return realFetch(url, init);
  };
  const stop = async () => { globalThis.fetch = realFetch; };
  return { base, stop };
}

const postJson = (base, path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ---------- чистые функции ----------
test('чистые функции: слова, балл, использованные слова, ошибки', () => {
  assert.equal(countWords('Das ist ein Test.'), 4);
  assert.equal(countWords(''), 0);
  assert.equal(scoreFromCriteria({ a: 5, b: 5, c: 5, d: 5 }), 100);
  assert.equal(scoreFromCriteria({ a: 4, b: 3, c: 3, d: 2 }), 60);
  const cards = [
    { id: 7, term: 'Umwelt', article: 'die', plural: null, cloze_answer: null },
    { id: 8, term: 'Klimawandel', article: 'der', plural: null, cloze_answer: null },
  ];
  assert.deepEqual(findUsedTargets('Ich finde die Umwelt sehr wichtig', cards), [7]);
  const errs = cleanErrors([
    { category: 'artikel', original: 'der Haus', fix: 'das Haus', explanation_ru: 'Род.' },
    { category: 'bogus', original: 'a', fix: 'b', explanation_ru: '' },
    { category: 'kasus', original: 'same', fix: 'same', explanation_ru: '' },
    { category: 'kasus', original: '', fix: 'x', explanation_ru: '' },
    null,
  ]);
  assert.equal(errs.length, 2);
  assert.equal(errs[1].category, 'sonstiges');
});

// ---------- Whisper ----------
test('transcribe: запрос к Whisper, учёт ai_usage', async () => {
  const db = makeDb(); install(db);
  process.env.GROQ_KEY = 'test-key';
  process.env.GROQ_MODEL_STT = 'stt-test-model';
  delete process.env.AI_DAILY_CAP_SPEAK;
  const calls = [];
  sp.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ text: '  Hallo Welt  ' }) };
  };
  const { base, stop } = await startServer();
  try {
    const r = await fetch(`${base}/api/speaking/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm;codecs=opus', 'X-Duration-S': '12.4' },
      body: Buffer.alloc(500, 1),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { transcript: 'Hallo Welt', engine: 'whisper', duration_s: 12 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
    assert.equal(calls[0].init.body.get('language'), 'de');
    assert.equal(calls[0].init.body.get('model'), 'stt-test-model');
    assert.equal(db.st.usageWrites.length, 1);
    assert.deepEqual(db.st.usageWrites[0].slice(1), ['groq', 'speak', 0, 0]);
  } finally { await stop(); }
});

test('transcribe: нет ключа -> 503 AI_UNAVAILABLE, без вызова fetch', async () => {
  const db = makeDb(); install(db);
  delete process.env.GROQ_KEY;
  const { base, stop } = await startServer();
  try {
    const r = await fetch(`${base}/api/speaking/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(300, 1),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'AI_UNAVAILABLE');
    assert.equal(db.st.usageWrites.length, 0);
  } finally { await stop(); }
});

test('transcribe: ошибка Whisper -> 503 и failures=1', async () => {
  const db = makeDb(); install(db);
  process.env.GROQ_KEY = 'test-key';
  sp.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { base, stop } = await startServer();
  try {
    const r = await fetch(`${base}/api/speaking/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/ogg' }, body: Buffer.alloc(300, 1),
    });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'AI_UNAVAILABLE');
    assert.deepEqual(db.st.usageWrites[0].slice(1), ['groq', 'speak', 1, 1]);
  } finally { await stop(); }
});

test('transcribe: исчерпан дневной лимит -> 429 AI_CAP', async () => {
  const db = makeDb({ usageCalls: 2 }); install(db);
  process.env.GROQ_KEY = 'test-key';
  process.env.AI_DAILY_CAP_SPEAK = '2';
  const { base, stop } = await startServer();
  try {
    const r = await fetch(`${base}/api/speaking/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(300, 1),
    });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.code, 'AI_CAP');
  } finally { delete process.env.AI_DAILY_CAP_SPEAK; await stop(); }
});

test('transcribe: не аудио и слишком короткая запись -> 400', async () => {
  const db = makeDb(); install(db);
  process.env.GROQ_KEY = 'test-key';
  const { base, stop } = await startServer();
  try {
    const a = await postJson(base, '/api/speaking/transcribe', { x: 1 });
    assert.equal(a.status, 400);
    const b = await fetch(`${base}/api/speaking/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(10, 1),
    });
    assert.equal(b.status, 400);
  } finally { await stop(); }
});

// ---------- оценка речи ----------
test('shadow: отправка на серверную оценку отклоняется (400 BAD_REQUEST)', async () => {
  const db = makeDb(); install(db);
  const { base, stop } = await startServer();
  try {
    const res = await postJson(base, '/api/speaking/evaluate', {
      kind: 'shadow', prompt: 'Повтори', expected: 'Ich habe gestern einen Film gesehen.',
      transcript: 'ich habe gestern einen film gesehen', duration_s: 5, engine: 'browser',
    });
    assert.equal(res.status, 400);
    assert.equal(db.st.attempts.length, 0);
  } finally { await stop(); }
});

test('evaluate: пустая расшифровка -> 400 с русским сообщением; shadow без образца -> 400', async () => {
  const db = makeDb(); install(db);
  const { base, stop } = await startServer();
  try {
    const r = await postJson(base, '/api/speaking/evaluate', {
      kind: 'free', prompt: 'Тема', transcript: '   ', duration_s: 3, engine: 'browser',
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /[А-Яа-я]/);
    const r2 = await postJson(base, '/api/speaking/evaluate', {
      kind: 'shadow', prompt: 'Повтори', transcript: 'Hallo', duration_s: 3, engine: 'browser',
    });
    assert.equal(r2.status, 400);
    assert.equal(db.st.attempts.length, 0);
  } finally { await stop(); }
});

test('free: оценка ИИ, балл и использованные слова считает код', async () => {
  const db = makeDb({
    cards: [
      { id: 7, term: 'Umwelt', article: 'die', plural: null, cloze_answer: null },
      { id: 8, term: 'Klimawandel', article: 'der', plural: null, cloze_answer: null },
    ],
  });
  install(db);
  const aiCalls = [];
  sp.chatJSON = mockAi(aiCalls, {
    criteria: { content: 4, vocabulary: 3, grammar: 3, coherence: 2 },
    strengths_ru: ['Хорошо'], improvements_ru: ['Больше связок'],
    corrected_sample: 'Ich finde die Umwelt wichtig.', note_ru: '',
  });
  const { base, stop } = await startServer();
  try {
    const r = await postJson(base, '/api/speaking/evaluate', {
      kind: 'free', prompt: 'Sprechen Sie über Umwelt', transcript: 'Ich finde die Umwelt sehr wichtig',
      duration_s: 30, engine: 'browser', target_card_ids: [7, 8],
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.score, 60);
    assert.deepEqual(j.used_target_words, [7]);
    assert.ok(j.note_ru.endsWith(PRON_NOTE));
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].feature, 'speak');
    assert.equal(aiCalls[0].tier, 'strong');
    assert.equal(db.st.attempts[0][0], 'free');
    assert.equal(db.st.attempts[0][7], 60);
    assert.equal(db.st.activities[0].score, 60);
  } finally { await stop(); }
});

// ---------- задания речи ----------
test('prompt shadow: примеры карточек, без ИИ', async () => {
  const db = makeDb({
    dueExamples: [
      { id: 1, example: 'Ich habe gestern einen Film gesehen.', first_due: 'x' },
      { id: 2, example: 'Kurz.', first_due: 'x' },
      { id: 3, example: 'Wir fahren morgen nach Berlin und besuchen dort Freunde.', first_due: 'x' },
    ],
  });
  install(db);
  const { base, stop } = await startServer();
  try {
    const r = await postJson(base, '/api/speaking/prompt', { kind: 'shadow' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.kind, 'shadow');
    assert.deepEqual(j.target_card_ids, [1, 3]);
    assert.equal(j.expected, 'Ich habe gestern einen Film gesehen. Wir fahren morgen nach Berlin und besuchen dort Freunde.');
  } finally { await stop(); }
});

test('prompt shadow: нет карточек -> 404', async () => {
  const db = makeDb(); install(db);
  const { base, stop } = await startServer();
  try {
    const r = await postJson(base, '/api/speaking/prompt', { kind: 'shadow' });
    assert.equal(r.status, 404);
  } finally { await stop(); }
});

test('prompt free: один вызов ИИ, слова выбирает код', async () => {
  const db = makeDb({
    dueTargets: [{ id: 3, term: 'Umwelt', article: 'die' }, { id: 4, term: 'laufen', article: null }],
    fallbackTargets: [{ id: 5, term: 'Haus', article: 'das' }, { id: 3, term: 'Umwelt', article: 'die' }],
  });
  install(db);
  const aiCalls = [];
  sp.chatJSON = mockAi(aiCalls, { prompt_ru: 'Расскажи об экологии.', prompt_de: 'Sie halten einen Vortrag über Umwelt.' });
  const { base, stop } = await startServer();
  try {
    const r = await postJson(base, '/api/speaking/prompt', { kind: 'free', topic: 'Umwelt' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.kind, 'free');
    assert.equal(j.expected, null);
    assert.equal(j.time_limit_s, 120);
    assert.deepEqual(j.target_card_ids, [3, 4, 5]);
    assert.ok(j.prompt_ru.includes('die Umwelt'));
    assert.equal(aiCalls.length, 1);
    assert.equal(aiCalls[0].tier, 'fast');
    assert.ok(aiCalls[0].user.includes('<<<TOPIC'));
  } finally { await stop(); }
});

// ---------- письмо ----------
test('writing: задание, оценка один раз, повтор -> 409', async () => {
  const db = makeDb(); install(db);
  const aiCalls = [];
  wr.chatJSON = async (opts) => {
    aiCalls.push(opts);
    const raw = opts.feature === 'write' && opts.tier === 'fast'
      ? { prompt_de: 'Schreiben Sie einen Forumsbeitrag über Umwelt.', bullets_de: ['Meinung', 'Beispiel', 'Fazit'] }
      : {
        criteria: { task: 4, coherence: 3, vocabulary: 4, grammar: 3 },
        errors: [
          { category: 'artikel', original: 'der Haus', fix: 'das Haus', explanation_ru: 'Род.' },
          { category: 'bogus', original: 'x', fix: 'y', explanation_ru: 'z' },
          { category: 'kasus', original: 'same', fix: 'same', explanation_ru: 'n' },
        ],
        corrected_text: 'Das Haus ist groß.', improvements_ru: ['Больше связок'],
      };
    return { data: opts.schema.parse(raw), provider: 'gemini', cached: false };
  };
  const { base, stop } = await startServer();
  try {
    const t = await postJson(base, '/api/writing/task', { type: 'forum', topic: 'Umwelt' });
    assert.equal(t.status, 200);
    const task = await t.json();
    assert.equal(typeof task.id, 'number');
    assert.equal(task.type, 'forum');
    assert.equal(task.min_words, 150);
    assert.equal(task.bullets_de.length, 3);

    const text = 'Ich denke, dass der Haus sehr groß ist und dass wir mehr für die Umwelt tun müssen.';
    const e1 = await postJson(base, '/api/writing/evaluate', { task_id: task.id, text, seconds: 90 });
    assert.equal(e1.status, 200);
    const res = await e1.json();
    assert.equal(res.score, 70);
    assert.equal(res.errors.length, 2);
    assert.equal(res.errors[1].category, 'sonstiges');
    assert.equal(db.st.writingAttempts.length, 1);
    assert.equal(db.st.activities[0].kind, 'writing');
    assert.equal(db.st.activities[0].seconds, 90);

    const e2 = await postJson(base, '/api/writing/evaluate', { task_id: task.id, text });
    assert.equal(e2.status, 409);
    assert.equal((await e2.json()).error.code, 'CONFLICT');
    assert.equal(aiCalls.length, 2); // 1 на задание + 1 на оценку
  } finally { await stop(); }
});

test('writing: сбой ИИ освобождает задание для повторной проверки; короткий текст -> 400', async () => {
  const db = makeDb(); install(db);
  db.st.tasks.set(1, { id: 1, task_type: 'letter_formal', topic: 'Wohnen', prompt_de: 'Schreiben Sie.', key_points: '["a"]', min_words: 120, attempt_id: null });
  db.st.nextTask = 2;
  const text = 'Sehr geehrte Damen und Herren, ich schreibe Ihnen wegen der Wohnung in der Hauptstraße.';
  wr.chatJSON = async () => { throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ недоступен.'); };
  const { base, stop } = await startServer();
  try {
    const short = await postJson(base, '/api/writing/evaluate', { task_id: 1, text: 'Zu kurz.' });
    assert.equal(short.status, 400);

    const fail = await postJson(base, '/api/writing/evaluate', { task_id: 1, text });
    assert.equal(fail.status, 503);
    assert.equal(db.st.tasks.get(1).attempt_id, null);

    wr.chatJSON = mockAi([], {
      criteria: { task: 5, coherence: 5, vocabulary: 5, grammar: 5 }, errors: [], corrected_text: '', improvements_ru: [],
    });
    const ok = await postJson(base, '/api/writing/evaluate', { task_id: 1, text });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.score, 100);
    assert.equal(j.corrected_text, text); // пустой ответ ИИ -> исходный текст

    const missing = await postJson(base, '/api/writing/evaluate', { task_id: 999, text });
    assert.equal(missing.status, 404);
  } finally { await stop(); }
});