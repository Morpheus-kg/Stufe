import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, gradeTyped, gradeSentence, autoRating } from '../shared/grading.js';

test('normalizeAnswer: регистр, пробелы, пунктуация', () => {
  assert.equal(normalizeAnswer('  Der   TISCH. '), 'der tisch');
  assert.equal(normalizeAnswer('„Hallo“, Welt!'), 'hallo welt');
  assert.equal(normalizeAnswer(null), '');
  assert.equal(normalizeAnswer(undefined), '');
  assert.equal(normalizeAnswer({}), '');
});

test('gradeTyped: точное совпадение, регистр и пунктуация', () => {
  const r = gradeTyped('der tisch.', 'der Tisch');
  assert.equal(r.result, 'correct');
  assert.equal(r.note, '');
  assert.ok(r.diff.every((d) => d.t === 'same'));
  assert.equal(gradeTyped('  Ich  gehe nach Hause!  ', 'Ich gehe nach Hause.').result, 'correct');
});

test('gradeTyped: ae/oe/ue/ss равны ä/ö/ü/ß', () => {
  const r = gradeTyped('Maedchen', 'Mädchen');
  assert.equal(r.result, 'correct');
  assert.match(r.note, /ae/);
  assert.equal(gradeTyped('Strasse', 'Straße').result, 'correct');
  assert.equal(gradeTyped('Uebung', 'Übung').result, 'correct');
  assert.equal(gradeTyped('Mädchen', 'Mädchen').note, '');
});

test('gradeTyped: almost — одна опечатка в слове от 5 букв', () => {
  const r = gradeTyped('der Tish', 'der Tisch');
  assert.equal(r.result, 'almost');
  assert.match(r.note, /Tisch/);
  assert.equal(gradeTyped('Hous', 'Haus').result, 'wrong');
  assert.equal(gradeTyped('Tsh', 'Tisch').result, 'wrong');
  assert.equal(gradeTyped('der Tish gut', 'der Tisch schlecht').result, 'wrong');
});

test('gradeTyped: неверный артикль — всегда wrong с пометкой', () => {
  const r = gradeTyped('die Tisch', 'der Tisch');
  assert.equal(r.result, 'wrong');
  assert.match(r.note, /артикль/i);
  assert.deepEqual(r.diff, [
    { t: 'del', w: 'die' },
    { t: 'ins', w: 'der' },
    { t: 'same', w: 'Tisch' },
  ]);
  const missing = gradeTyped('Tisch', 'der Tisch');
  assert.equal(missing.result, 'wrong');
  assert.match(missing.note, /артикль/i);
});

test('gradeTyped: diff по словам', () => {
  const r = gradeTyped('ich gehe heute Hause', 'ich gehe nach Hause');
  assert.equal(r.result, 'wrong');
  assert.deepEqual(r.diff.map((d) => d.t), ['same', 'same', 'del', 'ins', 'same']);
  assert.equal(r.diff[2].w, 'heute');
  assert.equal(r.diff[3].w, 'nach');
});

test('gradeTyped: мусорный ввод не падает', () => {
  assert.equal(gradeTyped(null, 'der Tisch').result, 'wrong');
  assert.equal(gradeTyped('', 'der Tisch').result, 'wrong');
  assert.equal(gradeTyped(undefined, undefined).result, 'wrong');
  assert.equal(gradeTyped({}, 'x').result, 'wrong');
  assert.equal(gradeTyped('abc', '').result, 'wrong');
  assert.equal(gradeTyped('x '.repeat(5000), 'y').result, 'wrong');
});

test('gradeSentence: идентичные тексты (регистр и пунктуация не важны)', () => {
  const r = gradeSentence('ich gehe nach hause!', 'Ich gehe nach Hause.');
  assert.equal(r.result, 'correct');
  assert.equal(r.similarity, 1);
  assert.equal(r.note, '');
  assert.ok(r.diff.every((d) => d.t === 'same'));
});

test('gradeSentence: ae/oe/ue/ss считаются равными', () => {
  const r = gradeSentence('Die Strasse ist schoen', 'Die Straße ist schön');
  assert.equal(r.result, 'correct');
  assert.match(r.note, /ae/);
});

