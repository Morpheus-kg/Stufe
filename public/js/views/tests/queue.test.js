import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueue, interleave, isEligible, displayForm, MIN_GAP, NEW_MODES_PER_DAY, LEARNED_STABILITY,
} from '../server/srs/queue.js';

const NOW = '2026-03-10T08:00:00.000Z';
const DAY = '2026-03-10';
const SETTINGS = { new_per_day: 10, max_reviews_per_day: 150, max_session_items: 40, ai_enabled: true };
const NO_AI = { ...SETTINGS, ai_enabled: false };
const FUTURE = '2026-04-01T00:00:00Z';

function card(id, extra = {}) {
  return {
    id, term: `Wort${id}`, article: null, plural: null, pos: 'phrase', translation: `слово${id}`,
    grammar: null, example: null, example_translation: null, example_cloze: null, cloze_answer: null,
    level: 'B2', topic: 'Alltag', source: null, check_flag: false, enriched: false, active: true,
    ...extra,
  };
}
const withCloze = { example: 'Das ist ein Satz.', example_cloze: 'Das ist ein ____.', cloze_answer: 'Satz' };
const clozeFor = (id) => ({ ...withCloze, cloze_answer: `Ans${id}` });

function st(card_id, mode, due, extra = {}) {
  return {
    card_id, mode, state: 2, due, stability: 5, difficulty: 5, elapsed_days: 1, scheduled_days: 1,
    learning_steps: 0, reps: 2, lapses: 0, last_review: '2026-03-09T08:00:00.000Z', ...extra,
  };
}
const main = (q) => q.filter((i) => i.kind !== 'sentence');

test('isEligible: правила режимов', () => {
  assert.equal(isEligible(card(1), 'ru_de'), true);
  assert.equal(isEligible(card(1), 'cloze'), false);
  assert.equal(isEligible(card(1, withCloze), 'cloze'), true);
  assert.equal(isEligible(card(1, { pos: 'noun', article: 'der' }), 'article'), true);
  assert.equal(isEligible(card(1, { pos: 'verb', article: 'der' }), 'article'), false);
  assert.equal(isEligible(card(1, { pos: 'noun' }), 'article'), false);
  assert.equal(isEligible(card(1), 'dictation'), false);
  assert.equal(isEligible(null, 'ru_de'), false);
});

test('displayForm: с артиклем и без', () => {
  assert.equal(displayForm(card(1, { pos: 'noun', article: 'die', term: 'Armut' })), 'die Armut');
  assert.equal(displayForm(card(2)), 'Wort2');
});

test('просроченные: по due, будущие отсекаются, формат due -> ISO', () => {
  const q = buildQueue({
    cards: [card(1), card(2), card(3)],
    states: [
      st(1, 'ru_de', '2026-03-10 07:00:00'),
      st(2, 'ru_de', '2026-03-09T00:00:00Z'),
      st(3, 'ru_de', '2026-03-11T00:00:00Z'),
    ],
    introducedToday: 0, doneToday: 0, now: NOW, settings: SETTINGS,
  });
  assert.deepEqual(q.map((i) => i.key), ['2:ru_de', '1:ru_de']);
  assert.equal(q[0].kind, 'review');
  assert.equal(q[0].due, new Date('2026-03-09T00:00:00Z').toISOString());
  assert.equal(q[0].card.id, 2);
});

test('лимит повторов: max_reviews_per_day - doneToday', () => {
  const cards = [1, 2, 3, 4, 5].map((i) => card(i));
  const states = cards.map((c, i) => st(c.id, 'ru_de', `2026-03-09T0${i}:00:00Z`));
  const q = buildQueue({
    cards, states, introducedToday: 0, doneToday: 1, now: NOW,
    settings: { ...SETTINGS, max_reviews_per_day: 3 },
  });
  assert.equal(main(q).length, 2);
  const none = buildQueue({
    cards, states, introducedToday: 0, doneToday: 5, now: NOW,
    settings: { ...SETTINGS, max_reviews_per_day: 3 },
  });
  assert.equal(main(none).length, 0);
});

