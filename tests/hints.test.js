import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHint, MAX_HINT_STEP } from '../shared/hints.js';

test('MAX_HINT_STEP = 3', () => {
  assert.equal(MAX_HINT_STEP, 3);
});

test('шаг 1: первые буквы, ведущий артикль целиком', () => {
  assert.equal(makeHint('die Armut', 1), 'die A____');
  assert.equal(makeHint('Haus', 1), 'H___');
  assert.equal(makeHint('der Tisch', 1), 'der T____');
});

test('шаг 2: первая половина каждого слова', () => {
  assert.equal(makeHint('die Armut', 2), 'die Arm__');
  assert.equal(makeHint('Haus', 2), 'Ha__');
  assert.equal(makeHint('der Tisch', 2), 'der Tis__');
});

test('шаг 3: полное раскрытие', () => {
  assert.equal(makeHint('die Armut', 3), 'die Armut');
  assert.equal(makeHint('  Haus ', 3), 'Haus');
  assert.equal(makeHint('Haus', 7), 'Haus');
});

test('короткие слова (до 2 букв) показываются целиком, артикль только в начале', () => {
  assert.equal(makeHint('ich bin es', 1), 'i__ b__ es');
  assert.equal(makeHint('in der Stadt', 1), 'in d__ S____');
  assert.equal(makeHint('der', 1), 'd__');
});

test('пунктуация по краям сохраняется', () => {
  assert.equal(makeHint('Ich gehe.', 1), 'I__ g___.');
  assert.equal(makeHint('„Haus“', 1), '„H___“');
});

test('мусорный ввод -> пустая строка', () => {
  assert.equal(makeHint(null, 1), '');
  assert.equal(makeHint(undefined, 1), '');
  assert.equal(makeHint('', 1), '');
  assert.equal(makeHint('Haus', 0), '');
  assert.equal(makeHint('Haus', NaN), '');
  assert.equal(makeHint('Haus', 'x'), '');
  assert.equal(makeHint(42, 1), '');
});