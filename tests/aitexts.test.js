// Тесты M8a: без сети и без MySQL (ИИ и БД подменены через deps).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCoverage, analyzeText, buildKnownIndex, findCardMatch, generateText, normalizeQuestions,
  pickTargets, termsInBody, wrapData,
} from '../server/ai/textgen.js';
import { prepareItem } from '../server/cards_service.js';
import {
  aiTextSchema, generateTextRequestSchema, normalizeLookupResult, parseBody, toStagingItem,
} from '../server/ai/schemas_v2.js';
import { STOPWORDS } from '../shared/stopwords.js';

const BODY = 'Anna wohnt in einer kleinen Stadt. Sie arbeitet jeden Tag in einer Bibliothek am Marktplatz. '
  + 'Am Wochenende fährt sie oft mit dem Fahrrad zum See.';

test('normalizeQuestions: tf, mc, boolean-ответ, id и сохранение верного варианта после перемешивания', () => {
  const raw = [
    { type: 'tf', text: 'Anna wohnt in einer Großstadt.', options: ['Richtig', 'Falsch'], answer: 1, explanation_ru: 'Город маленький.', evidence: 'Anna wohnt in einer kleinen Stadt' },
    { type: 'mc', text: 'Wo arbeitet Anna?', options: ['Bibliothek', 'Schule', 'Bank'], answer: 0, explanation_ru: 'В библиотеке.', evidence: 'in einer Bibliothek am Marktplatz' },
    { type: 'true_false', text: 'Anna fährt mit dem Auto zum See.', answer: false, explanation_ru: 'На велосипеде.', evidence: 'mit dem Fahrrad zum See' },
  ];
  const q = normalizeQuestions(raw, BODY, 5);
  assert.equal(q.length, 3);
  assert.deepEqual(q.map((x) => x.id), ['q1', 'q2', 'q3']);
  assert.deepEqual(q[0].options, ['Richtig', 'Falsch']);
  assert.equal(q[0].answer, 1);
  assert.equal(q[1].options.length, 3);
  assert.equal(q[1].options[q[1].answer], 'Bibliothek');
  assert.equal(q[2].type, 'tf');
  assert.equal(q[2].answer, 1);
});

test('normalizeQuestions: отбрасывает плохие вопросы, дубли и режет 4 варианта до 3', () => {
  const good = { type: 'mc', text: 'Wo arbeitet Anna?', options: ['A) Bibliothek', 'B) Schule', 'C) Bank', 'D) Post'], answer: 'D', evidence: 'in einer Bibliothek' };
  const raw = [
    { type: 'tf', text: 'X?', answer: 0, evidence: 'steht nicht im Text' },
    { type: 'mc', text: 'Zwei Optionen?', options: ['a', 'b'], answer: 0, evidence: 'in einer kleinen Stadt' },
    { type: 'mc', text: 'Gleiche Optionen?', options: ['a', 'A', 'b'], answer: 0, evidence: 'in einer kleinen Stadt' },
    { type: 'mc', text: 'Ответ вне диапазона?', options: ['a', 'b', 'c'], answer: 7, evidence: 'in einer kleinen Stadt' },
    null, 'мусор', { text: '', evidence: 'x' },
    good, { ...good },
  ];
  const q = normalizeQuestions(raw, BODY, 5);
  assert.equal(q.length, 1);
  assert.equal(q[0].options.length, 3);
  assert.equal(q[0].options[q[0].answer], 'Post');
  assert.deepEqual(normalizeQuestions('не массив', BODY), []);
});

test('диалог: схема требует 2-3 говорящих', () => {
  const ok = 'Anna: Hallo Markus, wie geht es dir heute?\nMarkus: Gut, danke. Und dir, Anna? Hast du Zeit für einen Kaffee?';
  const one = 'Anna: Hallo und herzlich willkommen zu unserer heutigen Sendung über das Leben in der Stadt am Fluss.';
  const s = aiTextSchema('dialogue');
  assert.equal(s.safeParse({ title: 't', body: ok }).success, true);
  assert.equal(s.safeParse({ title: 't', body: one }).success, false);
  assert.equal(s.safeParse({ title: 't', body: ok + '\nund ещё строка без имени' }).success, false);
});