test('просроченное состояние режима, неподходящего карточке, пропускается; неактивные тоже', () => {
  const q = buildQueue({
    cards: [card(1), card(2, { ...withCloze, active: false })],
    states: [st(1, 'cloze', '2026-03-09T00:00:00Z'), st(2, 'cloze', '2026-03-09T00:00:00Z')],
    introducedToday: 0, doneToday: 0, now: NOW, settings: SETTINGS,
  });
  assert.equal(main(q).length, 0);
});

test('новые: level asc, id asc, лимит new_per_day', () => {
  const cards = [card(1, { level: 'C1' }), card(2, { level: 'B1' }), card(3, { level: 'B2' })];
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW,
    settings: { ...SETTINGS, new_per_day: 2 },
  });
  const ids = [...new Set(main(q).map((i) => i.card_id))].sort();
  assert.deepEqual(ids, [2, 3]);
});

test('новые: ru_de + первый подходящий второй режим; ru_de раньше второго', () => {
  const cards = [
    card(1, withCloze),
    card(2, { pos: 'noun', article: 'die', term: 'Armut' }),
    card(3, { example: 'Ein Satz.' }),
    card(4),
    card(5, { ...withCloze, pos: 'noun', article: 'der' }),
  ];
  const q = main(buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI,
  }));
  const modesOf = (id) => q.filter((i) => i.card_id === id).map((i) => i.mode);
  assert.deepEqual(modesOf(1).sort(), ['cloze', 'ru_de']);
  assert.deepEqual(modesOf(2).sort(), ['article', 'ru_de']);
  assert.deepEqual(modesOf(3), ['ru_de']);
  assert.deepEqual(modesOf(4), ['ru_de']);
  assert.deepEqual(modesOf(5).sort(), ['cloze', 'ru_de']);
  for (const id of [1, 2, 3, 5]) {
    const own = q.filter((i) => i.card_id === id);
    assert.equal(own[0].mode, 'ru_de');
  }
  assert.ok(q.every((i) => i.kind === 'new' && i.due === null));
});

test('новые: introducedToday уменьшает лимит; карточка с состоянием не новая', () => {
  const cards = [card(1), card(2), card(3)];
  const s = { ...SETTINGS, new_per_day: 10, ai_enabled: false };
  const q9 = buildQueue({ cards, states: [], introducedToday: 9, doneToday: 0, now: NOW, settings: s });
  assert.equal(new Set(q9.map((i) => i.card_id)).size, 1);
  const q10 = buildQueue({ cards, states: [], introducedToday: 10, doneToday: 0, now: NOW, settings: s });
  assert.equal(q10.length, 0);
  const q = buildQueue({
    cards, states: [st(1, 'ru_de', FUTURE, { state: 1, stability: 0 })],
    introducedToday: 0, doneToday: 0, now: NOW, settings: s,
  });
  assert.deepEqual([...new Set(q.map((i) => i.card_id))].sort(), [2, 3]);
});

test('перемешивание: одна карточка не ближе MIN_GAP', () => {
  const cards = Array.from({ length: 10 }, (_, i) => card(i + 1, withCloze));
  const q = main(buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI,
  }));
  assert.equal(q.length, 20);
  const pos = new Map();
  q.forEach((it, i) => {
    if (pos.has(it.card_id)) assert.ok(i - pos.get(it.card_id) >= MIN_GAP, `карточка ${it.card_id}`);
    pos.set(it.card_id, i);
  });
  for (let id = 1; id <= 10; id++) {
    const own = q.filter((i) => i.card_id === id);
    assert.equal(own[0].mode, 'ru_de');
  }
});

test('interleave: пустой и маленький ввод, сохранение элементов', () => {
  assert.deepEqual(interleave([]), []);
  assert.deepEqual(interleave(null), []);
  const items = [1, 1, 2, 3, 4, 5, 6].map((c, i) => ({ card_id: c, key: String(i) }));
  const out = interleave(items);
  assert.equal(out.length, items.length);
  assert.deepEqual(out.map((x) => x.key).sort(), items.map((x) => x.key).sort());
});

