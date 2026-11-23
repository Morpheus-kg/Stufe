// Тесты ИИ-модуля: fetch и БД замоканы, сеть и MySQL не нужны
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { chatJSON, getUsage, cacheKeyOf, __setDeps } from '../server/ai/llm.js';
import { describeChain } from '../server/ai/providers.js';
import { buildGenerateRequest, enrichCards, isRedemittel, makeCloze, normalizeGenerated } from '../server/ai/enrich.js';

const ENV = {
  LLM_CHAIN: 'groq,gemini',
  GROQ_KEY: 'k1', GROQ_MODEL_STRONG: 'gs', GROQ_MODEL_FAST: 'gf',
  GEMINI_KEY: 'k2', GEMINI_MODEL_STRONG: 'ms', GEMINI_MODEL_FAST: 'mf',
  AI_DAILY_CAP_CORRECT: '200', AI_DAILY_CAP_GENERATE: '40', AI_DAILY_CAP_ENRICH: '100',
};

const schema = z.object({ ok: z.boolean() });
const DAY = '2026-10-31';

// Мини-БД в памяти: только запросы, которые делает модуль
function makeDb({ cards = [], usage = [] } = {}) {
  const st = { cache: new Map(), usage, cards };
  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT response FROM ai_cache')) {
      const r = st.cache.get(params[0]);
      return r ? [{ response: r }] : [];
    }
    if (s.startsWith('INSERT INTO ai_cache')) {
      st.cache.set(params[0], params[2]);
      return { affectedRows: 1 };
    }
    if (s.startsWith('SELECT COALESCE(SUM(calls - failures)')) {
      const n = st.usage
        .filter((u) => u.day === params[0] && u.feature === params[1])
        .reduce((a, u) => a + u.calls - u.failures, 0);
      return [{ n }];
    }
    if (s.startsWith('SELECT feature, SUM(calls)')) {
      const by = new Map();
      for (const u of st.usage.filter((x) => x.day === params[0])) {
        const o = by.get(u.feature) || { feature: u.feature, calls: 0, failures: 0 };
        o.calls += u.calls;
        o.failures += u.failures;
        by.set(u.feature, o);
      }
      return [...by.values()];
    }
    if (s.startsWith('INSERT INTO ai_usage')) {
      const [day, provider, feature, failed] = params.length === 5 ? params.slice(1) : params;
      let u = st.usage.find((x) => x.day === day && x.provider === provider && x.feature === feature);
      if (!u) st.usage.push((u = { day, provider, feature, calls: 0, failures: 0 }));
      u.calls += 1;
      u.failures += failed;
      return { affectedRows: 1 };
    }
    if (s.includes('FROM cards WHERE') && s.includes('enriched=0')) {
      return st.cards.filter((c) => c.enriched === 0 && c.active === 1);
    }
    const m = s.match(/^UPDATE cards SET (.+) WHERE id=\? AND (?:user_id=\? AND )?enriched=0$/);
    if (m) {
      let pi = 0;
      const row = {};
      for (const part of m[1].split(', ')) {
        const [col, val] = part.split('=');
        row[col] = val === '?' ? params[pi++] : Number(val);
      }
      const card = st.cards.find((c) => c.id === params[pi]);
      Object.assign(card, row);
      return { affectedRows: 1 };
    }
    throw new Error(`unexpected sql: ${s}`);
  };
  return { st, query, sleeps: [] };
}

// fetch-мок: fn(url, body, n) -> {status, content, headers?} | 'throw'
function makeFetch(fn) {
  const calls = [];
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const r = await fn(url, body, calls.length);
    if (r === 'throw') throw new Error('network');
    return {
      ok: r.status < 400,
      status: r.status,
      headers: { get: (h) => (r.headers || {})[String(h).toLowerCase()] ?? null },
      json: async () => ({ choices: [{ message: { content: r.content } }] }),
    };
  };
  f.calls = calls;
  return f;
}

