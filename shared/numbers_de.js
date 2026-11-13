// Числа по-немецки: озвучка, генерация заданий, проверка ответов. Чистый ESM, без Node/DOM API.

export const CATEGORIES = ['cardinal', 'year', 'date', 'time', 'price', 'phone', 'percent', 'decimal'];
export const MAX_LEVEL = 4;

const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
  'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = { 2: 'zwanzig', 3: 'dreißig', 4: 'vierzig', 5: 'fünfzig', 6: 'sechzig', 7: 'siebzig', 8: 'achtzig', 9: 'neunzig' };
const DIGITS = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const pad2 = (n) => String(n).padStart(2, '0');

// ---------- ГСЧ ----------

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) | 0;
  if (typeof seed === 'string') {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h | 0;
  }
  return (Date.now() & 0x7fffffff) | 0;
}

/** Детерминированный ГСЧ (mulberry32). Возвращает функцию () => [0,1). */
export function makeRng(seed) {
  let a = hashSeed(seed) >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ri = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const clampLevel = (lv) => {
  const n = Number(lv);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_LEVEL, Math.max(1, Math.round(n)));
};

// ---------- Числа словами ----------

// attr = true: «ein» вместо «eins» (перед существительным/тысячей)
function below100(n, attr) {
  if (n < 20) return (n === 1 && attr) ? 'ein' : ONES[n];
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return TENS[t];
  return (u === 1 ? 'ein' : ONES[u]) + 'und' + TENS[t];
}

function below1000(n, attr) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return below100(r, attr);
  let s = (h === 1 ? 'ein' : ONES[h]) + 'hundert';
  if (r > 0) s += below100(r, attr);
  return s;
}

/** Целое 0..999999999 словами (самостоятельная форма: eins, einhundert, eintausend, eine Million). */
export function numberToGerman(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 999999999) throw new RangeError('number out of range');
  if (v === 0) return 'null';
  const m = Math.floor(v / 1e6);
  const rest = v % 1e6;
  const t = Math.floor(rest / 1000);
  const r = rest % 1000;
  let out = '';
  if (m > 0) out = m === 1 ? 'eine Million' : below1000(m, true) + ' Millionen';
  let tail = '';
  if (t > 0) tail += below1000(t, true) + 'tausend';
  if (r > 0) tail += below1000(r, false);
  if (tail) out = out ? out + ' ' + tail : tail;
  return out;
}

// форма перед существительным: ein Euro, ein Prozent
const attr = (n) => numberToGerman(n).replace(/eins$/, 'ein');

/** Год: 1100-1999 сотнями (neunzehnhundert...), иначе обычным числом. */
export function yearToGerman(y) {
  const v = Number(y);
  if (!Number.isInteger(v) || v < 0 || v > 999999999) throw new RangeError('year out of range');
  if (v >= 1100 && v <= 1999) {
    const h = Math.floor(v / 100);
    const r = v % 100;
    return below100(h, false) + 'hundert' + (r ? below100(r, false) : '');
  }
  return numberToGerman(v);
}

function ordinalStem(n) {
  const special = { 1: 'erste', 3: 'dritte', 7: 'siebte', 8: 'achte' };
  if (special[n]) return special[n];
  if (n < 20) return ONES[n] + 'te';
  return below100(n, false) + 'ste';
}

/** Порядковое: form 'nom' -> «der fünfzehnte», 'dat' -> «am fünfzehnten», 'bare' -> «fünfzehnte». */
export function ordinalToGerman(n, form = 'nom') {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 99) throw new RangeError('ordinal out of range');
  const stem = ordinalStem(v);
  if (form === 'dat') return 'am ' + stem + 'n';
  if (form === 'bare') return stem;
  return 'der ' + stem;
}

