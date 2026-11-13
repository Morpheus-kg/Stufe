import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, MAX_LEVEL, makeRng, numberToGerman, yearToGerman, timeToGerman, priceToGerman,
  percentToGerman, phoneToGerman, dateToGerman, generateItem, gradeNumber, pickCategory,
  nextLevel, normalizeNumberAnswer,
} from '../shared/numbers_de.js';

test('числа словами', () => {
  assert.equal(numberToGerman(21), 'einundzwanzig');
  assert.equal(numberToGerman(101), 'einhunderteins');
  assert.equal(numberToGerman(1001), 'eintausendeins');
  assert.equal(numberToGerman(16), 'sechzehn');
  assert.equal(numberToGerman(60), 'sechzig');
  assert.equal(numberToGerman(17), 'siebzehn');
  assert.equal(numberToGerman(70), 'siebzig');
  assert.equal(numberToGerman(1000000), 'eine Million');
  assert.equal(numberToGerman(2000000), 'zwei Millionen');
  assert.equal(numberToGerman(100), 'einhundert');
  assert.equal(numberToGerman(1000), 'eintausend');
});

test('годы', () => {
  assert.equal(yearToGerman(1989), 'neunzehnhundertneunundachtzig');
  assert.equal(yearToGerman(2024), 'zweitausendvierundzwanzig');
});

test('время', () => {
  assert.equal(timeToGerman(15, 30, { style: 'formal' }), 'fünfzehn Uhr dreißig');
  assert.equal(timeToGerman(15, 30, { style: 'informal' }), 'halb vier');
  assert.equal(timeToGerman(15, 15, { style: 'informal' }), 'Viertel nach drei');
  assert.equal(timeToGerman(15, 25, { style: 'informal' }), 'fünf vor halb vier');
  assert.equal(timeToGerman(15, 45, { style: 'informal' }), 'Viertel vor vier');
});

test('цена, проценты, дата, телефон', () => {
  assert.equal(priceToGerman(12, 50), 'zwölf Euro fünfzig');
  assert.equal(percentToGerman('2,5'), 'zwei Komma fünf Prozent');
  assert.equal(dateToGerman(15, 3, 1980, { form: 'dat' }), 'am fünfzehnten März neunzehnhundertachtzig');
  assert.equal(phoneToGerman('0215', { grouping: 'pairs', zwo: true }), 'null zwo fünfzehn');
});

test('проверка: разделители тысяч', () => {
  const item = { category: 'cardinal', expected: '1250', spoken: 'eintausendzweihundertfünfzig', informal: false };
  for (const a of ['1.250', '1 250', '1250']) assert.equal(gradeNumber(item, a).correct, true, a);
  assert.equal(gradeNumber(item, '1520').correct, false);
});

test('проверка: цена с точкой и запятой', () => {
  const item = { category: 'price', expected: '12,50', spoken: 'zwölf Euro fünfzig', informal: false };
  assert.equal(gradeNumber(item, '12.50').correct, true);
  assert.equal(gradeNumber(item, '12,50').correct, true);
  assert.equal(gradeNumber(item, '12,50 €').correct, true);
  assert.equal(gradeNumber(item, '15,50').correct, false);
});

test('проверка: время', () => {
  const item = { category: 'time', expected: '03:30', spoken: 'drei Uhr dreißig', informal: false };
  assert.equal(gradeNumber(item, '3.30').correct, true);
  assert.equal(gradeNumber(item, '03:30').correct, true);
  const inf = { category: 'time', expected: '15:30', spoken: 'halb vier', informal: true };
  assert.equal(gradeNumber(inf, '3:30').correct, true);
  assert.equal(gradeNumber(inf, '1530').correct, true);
});

test('паттерны ошибок', () => {
  const card = (e) => ({ category: 'cardinal', expected: e, spoken: numberToGerman(Number(e)), informal: false });
  assert.equal(gradeNumber(card('25'), '52').pattern, 'tens_units_swap');
  assert.equal(gradeNumber(card('16'), '60').pattern, 'teen_ty');
  assert.equal(gradeNumber(card('125'), '12').pattern, 'digit_drop');
  assert.equal(gradeNumber(card('1000'), '100').pattern, 'magnitude');
  const inf = { category: 'time', expected: '03:30', spoken: 'halb vier', informal: true };
  assert.equal(gradeNumber(inf, '4:30').pattern, 'halb_trap');
  const formal = { category: 'time', expected: '03:30', spoken: 'drei Uhr dreißig', informal: false };
  assert.equal(gradeNumber(formal, '15:30').pattern, 'ampm');
  assert.equal(gradeNumber(card('7'), 'abc').correct, false);
});

test('дроби и проценты', () => {
  assert.equal(normalizeNumberAnswer('decimal', '1/4'), '0,25');
  assert.equal(normalizeNumberAnswer('decimal', '0.25'), '0,25');
  assert.equal(normalizeNumberAnswer('percent', '2,5 %'), '2,5');
  assert.equal(normalizeNumberAnswer('phone', '+49 (30) 12-34'), '49301234');
});

test('генерация детерминирована при одинаковом seed', () => {
  const run = () => {
    const r = makeRng(12345);
    return Array.from({ length: 20 }, (_, i) => generateItem(CATEGORIES[i % 8], (i % 4) + 1, r));
  };
  assert.deepEqual(run(), run());
});

test('сгенерированные задания согласованы с проверкой', () => {
  const r = makeRng('seed');
  for (const cat of CATEGORIES) {
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      for (let i = 0; i < 30; i++) {
        const it = generateItem(cat, lv, r);
        assert.ok(it.spoken && it.expected, `${cat}/${lv}`);
        assert.equal(gradeNumber(it, it.expected).correct, true, `${cat}/${lv}: ${it.expected}`);
      }
    }
  }
});

test('pickCategory и nextLevel', () => {
  const stats = { time: { n: 10, accuracy_30d: 0.3 } };
  const r = makeRng(7);
  let time = 0;
  for (let i = 0; i < 900; i++) if (pickCategory(stats, r) === 'time') time++;
  assert.ok(time > 140 && time < 260, String(time)); // ожидание ~200 (2/9)
  const t = Array(10).fill(true);
  assert.equal(nextLevel(2, t), 3);
  assert.equal(nextLevel(MAX_LEVEL, t), MAX_LEVEL);
  assert.equal(nextLevel(2, [...Array(5).fill(true), ...Array(5).fill(false)]), 1);
  assert.equal(nextLevel(2, [true, false, true, true, true, true, false, true, true, false]), 2);
  assert.equal(nextLevel(2, [false, false]), 2);
});