function setup({ fetchFn, env = ENV, db = makeDb() }) {
  db.sleeps = [];
  __setDeps({
    fetch: fetchFn,
    query: db.query,
    localDay: () => DAY,
    aiEnabled: async () => true,
    env,
    log: () => {},
    timeoutMs: 5000,
    sleep: async (ms) => {
      db.sleeps.push(ms);
    },
  });
  return db;
}

const OK = { status: 200, content: '{"ok":true}' };
const base = { feature: 'correct', tier: 'strong', system: 'sys', user: 'usr', schema };

// ---------- v1: цепочка, ремонт, лимит, кэш ----------
test('fallback: 429 у первого провайдера -> второй', async () => {
  const f = makeFetch((url, b, n) => (n === 1 ? { status: 429, content: '' } : OK));
  const db = setup({ fetchFn: f });
  const r = await chatJSON(base);
  assert.equal(r.provider, 'gemini');
  assert.equal(r.cached, false);
  assert.deepEqual(r.data, { ok: true });
  assert.ok(f.calls[0].url.includes('api.groq.com'));
  assert.ok(f.calls[1].url.includes('generativelanguage.googleapis.com'));
  assert.equal(f.calls[0].body.model, 'gs');
  const groq = db.st.usage.find((u) => u.provider === 'groq');
  assert.equal(groq.failures, 1);
});

test('ремонт невалидного JSON у того же провайдера', async () => {
  const f = makeFetch((url, b, n) =>
    n === 1 ? { status: 200, content: 'это не json' } : { status: 200, content: '```json\n{"ok":true}\n```' },
  );
  setup({ fetchFn: f });
  const r = await chatJSON(base);
  assert.equal(r.provider, 'groq');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.messages.length, 4);
  assert.deepEqual(r.data, { ok: true });
});

test('все провайдеры упали -> AI_UNAVAILABLE 503', async () => {
  const f = makeFetch(() => 'throw');
  setup({ fetchFn: f });
  await assert.rejects(chatJSON(base), (e) => e.code === 'AI_UNAVAILABLE' && e.status === 503);
});

test('нет ключей -> AI_UNAVAILABLE, сеть не трогаем', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f, env: {} });
  await assert.rejects(chatJSON(base), (e) => e.code === 'AI_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('дневной лимит -> AI_CAP 429 без запросов', async () => {
  const f = makeFetch(() => OK);
  const db = makeDb({ usage: [{ day: DAY, provider: 'groq', feature: 'correct', calls: 2, failures: 0 }] });
  setup({ fetchFn: f, env: { ...ENV, AI_DAILY_CAP_CORRECT: '2' }, db });
  await assert.rejects(chatJSON(base), (e) => e.code === 'AI_CAP' && e.status === 429);
  assert.equal(f.calls.length, 0);
});

test('кэш: второй одинаковый запрос не ходит в сеть', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  const a = await chatJSON({ ...base, cacheTtlDays: 7 });
  const b = await chatJSON({ ...base, cacheTtlDays: 7 });
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.equal(b.provider, 'groq');
  assert.equal(f.calls.length, 1);
});

test('excludeProvider: кэш исключённого провайдера не используется', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  await chatJSON({ ...base, cacheTtlDays: 7 }); // groq
  const r = await chatJSON({ ...base, cacheTtlDays: 7, excludeProvider: 'groq' });
  assert.equal(r.cached, false);
  assert.equal(r.provider, 'gemini');
});

// ---------- v2 / P3: preferProvider, strictProvider ----------
test('preferProvider: gemini пробуется первым', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  const r = await chatJSON({ ...base, preferProvider: 'gemini' });
  assert.equal(r.provider, 'gemini');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.includes('generativelanguage'));
  assert.equal(f.calls[0].body.model, 'ms');
});

test('preferProvider: при сбое идёт обычная цепочка', async () => {
  const f = makeFetch((url, b, n) => (n === 1 ? { status: 500, content: '' } : OK));
  setup({ fetchFn: f });
  const r = await chatJSON({ ...base, preferProvider: 'gemini' });
  assert.equal(r.provider, 'groq');
  assert.ok(f.calls[0].url.includes('generativelanguage'));
  assert.ok(f.calls[1].url.includes('api.groq.com'));
});