/** Дата словами. y = null -> без года. */
export function dateToGerman(d, m, y, { form = 'nom' } = {}) {
  const day = Number(d);
  const mon = Number(m);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(mon) || mon < 1 || mon > 12) {
    throw new RangeError('bad date');
  }
  let out = ordinalToGerman(day, form) + ' ' + MONTHS[mon - 1];
  if (y !== null && y !== undefined) out += ' ' + yearToGerman(y);
  return out;
}

/** Время словами: formal (24 ч) или informal (halb, Viertel). */
export function timeToGerman(h, m, { style = 'formal' } = {}) {
  const hh = Number(h);
  const mm = Number(m);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23 || !Number.isInteger(mm) || mm < 0 || mm > 59) {
    throw new RangeError('bad time');
  }
  const formal = () => below100(hh, true) + ' Uhr' + (mm ? ' ' + below100(mm, false) : '');
  if (style !== 'informal') return formal();
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const hn = (h12 % 12) + 1;
  const name = (x) => (x === 1 ? 'eins' : below100(x, false));
  switch (mm) {
    case 0: return (h12 === 1 ? 'ein' : below100(h12, false)) + ' Uhr';
    case 5: return 'fünf nach ' + name(h12);
    case 10: return 'zehn nach ' + name(h12);
    case 15: return 'Viertel nach ' + name(h12);
    case 20: return 'zwanzig nach ' + name(h12);
    case 25: return 'fünf vor halb ' + name(hn);
    case 30: return 'halb ' + name(hn);
    case 35: return 'fünf nach halb ' + name(hn);
    case 40: return 'zwanzig vor ' + name(hn);
    case 45: return 'Viertel vor ' + name(hn);
    case 50: return 'zehn vor ' + name(hn);
    case 55: return 'fünf vor ' + name(hn);
    default: return formal();
  }
}

/** Цена: 12,50 -> «zwölf Euro fünfzig». */
export function priceToGerman(euros, cents) {
  const e = Number(euros);
  const c = Number(cents);
  if (!Number.isInteger(e) || e < 0 || !Number.isInteger(c) || c < 0 || c > 99) throw new RangeError('bad price');
  if (e === 0 && c > 0) return numberToGerman(c) + ' Cent';
  let out = attr(e) + ' Euro';
  if (c > 0) out += ' ' + numberToGerman(c);
  return out;
}

function digitWord(ch, zwo) {
  const w = DIGITS[Number(ch)];
  return zwo && w === 'zwei' ? 'zwo' : w;
}

/** Телефон: grouping 'single' (по цифре) или 'pairs' (парами); zwo = «zwo» вместо «zwei». */
export function phoneToGerman(digits, { grouping = 'single', zwo = false } = {}) {
  const d = String(digits ?? '').replace(/\D/g, '');
  if (!d) throw new RangeError('empty phone');
  if (grouping === 'pairs') {
    const parts = [];
    for (let i = 0; i < d.length; i += 2) {
      const g = d.slice(i, i + 2);
      if (g.length === 1) parts.push(digitWord(g, zwo));
      else if (g[0] === '0') parts.push('null ' + digitWord(g[1], zwo));
      else parts.push(numberToGerman(Number(g)));
    }
    return parts.join(' ');
  }
  return [...d].map((c) => digitWord(c, zwo)).join(' ');
}

function splitDecimal(str) {
  const s = String(str ?? '').trim().replace('.', ',');
  if (!/^\d+(,\d+)?$/.test(s)) throw new RangeError('bad decimal');
  const [i, f = ''] = s.split(',');
  return [i, f];
}

/** Десятичная: «3,5» -> «drei Komma fünf» (после запятой по цифрам). */
export function decimalToGerman(str) {
  const [i, f] = splitDecimal(str);
  let out = numberToGerman(Number(i));
  if (f) out += ' Komma ' + [...f].map((c) => DIGITS[Number(c)]).join(' ');
  return out;
}

