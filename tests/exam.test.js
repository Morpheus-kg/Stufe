// Тесты журнала экзамена: days_left и проценты (M7); БД не нужна
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDaysLeft, toExamItem, latestBySkill, examBodySchema, PASS_PCT } from '../server/routes/exam.js';

test('computeDaysLeft', () => {
  assert.equal(computeDaysLeft('2026-11-06', '2026-11-06'), 0);
  assert.equal(computeDaysLeft('2026-11-07', '2026-11-06'), 1);
  assert.equal(computeDaysLeft('2026-11-05', '2026-11-06'), -1);
  assert.equal(computeDaysLeft('2027-03-01', '2026-11-06'), 115);
  assert.equal(computeDaysLeft('2028-03-01', '2028-02-28'), 2); // високосный год
  assert.equal(computeDaysLeft('', '2026-11-06'), null);
  assert.equal(computeDaysLeft('2026-02-30', '2026-11-06'), null);
  assert.equal(computeDaysLeft(null, '2026-11-06'), null);
  assert.equal(computeDaysLeft('мусор', '2026-11-06'), null);
});

test('toExamItem: pct из DECIMAL-строк', () => {
  const it = toExamItem({ id: 1, taken_on: '2026-11-01', skill: 'lesen', points: '45.0', max_points: '75.0', source: null, note: undefined });
  assert.equal(it.pct, 60);
  assert.equal(it.points, 45);
  assert.equal(it.max_points, 75);
  assert.equal(it.source, null);
  assert.equal(it.note, null);
  assert.equal(toExamItem({ id: 2, taken_on: '2026-11-01', skill: 'gesamt', points: '66.7', max_points: '100.0' }).pct, 66.7);
  assert.equal(toExamItem({ id: 3, taken_on: '2026-11-01', skill: 'gesamt', points: '10', max_points: '0' }).pct, 0);
  assert.equal(toExamItem({ id: 4, taken_on: new Date('2026-11-01T00:00:00Z'), skill: 'gesamt', points: 'x', max_points: '100' }).taken_on, '2026-11-01');
  assert.equal(PASS_PCT, 60);
});

test('latestBySkill: последний по дате, затем по id', () => {
  const items = [
    { id: 1, skill: 'lesen', taken_on: '2026-10-01', pct: 50 },
    { id: 2, skill: 'lesen', taken_on: '2026-11-01', pct: 70 },
    { id: 3, skill: 'lesen', taken_on: '2026-11-01', pct: 72 },
    { id: 4, skill: 'hoeren', taken_on: '2026-09-01', pct: 40 },
  ];
  assert.deepEqual(latestBySkill(items), {
    lesen: { pct: 72, taken_on: '2026-11-01' },
    hoeren: { pct: 40, taken_on: '2026-09-01' },
  });
  assert.deepEqual(latestBySkill([]), {});
});

test('examBodySchema: значения по умолчанию и ограничения', () => {
  const ok = examBodySchema.parse({ taken_on: '2026-11-01', skill: 'lesen', points: 45 });
  assert.equal(ok.max_points, 100);
  assert.ok(examBodySchema.safeParse({ taken_on: '2026-11-01', skill: 'gesamt', points: 60, max_points: 60, note: null }).success);
  assert.ok(!examBodySchema.safeParse({ taken_on: '2026-11-01', skill: 'lesen', points: 101 }).success);
  assert.ok(!examBodySchema.safeParse({ taken_on: '2026-13-01', skill: 'lesen', points: 5 }).success);
  assert.ok(!examBodySchema.safeParse({ taken_on: '2026-11-01', skill: 'x', points: 5 }).success);
  assert.ok(!examBodySchema.safeParse({ taken_on: '2026-11-01', skill: 'lesen', points: -1 }).success);
  assert.ok(!examBodySchema.safeParse({ taken_on: '2026-11-01', skill: 'lesen', points: 5, max_points: 0 }).success);
});