test('preferProvider: неизвестный или не из цепочки игнорируется', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  const r = await chatJSON({ ...base, preferProvider: 'openrouter' });
  assert.equal(r.provider, 'groq');
});

test('strictProvider: без запасных, сбой -> AI_UNAVAILABLE', async () => {
  const f = makeFetch(() => ({ status: 500, content: '' }));
  setup({ fetchFn: f });
  await assert.rejects(
    chatJSON({ ...base, strictProvider: 'gemini' }),
    (e) => e.code === 'AI_UNAVAILABLE' && e.status === 503,
  );
  assert.ok(f.calls.length >= 1);
  assert.ok(f.calls.every((c) => c.url.includes('generativelanguage')));
});

test('strictProvider: успех у выбранного', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  const r = await chatJSON({ ...base, strictProvider: 'gemini', preferProvider: 'groq' });
  assert.equal(r.provider, 'gemini'); // strict сильнее prefer
  assert.equal(f.calls.length, 1);
});

test('strictProvider: провайдер не настроен -> 503 без запросов', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  await assert.rejects(chatJSON({ ...base, strictProvider: 'openrouter' }), (e) => e.code === 'AI_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('кэш от другого провайдера не подходит при prefer', async () => {
  const f = makeFetch(() => OK);
  setup({ fetchFn: f });
  await chatJSON({ ...base, cacheTtlDays: 7 }); // groq
  const r = await chatJSON({ ...base, cacheTtlDays: 7, preferProvider: 'gemini' });
  assert.equal(r.cached, false);
  assert.equal(r.provider, 'gemini');
});

// ---------- v2 / P3: Retry-After ----------
test('429 с Retry-After <= 15 c: ждём и повторяем у того же провайдера', async () => {
  const f = makeFetch((url, b, n) =>
    n === 1 ? { status: 429, content: '', headers: { 'retry-after': '2' } } : OK,
  );
  const db = setup({ fetchFn: f });
  const r = await chatJSON(base);
  assert.equal(r.provider, 'groq');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.url.includes('api.groq.com')));
  assert.deepEqual(db.sleeps, [2000]);
});

test('429 с Retry-After > 15 c: без ожидания, сразу следующий провайдер', async () => {
  const f = makeFetch((url, b, n) =>
    n === 1 ? { status: 429, content: '', headers: { 'retry-after': '30' } } : OK,
  );
  const db = setup({ fetchFn: f });
  const r = await chatJSON(base);
  assert.equal(r.provider, 'gemini');
  assert.deepEqual(db.sleeps, []);
});

test('429 без Retry-After: без ожидания; повтор только один раз', async () => {
  const f = makeFetch((url, b, n) => {
    if (url.includes('groq')) return { status: 429, content: '', headers: { 'retry-after': '1' } };
    return OK;
  });
  const db = setup({ fetchFn: f });
  const r = await chatJSON(base);
  assert.equal(r.provider, 'gemini');
  assert.equal(f.calls.filter((c) => c.url.includes('groq')).length, 2); // исходный + один повтор
  assert.deepEqual(db.sleeps, [1000]);
});

// ---------- v2 / P3: общие лимиты ----------
test('лимит по умолчанию 100 для фичи без env', async () => {
  const f = makeFetch(() => OK);
  const db = makeDb({ usage: [{ day: DAY, provider: 'groq', feature: 'lookup', calls: 100, failures: 0 }] });
  setup({ fetchFn: f, db });
  await assert.rejects(chatJSON({ ...base, feature: 'lookup' }), (e) => e.code === 'AI_CAP');
  assert.equal(f.calls.length, 0);
});

test('лимит из AI_DAILY_CAP_TEXT и запас у translate (по умолчанию 100)', async () => {
  const f = makeFetch(() => OK);
  const db = makeDb({
    usage: [
      { day: DAY, provider: 'groq', feature: 'text', calls: 30, failures: 0 },
      { day: DAY, provider: 'groq', feature: 'translate', calls: 99, failures: 0 },
    ],
  });
  setup({ fetchFn: f, env: { ...ENV, AI_DAILY_CAP_TEXT: '30' }, db });
  await assert.rejects(chatJSON({ ...base, feature: 'text' }), (e) => e.code === 'AI_CAP');
  const r = await chatJSON({ ...base, feature: 'translate' });
  assert.equal(r.provider, 'groq');
});