/** Проценты: «2,5» -> «zwei Komma fünf Prozent». */
export function percentToGerman(str) {
  const s = String(str ?? '').replace('%', '').trim();
  const [i, f] = splitDecimal(s);
  if (!f) return attr(Number(i)) + ' Prozent';
  return decimalToGerman(s) + ' Prozent';
}

// ---------- Нормализация ответов ----------

function canonDecimal(raw) {
  let s = String(raw).trim().toLowerCase().replace(/prozent|%/g, '').replace(/\s+/g, '');
  const f = s.match(/^(\d+)\/(\d+)$/);
  if (f) {
    const b = Number(f[2]);
    if (!b) return null;
    s = String(Number((Number(f[1]) / b).toFixed(4)));
  }
  s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  let [i, fr = ''] = s.split('.');
  i = i.replace(/^0+(?=\d)/, '');
  fr = fr.replace(/0+$/, '');
  return fr ? i + ',' + fr : i;
}

function normTime(t) {
  const s = t.trim().toLowerCase();
  let m = s.match(/^(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*uhr)?$/);
  if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) {
    const u = s.match(/^(\d{1,2})\s*uhr$/);
    if (u) m = [null, u[1], '00'];
  }
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return pad2(h) + ':' + pad2(mi);
}

function normDate(t) {
  const m = t.trim().match(/^(\d{1,2})[.\-/]\s*(\d{1,2})(?:\.\s*(\d{4})|\.)?$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return pad2(d) + '.' + pad2(mo) + '.' + (m[3] || '');
}

function normPrice(t) {
  let s = t.trim().toLowerCase().replace(/€|euro|eur/g, '').replace(/\s+/g, '');
  if (s.includes(',')) s = s.replace(/[.']/g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(/'/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  let [e, c = ''] = s.split('.');
  e = e.replace(/^0+(?=\d)/, '');
  c = (c + '00').slice(0, 2);
  return e + ',' + c;
}

/** Приводит ответ к каноническому виду категории; null, если не распознан. */
export function normalizeNumberAnswer(category, text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > 60) return null;
  switch (category) {
    case 'cardinal': {
      const s = t.replace(/[\s.'’]/g, '');
      if (!/^\d{1,9}$/.test(s)) return null;
      return s.replace(/^0+(?=\d)/, '');
    }
    case 'year': {
      const s = t.replace(/\s/g, '');
      return /^\d{3,4}$/.test(s) ? s : null;
    }
    case 'date': return normDate(t);
    case 'time': return normTime(t);
    case 'price': return normPrice(t);
    case 'phone': {
      const s = t.replace(/[\s\-/().]/g, '').replace(/^\+/, '');
      return /^\d{3,20}$/.test(s) ? s : null;
    }
    case 'percent':
    case 'decimal': return canonDecimal(t);
    default: return null;
  }
}

// ---------- Проверка ----------

const digitsOf = (s) => String(s).replace(/\D/g, '');

function swapPattern(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const diff = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  if (diff.length !== 2 || diff[1] !== diff[0] + 1) return null;
  const [i, j] = diff;
  if (a[i] !== b[j] || a[j] !== b[i]) return null;
  return i === a.length - 2 ? 'tens_units_swap' : 'digit_swap';
}

function dropsOne(longer, shorter) {
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < longer.length; i++) {
    if (longer.slice(0, i) + longer.slice(i + 1) === shorter) return true;
  }
  return false;
}

function detectPattern(item, exp, norm) {
  if (item.category === 'time') {
    const [eh, em] = exp.split(':').map(Number);
    const [nh, nm] = norm.split(':').map(Number);
    if (em === nm && eh !== nh && (((eh - nh) % 12) + 12) % 12 === 0) return 'ampm';
    if (item.informal && [25, 30, 35].includes(em) && nm === em && (nh - eh + 12) % 12 === 1) return 'halb_trap';
    return 'other';
  }
  const a = digitsOf(exp);
  const b = digitsOf(norm);
  if (!a || !b) return 'other';
  if (a.length <= 3 && b.length <= 3) {
    const na = Number(a);
    const nb = Number(b);
    const teen = (n) => n >= 13 && n <= 19;
    if ((teen(na) && nb === (na - 10) * 10) || (teen(nb) && na === (nb - 10) * 10)) return 'teen_ty';
  }
  const sw = swapPattern(a, b);
  if (sw) return sw;
  const za = a.replace(/0/g, '');
  const zb = b.replace(/0/g, '');
  if (za === zb && za.length > 0 && a.length !== b.length) return 'magnitude';
  if (dropsOne(a, b) || dropsOne(b, a)) return 'digit_drop';
  return 'other';
}

const PATTERN_TIPS = {
  tens_units_swap: 'По-немецки сначала единицы, потом десятки (fünfundzwanzig = 25).',
  teen_ty: 'Не путай -zehn (13–19) и -zig (30–90): sechzehn = 16, sechzig = 60.',
  digit_swap: 'Цифры переставлены местами.',
  digit_drop: 'Пропущена или добавлена лишняя цифра.',
  magnitude: 'Проверь количество нулей.',
  ampm: 'Различай 12- и 24-часовой формат.',
  halb_trap: '«halb vier» — это 3:30 (полчаса до четырёх), а не 4:30.',
};

/** Проверка ответа. -> {correct, normalized, note_ru, pattern|null} */
export function gradeNumber(item, answer) {
  const it = item && typeof item === 'object' ? item : {};
  const cat = it.category;
  const expectedRaw = String(it.expected ?? '');
  const spoken = String(it.spoken ?? '');
  const exp = normalizeNumberAnswer(cat, expectedRaw) ?? expectedRaw;
  const norm = normalizeNumberAnswer(cat, answer);
  if (norm === null) {
    return {
      correct: false,
      normalized: '',
      note_ru: `Ответ не распознан. Правильно: ${expectedRaw} — «${spoken}».`,
      pattern: 'other',
    };
  }
  let correct = norm === exp;
  if (!correct && cat === 'time' && it.informal) {
    const [eh, em] = exp.split(':').map(Number);
    const [nh, nm] = norm.split(':').map(Number);
    correct = em === nm && eh % 12 === nh % 12;
  }
  if (!correct && cat === 'date' && exp.endsWith('.') && norm.startsWith(exp)) correct = true;
  if (correct) {
    return { correct: true, normalized: norm, note_ru: `Верно: «${spoken}».`, pattern: null };
  }
  const pattern = detectPattern(it, exp, norm);
  const tip = PATTERN_TIPS[pattern] ? ' ' + PATTERN_TIPS[pattern] : '';
  return {
    correct: false,
    normalized: norm,
    note_ru: `Неверно. Правильно: ${expectedRaw} — «${spoken}».${tip}`,
    pattern,
  };
}

// ---------- Генерация ----------

const TRAP_NUMBERS = [13, 14, 15, 16, 17, 18, 19, 30, 40, 50, 60, 70, 80, 90];

function cardinalTrap(n) {
  if (n >= 13 && n <= 19) return `${numberToGerman(n)} ≠ ${numberToGerman((n - 10) * 10)}: -zehn и -zig звучат похоже.`;
  if (n >= 30 && n <= 90 && n % 10 === 0) return `${numberToGerman(n)} ≠ ${numberToGerman(n / 10 + 10)}: -zig и -zehn звучат похоже.`;
  if (n >= 21 && n <= 99 && n % 10 !== 0) return 'Сначала единицы, потом десятки: ein-und-zwanzig = 21.';
  return null;
}

function genCardinal(lv, r) {
  let n;
  if (lv === 1) n = ri(r, 0, 20);
  else if (lv === 2) n = r() < 0.3 ? pick(r, TRAP_NUMBERS) : ri(r, 0, 100);
  else if (lv === 3) n = ri(r, 0, 1000);
  else {
    const d = ri(r, 4, 6);
    n = ri(r, 10 ** (d - 1), 10 ** d - 1);
    if (r() < 0.05) n = 1000000;
  }
  return {
    category: 'cardinal', level: lv, spoken: numberToGerman(n), expected: String(n), informal: false,
    hint_ru: 'Запишите число цифрами', trap_ru: cardinalTrap(n),
  };
}

function genYear(lv, r) {
  const y = lv >= 3 && r() < 0.5 ? ri(r, 1100, 1899) : ri(r, 1900, 2099);
  return {
    category: 'year', level: lv, spoken: yearToGerman(y), expected: String(y), informal: false,
    hint_ru: 'Год цифрами', trap_ru: y < 2000 ? 'Годы до 2000 читаются сотнями: 1989 = neunzehnhundert…' : null,
  };
}

const daysIn = (m, y) => {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
};

function genDate(lv, r) {
  const withYear = lv >= 3;
  const y = lv === 3 ? ri(r, 1950, 2030) : ri(r, 1900, 2099);
  const m = ri(r, 1, 12);
  const d = ri(r, 1, daysIn(m, y));
  const form = lv >= 4 && r() < 0.5 ? 'dat' : 'nom';
  return {
    category: 'date', level: lv,
    spoken: dateToGerman(d, m, withYear ? y : null, { form }),
    expected: `${pad2(d)}.${pad2(m)}.` + (withYear ? y : ''),
    informal: false,
    hint_ru: withYear ? 'Дата: ДД.ММ.ГГГГ' : 'Дата: ДД.ММ.',
    trap_ru: form === 'dat' ? '«am» + порядковое с окончанием -n: am fünfzehnten = 15-го.' : null,
  };
}

function genTime(lv, r) {
  const informal = lv >= 3;
  const h = ri(r, 0, 23);
  let m;
  if (lv === 1) m = pick(r, [0, 15, 30, 45]);
  else if (lv === 2) m = ri(r, 0, 59);
  else m = r() < 0.4 ? pick(r, [25, 30, 35]) : pick(r, [0, 5, 10, 15, 20, 40, 45, 50, 55]);
  return {
    category: 'time', level: lv,
    spoken: timeToGerman(h, m, { style: informal ? 'informal' : 'formal' }),
    expected: `${pad2(h)}:${pad2(m)}`, informal,
    hint_ru: informal ? 'Время ЧЧ:ММ (12 или 24 часа)' : 'Время ЧЧ:ММ',
    trap_ru: informal && [25, 30, 35].includes(m) ? '«halb» — половина следующего часа: halb vier = 3:30.' : null,
  };
}

function genPrice(lv, r) {
  let e;
  let c;
  if (lv === 1) { e = ri(r, 1, 20); c = pick(r, [0, 50]); }
  else if (lv === 2) { e = ri(r, 1, 99); c = ri(r, 0, 19) * 5; }
  else { e = ri(r, 1, 999); c = ri(r, 0, 99); }
  return {
    category: 'price', level: lv, spoken: priceToGerman(e, c), expected: `${e},${pad2(c)}`, informal: false,
    hint_ru: 'Цена в евро, формат 12,50', trap_ru: null,
  };
}

function genPhone(lv, r) {
  let grouping;
  let len;
  if (lv === 1) { grouping = 'single'; len = ri(r, 4, 5); }
  else if (lv === 2) { grouping = 'pairs'; len = 6; }
  else if (lv === 3) { grouping = 'pairs'; len = 8; }
  else { grouping = r() < 0.5 ? 'single' : 'pairs'; len = grouping === 'pairs' ? 8 : ri(r, 6, 7); }
  const zwo = lv >= 2 && r() < 0.4;
  const digits = Array.from({ length: len }, () => ri(r, 0, 9)).join('');
  return {
    category: 'phone', level: lv, spoken: phoneToGerman(digits, { grouping, zwo }), expected: digits, informal: false,
    hint_ru: 'Номер телефона, только цифры', trap_ru: zwo ? 'zwo = zwei (чтобы не путать с drei).' : null,
  };
}

function genPercent(lv, r) {
  let s;
  if (lv === 1) s = String(ri(r, 1, 10) * 10);
  else if (lv === 2) s = String(ri(r, 1, 100));
  else if (lv === 3) s = `${ri(r, 0, 20)},5`;
  else s = `${ri(r, 0, 30)},${ri(r, 1, 9)}`;
  return {
    category: 'percent', level: lv, spoken: percentToGerman(s), expected: s, informal: false,
    hint_ru: 'Проценты, без знака %', trap_ru: null,
  };
}

const FRACTIONS = [
  { spoken: 'ein Viertel', expected: '0,25' }, { spoken: 'drei Viertel', expected: '0,75' },
  { spoken: 'ein Fünftel', expected: '0,2' }, { spoken: 'zwei Fünftel', expected: '0,4' },
  { spoken: 'drei Fünftel', expected: '0,6' }, { spoken: 'ein Zehntel', expected: '0,1' },
  { spoken: 'ein Achtel', expected: '0,125' },
];

function genDecimal(lv, r) {
  if (lv >= 4 && r() < 0.5) {
    const f = pick(r, FRACTIONS);
    return {
      category: 'decimal', level: lv, spoken: f.spoken, expected: f.expected, informal: false,
      hint_ru: 'Дробь: можно записать как 1/4 или 0,25', trap_ru: null,
    };
  }
  let s;
  if (lv === 1) s = `${ri(r, 0, 9)},5`;
  else if (lv === 2) s = `${ri(r, 0, 99)},${ri(r, 1, 9)}`;
  else s = `${ri(r, 0, 99)},${ri(r, 0, 9)}${ri(r, 1, 9)}`;
  return {
    category: 'decimal', level: lv, spoken: decimalToGerman(s), expected: s, informal: false,
    hint_ru: 'Десятичная дробь с запятой', trap_ru: null,
  };
}

const GENERATORS = {
  cardinal: genCardinal, year: genYear, date: genDate, time: genTime,
  price: genPrice, phone: genPhone, percent: genPercent, decimal: genDecimal,
};

/** Генерирует NumberItem. Одинаковый seed у rng -> одинаковые задания. */
export function generateItem(category, level, rng) {
  const r = typeof rng === 'function' ? rng : makeRng(1);
  const cat = CATEGORIES.includes(category) ? category : 'cardinal';
  return GENERATORS[cat](clampLevel(level), r);
}

/** Выбор категории: те, где точность < 70%, вдвое вероятнее. */
export function pickCategory(statsByCategory, rng) {
  const r = typeof rng === 'function' ? rng : makeRng(1);
  const stats = statsByCategory && typeof statsByCategory === 'object' ? statsByCategory : {};
  const weights = CATEGORIES.map((c) => {
    const s = stats[c];
    if (!s || typeof s !== 'object') return 1;
    const n = Number(s.n);
    const acc = Number(s.accuracy_30d ?? s.accuracy);
    return n > 0 && Number.isFinite(acc) && acc < 0.7 ? 2 : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < CATEGORIES.length; i++) {
    x -= weights[i];
    if (x < 0) return CATEGORIES[i];
  }
  return CATEGORIES[CATEGORIES.length - 1];
}

/** Уровень: вверх при 8+ верных из последних 10, вниз при 4 и меньше. Меньше 10 результатов — без изменений. */
export function nextLevel(level, recentResults) {
  const lv = clampLevel(level);
  const arr = Array.isArray(recentResults)
    ? recentResults.map((x) => (x && typeof x === 'object' ? !!x.correct : !!x))
    : [];
  if (arr.length < 10) return lv;
  const c = arr.slice(-10).filter(Boolean).length;
  if (c >= 8) return Math.min(MAX_LEVEL, lv + 1);
  if (c <= 5) return Math.max(1, lv - 1);
  return lv;
} 