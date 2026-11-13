import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, applyReview, parseDate } from '../server/srs/engine.js';

const T0 = new Date('2026-01-01T10:00:00.000Z');

test('createEmptyState: поля как в card_state', () => {
  const s = createEmptyState(5, 'cloze', T0);
  assert.deepEqual(s, {
    card_id: 5, mode: 'cloze', state: 0, due: T0.toISOString(),
    stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0,
    learning_steps: 0, reps: 0, lapses: 0, last_review: null,
  });
});

test('applyReview: Good на новой карточке, вход не мутируется', () => {
  const s0 = createEmptyState(1, 'ru_de', T0);
  const copy = JSON.parse(JSON.stringify(s0));
  const s1 = applyReview(s0, 3, T0);
  assert.deepEqual(s0, copy);
  assert.equal(s1.card_id, 1);
  assert.equal(s1.mode, 'ru_de');
  assert.equal(s1.reps, 1);
  assert.ok(new Date(s1.due) > T0);
  assert.equal(s1.last_review, T0.toISOString());
  assert.ok(s1.stability > 0);
  assert.ok(s1.difficulty > 0);
});

test('applyReview: серия Good выводит карточку в Review с интервалом в днях', () => {
  let s = createEmptyState(1, 'ru_de', T0);
  let t = T0;
  for (let i = 0; i < 4; i++) {
    s = applyReview(s, 3, t);
    t = new Date(s.due);
  }
  assert.equal(s.state, 2);
  assert.ok(s.scheduled_days >= 1);
  assert.equal(s.reps, 4);
});

test('applyReview: Again увеличивает lapses и переносит due вперёд', () => {
  let s = createEmptyState(1, 'ru_de', T0);
  let t = T0;
  for (let i = 0; i < 4; i++) {
    s = applyReview(s, 3, t);
    t = new Date(s.due);
  }
  const lapsed = applyReview(s, 1, t);
  assert.equal(lapsed.lapses, 1);
  assert.equal(lapsed.reps, s.reps + 1);
  assert.ok(new Date(lapsed.due) > t);
});

test('applyReview: принимает SQL-даты (UTC) и мусорные поля', () => {
  const s = {
    card_id: 3, mode: 'cloze', state: 2, due: '2026-01-01 10:00:00',
    stability: 'abc', difficulty: null, elapsed_days: -4, scheduled_days: 1,
    learning_steps: 0, reps: 2, lapses: 0, last_review: '2025-12-31 10:00:00',
  };
  const n = applyReview(s, 3, '2026-01-01T10:00:00Z', { requestRetention: 0.85 });
  assert.equal(typeof n.due, 'string');
  assert.ok(Number.isFinite(n.stability));
  assert.ok(Number.isFinite(n.difficulty));
  assert.equal(n.reps, 3);
});

test('applyReview: неверная оценка -> RangeError', () => {
  const s = createEmptyState(1, 'ru_de', T0);
  assert.throws(() => applyReview(s, 0, T0), RangeError);
  assert.throws(() => applyReview(s, 5, T0), RangeError);
  assert.throws(() => applyReview(s, 2.5, T0), RangeError);
  assert.throws(() => applyReview(s, 'x', T0), RangeError);
});

test('parseDate: Date, ISO, SQL(UTC), мусор', () => {
  assert.equal(parseDate('2026-01-01 10:00:00').toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(parseDate('2026-01-01T10:00:00Z').toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(parseDate(T0).getTime(), T0.getTime());
  assert.equal(parseDate('garbage'), null);
  assert.equal(parseDate(null), null);
  assert.equal(parseDate(new Date('x')), null);
});