test('termsInBody: существительное, спряжение глагола, plural, оборот и отсутствие', () => {
  const cards = [
    { id: 1, term: 'Bibliothek', article: 'die', plural: 'Bibliotheken', pos: 'noun', cloze_answer: null },
    { id: 2, term: 'wohnen', article: null, plural: null, pos: 'verb', cloze_answer: null },
    { id: 3, term: 'Fahrrad', article: 'das', plural: 'Fahrräder', pos: 'noun', cloze_answer: null },
    { id: 4, term: 'am Marktplatz', article: null, plural: null, pos: 'phrase', cloze_answer: null },
    { id: 5, term: 'Umweltschutz', article: 'der', plural: null, pos: 'noun', cloze_answer: null },
    { id: 6, term: 'Stadt', article: 'die', plural: 'Städte', pos: 'noun', cloze_answer: null },
  ];
  assert.deepEqual(termsInBody(BODY, cards), [1, 2, 3, 4, 6]);
  assert.deepEqual(termsInBody('Die Städte wachsen schnell und viele Fahrräder stehen dort.', cards), [3, 6]);
  assert.deepEqual(termsInBody(BODY, null), []);
});

test('покрытие: известные формы, стоп-слова, кандидаты 4+ букв по частоте', () => {
  const cards = [
    { term: 'wohnen', pos: 'verb', plural: null, cloze_answer: null },
    { term: 'Stadt', pos: 'noun', plural: 'Städte', cloze_answer: null },
  ];
  const text = 'Anna wohnt in der Stadt. Die Bibliothek ist alt. Die Bibliothek und das Rathaus sind groß, Rathaus Rathaus.';
  const idx = buildKnownIndex(cards);
  const cov = analyzeCoverage(text, idx, 'reading');
  assert.ok(cov.coverage_pct > 0 && cov.coverage_pct < 100);
  const words = cov.candidates.map((c) => c.word.toLowerCase());
  assert.equal(words[0], 'rathaus');
  assert.ok(words.includes('bibliothek'));
  assert.ok(!words.includes('stadt') && !words.includes('wohnt') && !words.includes('ist'));
  assert.equal(analyzeCoverage('', idx, 'reading').coverage_pct, 0);
  assert.ok(STOPWORDS.has('und'));
});

test('findCardMatch: термин, артикль, plural, cloze_answer, промах', () => {
  const cards = [
    { id: 1, term: 'Armut', article: 'die', plural: null, cloze_answer: null },
    { id: 2, term: 'Haus', article: 'das', plural: 'Häuser', cloze_answer: null },
    { id: 3, term: 'entscheiden', article: null, plural: null, cloze_answer: 'entschied' },
  ];
  assert.equal(findCardMatch(cards, 'Armut').id, 1);
  assert.equal(findCardMatch(cards, 'die Armut').id, 1);
  assert.equal(findCardMatch(cards, '  "Häuser"! ').id, 2);
  assert.equal(findCardMatch(cards, 'Entschied').id, 3);
  assert.equal(findCardMatch(cards, 'Tisch'), null);
  assert.equal(findCardMatch(cards, ''), null);
});

test('normalizeLookupResult и toStagingItem', () => {
  const r = normalizeLookupResult({ lemma: 'die Häuser ', article: null, pos: 'Nomen', plural: '-', translation_ru: ' дома ' }, 'Häuser');
  assert.equal(r.pos, 'noun');
  assert.equal(r.article, 'die');
  assert.equal(r.lemma, 'Häuser');
  assert.equal(r.plural, null);
  assert.equal(normalizeLookupResult({ lemma: 'x', translation_ru: '' }), null);
  assert.equal(normalizeLookupResult('мусор'), null);
  assert.equal(normalizeLookupResult({ lemma: 'laufen', pos: 'constructor', translation_ru: 'бежать' }).pos, 'phrase');

  const it = toStagingItem({ lemma: 'der Tisch', pos: 'noun', translation_ru: 'стол', topic: 'Quatsch', level: 'X' });
  assert.equal(it.term, 'Tisch');
  assert.equal(it.article, 'der');
  assert.equal(it.topic, 'Sonstiges');
  assert.equal(it.level, 'B2');
  const noArt = toStagingItem({ lemma: 'Tisch', pos: 'noun', translation_ru: 'стол' });
  assert.equal(noArt.check_flag, 1);
  const verb = toStagingItem({ lemma: 'laufen', article: 'der', pos: 'verb', translation_ru: 'бежать' });
  assert.equal(verb.article, null);
  assert.equal(toStagingItem({ lemma: '', pos: 'verb', translation_ru: 'x' }), null);
});