test('getUsage: все восемь фич с лимитами', async () => {
  const db = makeDb({ usage: [{ day: DAY, provider: 'groq', feature: 'speak', calls: 3, failures: 1 }] });
  setup({ fetchFn: makeFetch(() => OK), env: { ...ENV, AI_DAILY_CAP_TEXT: '30' }, db });
  const u = await getUsage();
  assert.equal(u.day, DAY);
  for (const f of ['correct', 'generate', 'enrich', 'text', 'translate', 'speak', 'write', 'lookup']) {
    assert.ok(f in u.by_feature && f in u.caps, f);
  }
  assert.deepEqual(u.by_feature.speak, { calls: 3, failures: 1 });
  assert.equal(u.caps.text, 30);
  assert.equal(u.caps.write, 100);
  assert.equal(u.caps.generate, 40);
});

// ---------- v2 / P3: список провайдеров ----------
test('describeChain: available только при ключе и модели', () => {
  const chain = describeChain({
    LLM_CHAIN: 'groq,gemini,openrouter',
    GROQ_KEY: 'k', GROQ_MODEL_FAST: 'gf',
    GEMINI_KEY: 'k',
    OPENROUTER_MODEL_STRONG: 'os',
  });
  assert.deepEqual(chain.map((c) => c.name), ['groq', 'gemini', 'openrouter']);
  assert.deepEqual(chain[0], { name: 'groq', available: true, models: { strong: null, fast: 'gf' } });
  assert.equal(chain[1].available, false); // нет модели
  assert.equal(chain[2].available, false); // нет ключа
  assert.equal(chain[2].models.strong, 'os');
});

// ---------- v2 / P3: Redemittel, уровень ----------
test('isRedemittel / buildGenerateRequest', () => {
  assert.equal(isRedemittel(' redemittel '), true);
  assert.equal(isRedemittel('Umwelt'), false);
  assert.deepEqual(buildGenerateRequest({ topic: 'Redemittel', count: 12, pos_mix: 'nouns_first', level: 'C1' }), {
    mode: 'redemittel', topic: 'Redemittel', count: 12, pos_mix: 'nouns_first', level: 'C1',
  });
  assert.equal(buildGenerateRequest({ topic: 'Umwelt', count: 5, pos_mix: 'balanced' }).level, 'B2');
  assert.equal(buildGenerateRequest({ topic: 'Umwelt', count: 5, pos_mix: 'balanced' }).mode, 'words');
});

test('normalizeGenerated: Redemittel остаются фразами без артикля', () => {
  const it = {
    term: 'meiner Meinung nach', article: 'die', plural: 'x', pos: 'noun', translation: 'по моему мнению',
    grammar: null, example: 'Meiner Meinung nach ist das richtig.', example_translation: null,
    cloze_answer: 'Meiner Meinung nach', level: null, topic: null,
  };
  const r = normalizeGenerated(it, { topic: 'Redemittel', level: 'C1', redemittel: true });
  assert.equal(r.pos, 'phrase');
  assert.equal(r.article, null);
  assert.equal(r.plural, null);
  assert.equal(r.topic, 'Redemittel');
  assert.equal(r.level, 'C1'); // уровень по запросу
  assert.equal(r.example_cloze, '____ ist das richtig.');
});

test('normalizeGenerated: существительное без артикля отбрасывается, артикль даёт noun', () => {
  const base2 = { term: 'Haus', article: null, plural: null, pos: 'noun', translation: 'дом', example: null, level: 'B1', topic: 'Alltag' };
  assert.equal(normalizeGenerated(base2, { topic: 'Alltag' }), null);
  const r = normalizeGenerated({ ...base2, article: 'das', pos: 'phrase', plural: 'Häuser' }, { topic: 'Alltag' });
  assert.equal(r.pos, 'noun');
  assert.equal(r.level, 'B1');
  assert.equal(r.plural, 'Häuser');
});