test('лимит сессии: пары новых не разрываются', () => {
  const dueCards = [11, 12, 13].map((i) => card(i));
  const newCards = [21, 22, 23].map((i) => card(i, withCloze));
  const q = main(buildQueue({
    cards: [...dueCards, ...newCards],
    states: dueCards.map((c) => st(c.id, 'ru_de', '2026-03-09T00:00:00Z')),
    introducedToday: 0, doneToday: 0, now: NOW,
    settings: { ...NO_AI, max_session_items: 5 },
  }));
  assert.equal(q.length, 5);
  const news = q.filter((i) => i.kind === 'new');
  assert.equal(news.length, 2);
  assert.equal(new Set(news.map((i) => i.card_id)).size, 1);
});

test('sentence: одна задача в конце, приоритет у «Again» сегодня', () => {
  const cards = [card(7), card(8), card(9)];
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: SETTINGS,
    lapsedIds: [7], introducedIds: [8],
  });
  const last = q[q.length - 1];
  assert.equal(last.kind, 'sentence');
  assert.equal(last.mode, 'sentence');
  assert.equal(last.card_id, 7);
  assert.equal(last.key, '7:sentence');
  assert.equal(last.due, null);
  assert.equal(last.choices, undefined);
  assert.equal(q.filter((i) => i.kind === 'sentence').length, 1);
});

test('sentence: введённые сегодня, отсутствие кандидатов, ai_enabled=false', () => {
  const cards = [card(8), card(9)];
  const s = { ...SETTINGS, new_per_day: 2 };
  const base = { cards, states: [], introducedToday: 2, doneToday: 0, now: NOW, settings: s };
  const q1 = buildQueue({ ...base, introducedIds: [9, 8] });
  assert.equal(q1.length, 1);
  assert.equal(q1[0].card_id, 9);
  const q2 = buildQueue({ ...base });
  assert.equal(q2.length, 0);
  const q3 = buildQueue({ ...base, settings: { ...s, ai_enabled: false }, introducedIds: [9] });
  assert.equal(q3.length, 0);
  const q4 = buildQueue({ ...base, lapsedIds: [999] });
  assert.equal(q4.length, 0);
});

test('sentence: Relearning за последние сутки считается «lapsed» без lapsedIds', () => {
  const q = buildQueue({
    cards: [card(5)],
    states: [st(5, 'ru_de', '2026-03-10T09:00:00Z', { state: 3, last_review: '2026-03-10T07:50:00Z' })],
    introducedToday: 0, doneToday: 0, now: NOW, settings: SETTINGS,
  });
  assert.equal(q[q.length - 1].kind, 'sentence');
  assert.equal(q[q.length - 1].card_id, 5);
});

test('мусорный ввод не роняет buildQueue', () => {
  assert.deepEqual(buildQueue(undefined), []);
  assert.deepEqual(buildQueue({}), []);
  assert.deepEqual(buildQueue({ cards: [null, {}, { id: 'x' }], states: [null, { mode: 'zzz' }], settings: null }), []);
});

// ---- choices ----

test('choices ru_de: 4 разных варианта той же части речи, правильный внутри', () => {
  const cards = [1, 2, 3, 4, 5, 6].map((i) => card(i, { pos: 'noun', article: 'der', term: `Tisch${i}` }));
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  const it = q.find((i) => i.key === '1:ru_de');
  assert.equal(it.choices.length, 4);
  assert.equal(new Set(it.choices).size, 4);
  assert.ok(it.choices.includes('der Tisch1'));
  assert.ok(it.choices.every((c) => /^der Tisch\d$/.test(c)));
  // детерминированность
  const q2 = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.deepEqual(q2.find((i) => i.key === '1:ru_de').choices, it.choices);
});