test('запрос generate-text: значения по умолчанию и 400', () => {
  const p = parseBody(generateTextRequestSchema, { kind: 'dialogue', topic: 'Umwelt' });
  assert.equal(p.level, 'B2');
  assert.equal(p.length, 'medium');
  assert.equal(p.question_count, 5);
  assert.equal(p.use_due_words, true);
  assert.throws(() => parseBody(generateTextRequestSchema, { kind: 'poem', topic: 'x' }), (e) => e.status === 400 && e.code === 'BAD_REQUEST');
  assert.throws(() => parseBody(generateTextRequestSchema, { kind: 'reading', topic: 'x', question_count: 9 }), (e) => e.status === 400);
  assert.throws(() => parseBody(generateTextRequestSchema, null), (e) => e.status === 400);
});

test('wrapData вырезает маркеры, pickTargets ограничивает число', () => {
  assert.ok(!wrapData('T', 'a <<<X b>>> c').includes('<<<X'));
  assert.equal(pickTargets([1, 2, 3, 4, 5], 3, () => 0.5).length, 3);
  assert.deepEqual(pickTargets(null), []);
});

function fakeDeps(replies, calls) {
  return {
    chat: async (opts) => { calls.push(opts); return { data: replies.shift(), provider: 'groq', cached: false }; },
    loadTargets: async () => [{ id: 1, term: 'Bibliothek', article: 'die', plural: null, pos: 'noun', cloze_answer: null },
      { id: 9, term: 'Umweltschutz', article: 'der', plural: null, pos: 'noun', cloze_answer: null }],
    loadRecent: async () => [],
    save: async (rec) => ({ id: 1, ...rec }),
  };
}
const goodQ = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'tf', text: `Aussage ${i}?`, options: ['Richtig', 'Falsch'], answer: 0, explanation_ru: 'ок', evidence: 'in einer kleinen Stadt',
}));
const base = { kind: 'reading', topic: 'Wohnen', level: 'B2', length: 'short', question_count: 5, use_due_words: true };