// ---------- v1: обогащение ----------
const nounCard = () => ({
  id: 1, term: 'Armut', article: null, plural: null, pos: 'phrase', translation: 'бедность',
  grammar: null, example: 'Viele Kinder wachsen in Armut auf.', example_translation: null,
  example_cloze: null, cloze_answer: null, level: 'B2', topic: 'Sonstiges',
  check_flag: 0, enriched: 0, active: 1,
});

function enrichFetch(secondArticle) {
  return makeFetch((url) => {
    if (url.includes('groq')) {
      return {
        status: 200,
        content: JSON.stringify({
          items: [{ id: 1, pos: 'noun', article: 'die', plural: null, grammar: null, level: 'B2', topic: 'Gesellschaft', cloze_answer: 'Armut' }],
        }),
      };
    }
    return { status: 200, content: JSON.stringify({ items: [{ id: 1, article: secondArticle, plural: null }] }) };
  });
}

test('enrich: расхождение рода -> check_flag=1', async () => {
  const db = makeDb({ cards: [nounCard()] });
  const f = enrichFetch('der');
  setup({ fetchFn: f, db });
  const r = await enrichCards(10);
  assert.deepEqual(r, { processed: 1, flagged: 1 });
  const c = db.st.cards[0];
  assert.equal(c.article, 'die');
  assert.equal(c.pos, 'noun');
  assert.equal(c.topic, 'Gesellschaft');
  assert.equal(c.enriched, 1);
  assert.equal(c.check_flag, 1);
  assert.equal(c.example_cloze, 'Viele Kinder wachsen in ____ auf.');
  assert.equal(c.cloze_answer, 'Armut');
  assert.equal(c.term, 'Armut'); // исходные поля не тронуты
  assert.ok(f.calls[1].url.includes('generativelanguage')); // проверка другим провайдером
});

test('enrich: согласие рода -> флага нет', async () => {
  const db = makeDb({ cards: [nounCard()] });
  setup({ fetchFn: enrichFetch('die'), db });
  const r = await enrichCards(10);
  assert.deepEqual(r, { processed: 1, flagged: 0 });
  assert.equal(db.st.cards[0].check_flag, 0);
  assert.equal(db.st.cards[0].enriched, 1);
});

test('enrich: ИИ недоступен -> ошибка, карточки не меняются', async () => {
  const db = makeDb({ cards: [nounCard()] });
  setup({ fetchFn: makeFetch(() => 'throw'), db });
  await assert.rejects(enrichCards(10), (e) => e.code === 'AI_UNAVAILABLE');
  assert.equal(db.st.cards[0].enriched, 0);
  assert.equal(db.st.cards[0].article, null);
});

test('makeCloze: форма найдена / не найдена', () => {
  assert.deepEqual(makeCloze('Er hat große Angst.', 'Angst'), {
    example_cloze: 'Er hat große ____.',
    cloze_answer: 'Angst',
  });
  assert.equal(makeCloze('Er hängt vom Wetter ab.', 'hängt ab'), null);
  assert.equal(makeCloze('Haus', 'Haus'), null);
  assert.equal(makeCloze(null, 'x'), null);
});

test('cacheKeyOf: включает feature, schemaVer и tier; fallback :fast для :strong не пишет в ai_cache', async () => {
  const kStrong = cacheKeyOf('text', 'v2:ok', 'strong', 'sys', 'usr');
  const kFast = cacheKeyOf('text', 'v2:ok', 'fast', 'sys', 'usr');
  const kOtherVer = cacheKeyOf('text', 'v3:ok', 'strong', 'sys', 'usr');
  assert.notEqual(kStrong, kFast);
  assert.notEqual(kStrong, kOtherVer);

  // Если для strong-фичи выбран или сработал :fast фолбэк, ответ возвращается, но в ai_cache не пишется
  const f = makeFetch(() => OK);
  const db = makeDb();
  setup({ fetchFn: f, db });
  const r = await chatJSON({ ...base, feature: 'text', tier: 'strong', preferProvider: 'gemini:fast', cacheTtlDays: 7 });
  assert.equal(r.cached, false);
  assert.equal(db.st.cache.size, 0);
});