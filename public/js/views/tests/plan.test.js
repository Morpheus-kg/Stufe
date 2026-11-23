// Тесты дискретного чек-листа на сегодня (plan.js), соответствия навыков и сводки по навыкам (skills.js); БД не нужна
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, buildChecklist, pickLeastRecent, MAX_ITEMS,
} from '../server/routes/plan.js';
import { skillOfKind, KIND_TO_SKILL, shiftDay } from '../server/activities.js';
import {
  buildBySkill, pickWeakest, buildActivityDays, countErrorCategories,
} from '../server/routes/skills.js';

const DATE = '2026-11-06';
const base = (over = {}) => ({
  date: DATE,
  settings: { max_session_items: 40 },
  lastDone: {},
  doneToday: {},
  cards: { due: 5, new: 3, reviewsToday: 0 },
  texts: {},
  ...over,
});
const kinds = (items) => items.map((i) => i.kind);

test('соответствие видов активности навыкам', () => {
  assert.equal(skillOfKind('reading'), 'lesen');
  for (const k of ['listening', 'dictation_text', 'numbers']) assert.equal(skillOfKind(k), 'hoeren');
  assert.equal(skillOfKind('speaking'), 'sprechen');
  assert.equal(skillOfKind('writing'), 'schreiben');
  assert.equal(skillOfKind('translation'), 'schreiben');
  assert.equal(skillOfKind('lookup'), null);
  assert.equal(skillOfKind('toString'), null);
  assert.equal(Object.keys(KIND_TO_SKILL).length, 7);
});

test('карточки идут первыми и только если есть что повторять или уже повторяли сегодня', () => {
  const p = buildChecklist(base());
  assert.equal(p[0].kind, 'cards');
  assert.equal(p[0].route, '#/review');
  assert.equal(p[0].target_label, '8 карт.');
  const none = buildPlan(base({ cards: { due: 0, new: 0, reviewsToday: 0 } }));
  assert.ok(!kinds(none).includes('cards'));
});

test('дискретный чек-лист включает карточки, текст/аудирование, Satzbau и активный навык', () => {
  const p = buildChecklist(base());
  assert.equal(p.length, 4);
  assert.ok(p.length <= MAX_ITEMS);
  assert.equal(p[0].kind, 'cards');
  assert.ok(['reading', 'listening', 'numbers', 'dictation_text'].includes(p[1].kind));
  assert.equal(p[2].kind, 'translation');
  assert.ok(['writing', 'speaking', 'retell'].includes(p[3].kind));
});

test('ротация текста и аудирования: выбирается наиболее давно выполненное', () => {
  assert.equal(buildChecklist(base({ lastDone: {} }))[1].kind, 'reading');
  assert.equal(buildChecklist(base({ lastDone: { reading: '2026-11-05' } }))[1].kind, 'listening');
  assert.equal(buildChecklist(base({ lastDone: { reading: '2026-11-05', listening: '2026-11-05' } }))[1].kind, 'numbers');
  assert.equal(
    buildChecklist(base({ lastDone: { reading: '2026-11-05', listening: '2026-11-05', numbers: '2026-11-04' } }))[1].kind,
    'dictation_text',
  );
  assert.equal(pickLeastRecent(['a', 'b'], {}), 'a');
});

test('продуктивный навык: writing если не было больше недели, иначе чередование speaking / retell', () => {
  assert.equal(buildChecklist(base({ lastDone: {} }))[3].kind, 'writing');
  assert.equal(buildChecklist(base({ lastDone: { writing: shiftDay(DATE, -8) } }))[3].kind, 'writing');
  assert.equal(buildChecklist(base({ lastDone: { writing: shiftDay(DATE, -3) } }))[3].kind, 'speaking');
  assert.equal(
    buildChecklist(base({ lastDone: { writing: '2026-11-03', speaking: '2026-11-05' } }))[3].kind,
    'retell',
  );
});