test('gradeSentence: almost при сходстве >= 0.8', () => {
  const r = gradeSentence('Ich gehe nach Hause', 'Ich gehe heute nach Hause');
  assert.equal(r.result, 'almost');
  assert.ok(r.similarity >= 0.8 && r.similarity < 1);
  assert.ok(r.diff.some((d) => d.t === 'ins' && d.w === 'heute'));
});

test('gradeSentence: wrong при низком сходстве и расчёт similarity', () => {
  const r = gradeSentence('Das Wetter ist schlecht', 'Ich gehe nach Hause');
  assert.equal(r.result, 'wrong');
  assert.equal(r.similarity, 0);
  // 2 общих слова из 3 и 4: 2*2/7
  const r2 = gradeSentence('a b c', 'a x c d');
  assert.equal(r2.result, 'wrong');
  assert.equal(r2.similarity, Math.round((4 / 7) * 1000) / 1000);
});

test('gradeSentence: мусорный ввод не падает', () => {
  assert.equal(gradeSentence('', 'Haus').result, 'wrong');
  assert.equal(gradeSentence(null, 'Haus').similarity, 0);
  assert.equal(gradeSentence('Haus', '').result, 'wrong');
  assert.equal(gradeSentence(undefined, undefined).result, 'wrong');
  assert.equal(gradeSentence({}, [] ).result, 'wrong');
});

test('autoRating (medium по умолчанию)', () => {
  assert.equal(autoRating({ result: 'wrong', responseMs: 100, hints: 0, mode: 'ru_de' }), 1);
  assert.equal(autoRating({ result: 'almost', responseMs: 100, hints: 0, mode: 'ru_de' }), 2);
  assert.equal(autoRating({ result: 'correct', responseMs: 100, hints: 1, mode: 'ru_de' }), 2);
  assert.equal(autoRating({ result: 'correct', responseMs: 3000, hints: 0, mode: 'ru_de' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 4000, hints: 0, mode: 'ru_de' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 4001, hints: 0, mode: 'ru_de' }), 3);
  assert.equal(autoRating({ result: 'correct', responseMs: 5000, hints: 0, mode: 'cloze' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 5001, hints: 0, mode: 'cloze' }), 3);
  assert.equal(autoRating({ result: 'correct', responseMs: 2500, hints: 0, mode: 'article' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 2501, hints: 0, mode: 'article' }), 3);
  assert.equal(autoRating({ result: 'correct', responseMs: 4000, hints: 0, mode: 'ru_de' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 4001, hints: 0, mode: 'ru_de' }), 3);
  assert.equal(autoRating({ result: 'correct', hints: 0, mode: 'ru_de' }), 3);
  assert.equal(autoRating({ result: 'correct', responseMs: null, hints: 0, mode: 'ru_de' }), 3);
  assert.equal(autoRating(undefined), 1);
});

test('autoRating: подсказки 3 -> 1', () => {
  assert.equal(autoRating({ result: 'correct', responseMs: 100, hints: 3, mode: 'ru_de' }), 1);
  assert.equal(autoRating({ result: 'almost', responseMs: 100, hints: 3, mode: 'ru_de' }), 1);
  assert.equal(autoRating({ result: 'correct', responseMs: 100, hints: 2, mode: 'ru_de' }), 2);
});

test('autoRating: easy никогда не 4', () => {
  assert.equal(autoRating({ result: 'correct', responseMs: 100, hints: 0, mode: 'ru_de', difficulty: 'easy' }), 3);
  assert.equal(autoRating({ result: 'wrong', difficulty: 'easy' }), 1);
  assert.equal(autoRating({ result: 'almost', difficulty: 'easy' }), 2);
});

test('autoRating: hard — порог x1.5', () => {
  assert.equal(autoRating({ result: 'correct', responseMs: 6000, hints: 0, mode: 'ru_de', difficulty: 'hard' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 6001, hints: 0, mode: 'ru_de', difficulty: 'hard' }), 3);
  assert.equal(autoRating({ result: 'correct', responseMs: 7500, hints: 0, mode: 'cloze', difficulty: 'hard' }), 4);
  assert.equal(autoRating({ result: 'correct', responseMs: 7501, hints: 0, mode: 'cloze', difficulty: 'hard' }), 3);
  // неизвестная сложность = medium
  assert.equal(autoRating({ result: 'correct', responseMs: 5000, hints: 0, mode: 'ru_de', difficulty: 'zzz' }), 3);
});