test('generateText: хороший ответ — один вызов, target_card_ids только найденные', async () => {
  const calls = [];
  const item = await generateText(base, fakeDeps([{ title: 'Anna', body: BODY, questions: goodQ(5) }], calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, 'text');
  assert.equal(calls[0].tier, 'strong');
  assert.equal(item.questions.length, 5);
  assert.deepEqual(item.target_card_ids, [1]);
  assert.equal(item.provider, 'groq');
  assert.equal(item.speakers, null);
});

test('generateText: мало вопросов -> один повтор только вопросов', async () => {
  const calls = [];
  const item = await generateText({ ...base, provider: 'gemini' },
    fakeDeps([{ title: 'Anna', body: BODY, questions: goodQ(1) }, { questions: [...goodQ(1), { ...goodQ(1)[0], text: 'Zweite Aussage?' }, { ...goodQ(1)[0], text: 'Dritte Aussage?' }] }], calls));
  assert.equal(calls.length, 2);
  assert.match(calls[1].user, /MODE: questions_only/);
  assert.equal(calls[0].preferProvider, 'gemini');
  assert.equal(item.questions.length, 3);
});

test('generateText: после повтора всё ещё < 3 вопросов -> 502 AI_BAD_OUTPUT', async () => {
  const calls = [];
  await assert.rejects(
    generateText(base, fakeDeps([{ title: 'A', body: BODY, questions: [] }, { questions: [{ evidence: 'нет в тексте' }] }], calls)),
    (e) => e.status === 502 && e.code === 'AI_BAD_OUTPUT');
  assert.equal(calls.length, 2);
});

test('generateText: диалог — speakers из тела, число слов без имён', async () => {
  const dlg = 'Anna: Hallo Markus, wie geht es dir heute in der kleinen Stadt?\nMarkus: Gut, danke. Und dir, Anna? Hast du Zeit für einen Kaffee?';
  const qs = goodQ(3).map((q) => ({ ...q, evidence: 'Hast du Zeit für einen Kaffee' }));
  const item = await generateText({ ...base, kind: 'dialogue', use_due_words: false },
    fakeDeps([{ title: 'Kaffee', body: dlg, speakers: ['Falsch'], questions: qs }], []));
  assert.deepEqual(item.speakers, [{ name: 'Anna' }, { name: 'Markus' }]);
  assert.ok(item.word_count < 30 && item.word_count > 10);
});

test('analyzeText: выдуманные и уже известные слова отбрасываются, staged считается', async () => {
  const text = 'Die Bibliothek ist alt. Das Rathaus ist groß. Das Rathaus steht am Marktplatz. Die Bibliothek schließt früh.';
  const staged = [];
  const deps = {
    loadText: async () => ({ id: 7, kind: 'reading', body: text, level: 'B2', topic: 'Stadt' }),
    loadCards: async () => [{ term: 'Bibliothek', article: 'die', pos: 'noun', plural: null, cloze_answer: null }],
    chat: async () => ({ data: {
      level_estimate: 'ungefähr B1-B2', summary_ru: 'Текст о городе.',
      words: [
        { word: 'Rathaus', lemma: 'Rathaus', article: 'das', plural: 'Rathäuser', pos: 'noun', translation_ru: 'ратуша', example: 'Das Rathaus ist alt.', example_ru: 'Ратуша старая.' },
        { word: 'Fantasiewort', lemma: 'Fantasiewort', pos: 'noun', translation_ru: 'выдумка' },
        { word: 'Bibliothek', lemma: 'Bibliothek', article: 'die', pos: 'noun', translation_ru: 'библиотека' },
        { word: 'Marktplatz', lemma: 'Marktplatz', article: 'der', pos: 'noun', translation_ru: 'рыночная площадь' },
        { word: 'Marktplatz', lemma: 'Marktplatz', article: 'der', pos: 'noun', translation_ru: 'дубль' },
        42,
      ],
    } }),
    stage: async (item, batch) => { staged.push([item.term, batch]); return item.term === 'Rathaus'; },
  };
  const r = await analyzeText(7, deps);
  assert.equal(r.level_estimate, 'B1');
  assert.deepEqual(r.unknown_words.map((w) => w.lemma), ['Rathaus', 'Marktplatz']);
  assert.ok(r.unknown_words.every((w) => w.in_cards === null));
  assert.equal(r.staged, 1);
  assert.deepEqual(staged[0], ['Rathaus', 'text-7']);
  assert.ok(r.coverage_pct > 0 && r.coverage_pct < 100);
  await assert.rejects(analyzeText(1, { loadText: async () => null }), (e) => e.status === 404);
});

test('generateText: возвращает встроенный глоссарий текста + целевые слова колоды', async () => {
  const calls = [];
  const deps = {
    ...fakeDeps([{
      title: 'Anna', body: BODY, questions: goodQ(3),
      glossary: [
        { word: 'fährt', lemma: 'fahren', pos: 'verb', translation_ru: 'ехать' },
        { word: 'Fahrrad', lemma: 'das Fahrrad', pos: 'noun', plural: 'Fahrräder', translation_ru: 'велосипед' },
      ],
    }], calls),
    loadTargets: async () => [{ id: 1, term: 'Bibliothek', article: 'die', plural: 'Bibliotheken', pos: 'noun', translation: 'библиотека', cloze_answer: null }],
  };
  const item = await generateText(base, deps);
  assert.ok(Array.isArray(item.glossary));
  assert.ok(item.glossary.some((g) => g.lemma === 'fahren' && g.translation_ru === 'ехать'));
  assert.ok(item.glossary.some((g) => g.lemma === 'Fahrrad' && g.article === 'das'));
  assert.ok(item.glossary.some((g) => g.lemma === 'Bibliothek' && g.in_cards?.id === 1));
});

test('prepareItem (cards_service): нормализация, cloze и флаг enriched', () => {
  const j = prepareItem({
    term: 'Fahrrad',
    article: 'das',
    plural: 'Fahrräder',
    pos: 'noun',
    translation: 'велосипед',
    grammar: 'n., -ä-er',
    example: 'Sie fährt mit dem Fahrrad zum See.',
    example_translation: 'Она едет на велосипеде к озеру.',
    check_flag: 1,
  }, { source: 'lookup', batchId: 'b1' });
  assert.equal(j.check_flag, 1);
  assert.equal(j.enriched, 1);
  assert.equal(j.source, 'lookup');
  assert.equal(j.source_batch, 'b1');
  assert.equal(j.dedupe_key, 'das fahrrad');
});

test('toStagingItem: автоматически строит example_cloze и cloze_answer из примера', () => {
  const it = toStagingItem({
    word: 'Fahrrad',
    lemma: 'das Fahrrad',
    pos: 'noun',
    translation_ru: 'велосипед',
    example: 'Sie fährt mit dem Fahrrad zum See.',
    example_ru: 'Она едет на велосипеде к озеру.',
  });
  assert.equal(it.term, 'Fahrrad');
  assert.equal(it.article, 'das');
  assert.equal(it.example_cloze, 'Sie fährt mit dem ____ zum See.');
  assert.equal(it.cloze_answer, 'Fahrrad');
});