test('choices ru_de: маленький пул и пул другой части речи', () => {
  const two = buildQueue({
    cards: [card(1), card(2)], states: [], introducedToday: 0, doneToday: 0,
    now: NOW, settings: NO_AI, localDay: DAY,
  });
  const c2 = two.find((i) => i.key === '1:ru_de').choices;
  assert.equal(c2.length, 2);
  assert.ok(c2.includes('Wort1') && c2.includes('Wort2'));

  const one = buildQueue({
    cards: [card(1)], states: [], introducedToday: 0, doneToday: 0,
    now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(one[0].choices, undefined);

  const mixed = buildQueue({
    cards: [card(1, { pos: 'verb' }), card(2, { pos: 'noun' })], states: [], introducedToday: 0,
    doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.ok(mixed.every((i) => i.choices === undefined));
});

test('choices ru_de: одинаковые отображаемые формы не дублируются', () => {
  const cards = [card(1, { term: 'Haus' }), card(2, { term: 'haus' }), card(3, { term: 'Haus' })];
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.ok(q.every((i) => i.choices === undefined));
});

test('choices cloze: cloze_answer других карточек; другие режимы без choices', () => {
  const cards = [1, 2, 3, 4, 5].map((i) => card(i, { ...clozeFor(i), pos: i % 2 ? 'noun' : 'verb' }));
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  const it = q.find((i) => i.key === '1:cloze');
  assert.equal(it.choices.length, 4);
  assert.equal(new Set(it.choices).size, 4);
  assert.ok(it.choices.includes('Ans1'));
  assert.ok(it.choices.every((c) => /^Ans\d$/.test(c)));

  const art = buildQueue({
    cards: [card(1, { pos: 'noun', article: 'der' }), card(2, { pos: 'noun', article: 'die' })],
    states: [], introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(art.find((i) => i.mode === 'article').choices, undefined);
});

// ---- лесенка режимов ----

test('лесенка: освоенная в ru_de карточка получает следующий режим', () => {
  const q = buildQueue({
    cards: [card(1, withCloze)],
    states: [st(1, 'ru_de', FUTURE)],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(q.length, 1);
  assert.equal(q[0].key, '1:cloze');
  assert.equal(q[0].kind, 'review');
  assert.equal(q[0].due, null);
});

test('лесенка: порядок cloze, article; пропуск уже имеющихся', () => {
  const c = card(1, { ...withCloze, pos: 'noun', article: 'der' });
  const q1 = buildQueue({
    cards: [c], states: [st(1, 'ru_de', FUTURE), st(1, 'cloze', FUTURE)],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.deepEqual(q1.map((i) => i.key), ['1:article']);
  const q2 = buildQueue({
    cards: [c], states: [st(1, 'ru_de', FUTURE), st(1, 'cloze', FUTURE), st(1, 'article', FUTURE)],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(q2.length, 0);
  const q3 = buildQueue({
    cards: [c], states: ['ru_de', 'cloze', 'article'].map((m) => st(1, m, FUTURE)),
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(q3.length, 0);
});

test('лесенка: условие освоенности (state >= 2 или stability >= 3)', () => {
  const run = (extra) => buildQueue({
    cards: [card(1, withCloze)], states: [st(1, 'ru_de', FUTURE, extra)],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(run({ state: 1, stability: 2 }).length, 0);
  assert.equal(run({ state: 1, stability: 3 }).length, 1);
  assert.equal(run({ state: 2, stability: 0 }).length, 1);
});

test('лесенка: карточка без подходящих режимов и без ru_de-состояния не участвует', () => {
  const q = buildQueue({
    cards: [card(1), card(2, withCloze)],
    states: [st(1, 'ru_de', FUTURE), st(2, 'cloze', FUTURE)],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(q.length, 0);
});

test('лесенка: дневной лимит NEW_MODES_PER_DAY минус ladderDoneToday', () => {
  assert.equal(NEW_MODES_PER_DAY, 5);
  const cards = [1, 2, 3, 4, 5, 6, 7].map((i) => card(i, withCloze));
  const states = cards.map((c, i) => st(c.id, 'ru_de', FUTURE, { stability: 20 - i }));
  const run = (ladderDoneToday) => buildQueue({
    cards, states, introducedToday: 0, doneToday: 0, ladderDoneToday,
    now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.equal(run(0).length, 5);
  assert.deepEqual(run(3).map((i) => i.key).sort(), ['1:cloze', '2:cloze']);
  assert.equal(run(5).length, 0);
  assert.equal(run(99).length, 0);
});

test('лесенка: идёт до новых карточек и делит лимит сессии', () => {
  const old = [1, 2, 3].map((i) => card(i, withCloze));
  const fresh = [21, 22, 23].map((i) => card(i));
  const q = buildQueue({
    cards: [...old, ...fresh],
    states: old.map((c) => st(c.id, 'ru_de', FUTURE)),
    introducedToday: 0, doneToday: 0, now: NOW,
    settings: { ...NO_AI, max_session_items: 4 }, localDay: DAY,
  });
  assert.equal(q.length, 4);
  assert.equal(q.filter((i) => i.mode === 'cloze' && i.kind === 'review').length, 3);
  assert.equal(q.filter((i) => i.kind === 'new').length, 1);
});

test('shuffle: перемешивает карточки и сохраняет MIN_GAP и ru_de перед вторым режимом', () => {
  const cards = [1, 2, 3, 4, 5, 6].map((i) => card(i, { ...withCloze, pos: 'noun', article: 'der' }));
  let seed = 42;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const q = buildQueue({
    cards, states: [], introducedToday: 0, doneToday: 0, now: NOW,
    settings: NO_AI, localDay: DAY, rng,
  });
  assert.equal(q.length, 12);
  // Для каждой карточки ru_de всегда встречается раньше второго режима
  for (const c of cards) {
    const idxs = q.map((it, idx) => (it.card_id === c.id ? idx : -1)).filter((x) => x >= 0);
    assert.equal(idxs.length, 2);
    assert.equal(q[idxs[0]].mode, 'ru_de');
    assert.ok(idxs[1] - idxs[0] >= MIN_GAP);
  }
});

test('doneKeysToday и LEARNED_STABILITY: пройденные сегодня и выученные карточки не возвращаются', () => {
  const cards = [card(1, withCloze), card(2, withCloze), card(3, withCloze)];
  const states = [
    st(1, 'ru_de', '2026-03-10T07:55:00Z', { state: 1, stability: 2 }), // пройдена 5 минут назад (Good -> шаг 10м)
    st(2, 'ru_de', '2026-03-10T07:55:00Z', { state: 1, stability: 2 }), // ещё не пройдена сегодня
    st(3, 'ru_de', FUTURE, { state: 2, stability: 70 }), // уже выучена (stability >= 60) -> лесенка не добавляет cloze
  ];
  const q = buildQueue({
    cards, states, introducedToday: 0, doneToday: 1,
    doneKeysToday: ['1:ru_de'],
    now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.deepEqual(q.map((i) => i.key), ['2:ru_de']);
});

test('LEARNED_STABILITY = 60: лесенка открывает cloze даже при stability ru_de > 21', () => {
  assert.equal(LEARNED_STABILITY, 60);
  const q = buildQueue({
    cards: [card(1, withCloze)], states: [st(1, 'ru_de', FUTURE, { state: 2, stability: 30 })],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.deepEqual(q.map((i) => i.key), ['1:cloze']);
});

test('article: только для существительных с артиклем, даже если состояние осталось в БД', () => {
  const verb = card(1, { pos: 'verb', article: 'der', ...withCloze });
  const noun = card(2, { pos: 'noun', article: 'die', ...withCloze });
  const q = buildQueue({
    cards: [verb, noun],
    states: [st(1, 'article', '2026-03-01T00:00:00Z'), st(2, 'article', '2026-03-01T00:00:00Z')],
    introducedToday: 0, doneToday: 0, now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.deepEqual(q.map((i) => i.key), ['2:article']);
});

test('bury siblings: успешный cloze сегодня откладывает просроченный ru_de той же карточки', () => {
  const cards = [card(1, withCloze), card(2, withCloze)];
  const states = [
    st(1, 'ru_de', '2026-03-09T00:00:00Z', { state: 2, stability: 5 }),
    st(2, 'ru_de', '2026-03-09T00:00:00Z', { state: 2, stability: 5 }),
  ];
  const q = buildQueue({
    cards, states, introducedToday: 0, doneToday: 1,
    doneKeysToday: ['1:cloze'], goodKeysToday: ['1:cloze'],
    now: NOW, settings: NO_AI, localDay: DAY,
  });
  assert.ok(!q.some((i) => i.key === '1:ru_de'));
  assert.ok(q.some((i) => i.key === '2:ru_de'));
});