// Тесты текстов: подсчёт правильных ответов и разбор данных (M7); БД не нужна
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreAnswers, countWords, parseSpeakers, toTextItem, normalizeQuestions,
  createTextSchema, attemptSchema, listQuerySchema,
} from '../server/routes/texts.js';

const Q = [
  { id: 'q1', type: 'tf', text: 'a', options: ['Richtig', 'Falsch'], answer: 0, explanation_ru: '', evidence: 'x' },
  { id: 'q2', type: 'mc', text: 'b', options: ['1', '2', '3'], answer: 2, explanation_ru: '', evidence: 'y' },
  { id: 'q3', type: 'mc', text: 'c', options: ['1', '2', '3'], answer: 1, explanation_ru: '', evidence: 'z' },
];

test('scoreAnswers: считает совпадения по индексам', () => {
  assert.deepEqual(scoreAnswers(Q, [0, 2, 1]), { correct: 3, total: 3 });
  assert.deepEqual(scoreAnswers(Q, [1, 2, 0]), { correct: 1, total: 3 });
});

test('scoreAnswers: null, пропуски, лишние ответы, мусор', () => {
  assert.deepEqual(scoreAnswers(Q, [null, 2]), { correct: 1, total: 3 });
  assert.deepEqual(scoreAnswers(Q, [0, 2, 1, 1, 1, 1]), { correct: 3, total: 3 });
  assert.deepEqual(scoreAnswers(Q, undefined), { correct: 0, total: 3 });
  assert.deepEqual(scoreAnswers(Q, ['0', '2', '1']), { correct: 0, total: 3 });
  assert.deepEqual(scoreAnswers([], [0]), { correct: 0, total: 0 });
  assert.deepEqual(scoreAnswers(null, null), { correct: 0, total: 0 });
});

test('countWords', () => {
  assert.equal(countWords('Ich gehe heute nach Hause.'), 5);
  assert.equal(countWords('Er sagte: "Es ist 3-mal so gut" – ja!'), 8);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('parseSpeakers: диалог с двумя и больше говорящими', () => {
  const body = 'Anna: Hallo, wie geht es dir?\nTom: Gut, danke!\nAnna: Schön.';
  assert.deepEqual(parseSpeakers(body), [{ name: 'Anna' }, { name: 'Tom' }]);
  assert.equal(parseSpeakers('Nur ein langer Satz ohne Sprecher.'), null);
  assert.equal(parseSpeakers('Anna: Hallo\nund weiter ohne Namen'), null);
});

test('normalizeQuestions отбрасывает битые вопросы', () => {
  const out = normalizeQuestions([...Q, null, { type: 'mc', text: 'x', options: ['a'], answer: 0 }, { type: 'tf', text: 'x', options: ['a', 'b'], answer: 5 }, 'x']);
  assert.equal(out.length, 3);
  assert.deepEqual(normalizeQuestions('нет'), []);
});

test('toTextItem: битый JSON даёт значения по умолчанию', () => {
  const t = toTextItem({
    id: 1, kind: 'dialogue', title: 'T', body: 'B', speakers: '{плохо', level: 'B2', topic: 'Alltag',
    source: 'pasted', target_card_ids: 'x', questions: '[не json', word_count: '12', provider: null,
    created_at: '2026-11-05 10:00:00',
  });
  assert.equal(t.speakers, null);
  assert.deepEqual(t.target_card_ids, []);
  assert.deepEqual(t.questions, []);
  assert.equal(t.word_count, 12);
  assert.equal(t.created_at, '2026-11-05T10:00:00.000Z');
});

test('toTextItem: нормальные данные', () => {
  const t = toTextItem({
    id: 2, kind: 'dialogue', title: 'T', body: 'B', speakers: JSON.stringify([{ name: ' Anna ' }, 'Tom', { x: 1 }]),
    level: 'B1', topic: 'Arbeit', source: 'ai', target_card_ids: '[3,3,"a",-1,4]',
    questions: JSON.stringify(Q), word_count: 100, provider: 'groq', created_at: '2026-11-05 10:00:00',
  });
  assert.deepEqual(t.speakers, [{ name: 'Anna' }, { name: 'Tom' }]);
  assert.deepEqual(t.target_card_ids, [3, 4]);
  assert.equal(t.questions.length, 3);
  assert.equal(t.provider, 'groq');
});

test('createTextSchema: длина тела 50..20000', () => {
  const ok = createTextSchema.safeParse({ kind: 'reading', title: ' Titel ', body: 'a'.repeat(50) });
  assert.ok(ok.success);
  assert.equal(ok.data.title, 'Titel');
  assert.ok(!createTextSchema.safeParse({ kind: 'reading', title: 'T', body: 'a'.repeat(49) }).success);
  assert.ok(!createTextSchema.safeParse({ kind: 'reading', title: 'T', body: 'a'.repeat(20001) }).success);
  assert.ok(!createTextSchema.safeParse({ kind: 'bad', title: 'T', body: 'a'.repeat(60) }).success);
  assert.ok(!createTextSchema.safeParse({ kind: 'reading', title: '', body: 'a'.repeat(60) }).success);
  const crlf = createTextSchema.parse({ kind: 'reading', title: 'T', body: `${'a'.repeat(30)}\r\n${'b'.repeat(30)}` });
  assert.ok(!crlf.body.includes('\r'));
});

test('attemptSchema и listQuerySchema', () => {
  assert.ok(attemptSchema.safeParse({ mode: 'read', answers: [0, null, 2], seconds: 12.4 }).success);
  assert.equal(attemptSchema.parse({ mode: 'listen' }).seconds, 0);
  assert.ok(!attemptSchema.safeParse({ mode: 'x' }).success);
  assert.ok(!attemptSchema.safeParse({ mode: 'read', answers: ['a'] }).success);
  assert.ok(!attemptSchema.safeParse({ mode: 'read', seconds: -1 }).success);
  assert.deepEqual(listQuerySchema.parse({}), { limit: 50, offset: 0 });
  assert.ok(!listQuerySchema.safeParse({ limit: 1000 }).success);
  assert.ok(!listQuerySchema.safeParse({ kind: 'x' }).success);
});