test('done: карточки и остальные задачи чек-листа', () => {
  const p = buildChecklist(base({ cards: { due: 30, new: 0, reviewsToday: 10 }, doneToday: { reading: true, translation: true } }));
  assert.equal(p.find((i) => i.kind === 'cards').done, true);
  assert.equal(p.find((i) => i.kind === 'reading').done, true);
  assert.equal(p.find((i) => i.kind === 'translation').done, true);
  const q = buildChecklist(base({ cards: { due: 30, new: 0, reviewsToday: 9 } }));
  assert.equal(q.find((i) => i.kind === 'cards').done, false);
  const small = buildChecklist(base({ cards: { due: 2, new: 0, reviewsToday: 2 } }));
  assert.equal(small.find((i) => i.kind === 'cards').done, true);
  const all = buildChecklist(base({ cards: { due: 0, new: 0, reviewsToday: 4 } }));
  assert.equal(all[0].kind, 'cards');
  assert.equal(all[0].done, true);
});

test('маршруты: сохранённые тексты и экраны генерации', () => {
  const withReading = buildChecklist(base({ texts: { reading: 7 } }));
  assert.equal(withReading.find((i) => i.kind === 'reading').route, '#/text/7');
  const withListening = buildChecklist(base({ lastDone: { reading: '2026-11-05' }, texts: { listening: 9 } }));
  assert.equal(withListening.find((i) => i.kind === 'listening').route, '#/listen/9');
  const empty = buildChecklist(base({ texts: {} }));
  assert.equal(empty.find((i) => i.kind === 'reading').route, '#/texts?new=1');
  const bad = buildChecklist(base({ texts: { reading: 'x', listening: -1 } }));
  assert.equal(bad.find((i) => i.kind === 'reading').route, '#/texts?new=1');
});

test('пункты чек-листа содержат все поля', () => {
  for (const it of buildChecklist(base())) {
    assert.deepEqual(Object.keys(it).sort(), ['done', 'id', 'kind', 'params', 'reason_ru', 'route', 'target_label', 'title']);
    assert.ok(typeof it.target_label === 'string' && it.target_label.length > 0);
  }
});

// --- сводка по навыкам (skills.js) ---
test('buildBySkill: минуты, точность, тренд', () => {
  const rows = [
    { day: '2026-11-06', skill: 'hoeren', secs: 600, n: 4, sum01: 4 },
    { day: '2026-11-05', skill: 'hoeren', secs: 300, n: 0, sum01: 0 },
    { day: '2026-10-01', skill: 'hoeren', secs: 900, n: 4, sum01: 1 }, // вне окна 30 дней
    { day: '2026-10-20', skill: 'hoeren', secs: 60, n: 4, sum01: 2 },
    { day: '2026-11-06', skill: 'unknown', secs: 60, n: 1, sum01: 1 },
  ];
  const r = buildBySkill(rows, '2026-11-06');
  assert.equal(r.hoeren.minutes_7d, 15);
  assert.equal(r.hoeren.minutes_30d, 16);
  assert.equal(r.hoeren.accuracy_30d, 0.75);
  assert.equal(r.hoeren.trend, 'up');
  assert.equal(r.lesen.accuracy_30d, null);
  assert.equal(r.lesen.trend, null);
  assert.equal(Object.keys(r).length, 5);
});

test('pickWeakest', () => {
  const r = buildBySkill([{ day: '2026-11-06', skill: 'hoeren', secs: 60, n: 5, sum01: 5 }], '2026-11-06');
  assert.equal(pickWeakest(r), 'lesen'); // без оценок = слабее
  assert.equal(pickWeakest(buildBySkill([], '2026-11-06')), null);
});

test('buildActivityDays: активности и карточки', () => {
  const d = buildActivityDays(
    [{ day: '2026-11-05', kind: 'reading', secs: 120 }, { day: '2026-11-05', kind: 'numbers', secs: 60 }],
    [{ day: '2026-11-05', reviews: 10, secs: 120 }, { day: '2026-11-04', reviews: 0, secs: 0 }],
    '2026-11-06',
  );
  assert.deepEqual(d, [{ day: '2026-11-05', minutes: 5, kinds: ['cards', 'numbers', 'reading'] }]);
});

test('countErrorCategories: валидный и битый JSON не роняют', () => {
  const c = countErrorCategories([
    JSON.stringify([{ category: 'artikel' }, { category: 'kasus' }, { category: 'странное' }, null, 5]),
    JSON.stringify({ items: [{ errors: [{ category: 'artikel' }] }, null, { errors: 'x' }], summary: {} }),
    JSON.stringify({ errors: [{ category: 'KASUS ' }, { nocat: 1 }] }),
    '{битый json', '', null, undefined, '42', '"text"',
  ]);
  assert.deepEqual(c, { artikel: 2, kasus: 2, sonstiges: 1 });
});
