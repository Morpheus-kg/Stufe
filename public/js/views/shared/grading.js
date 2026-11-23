// Проверка ввода и авто-оценка. Чистые функции, без Node и DOM API.

/** Порог «быстрого» ответа по режимам, мс */
export const FAST_THRESHOLDS_MS = { ru_de: 4000, cloze: 5000, article: 2500 };

const ARTICLES = ['der', 'die', 'das'];
const MAX_TOKENS = 300;
const MAX_CHARS = 2000;
const FOLD_NOTE = 'Засчитано: ae/oe/ue/ss и ä/ö/ü/ß считаются равными.';
// знаки препинания по краям слова (не буквы и не цифры)
const EDGE_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

/** ae/oe/ue/ss -> ä/ö/ü/ß сворачиваем в одну форму (вход уже в нижнем регистре) */
export function foldUmlauts(s) {
  return str(s)
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

/** Разбор строки на слова: {raw (без пунктуации по краям), norm (нижний регистр), fold} */
function tokenize(s) {
  const text = str(s).slice(0, MAX_CHARS).normalize('NFC');
  const out = [];
  for (const piece of text.split(/\s+/)) {
    const raw = piece.replace(EDGE_RE, '');
    if (!raw) continue;
    const norm = raw.toLowerCase();
    out.push({ raw, norm, fold: foldUmlauts(norm) });
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** NFC, нижний регистр, лишние пробелы и пунктуация по краям слов убраны */
export function normalizeAnswer(s) {
  return tokenize(s).map((t) => t.norm).join(' ');
}

/** Расстояние Левенштейна */
function lev(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = Array.from({ length: bl + 1 }, (_, i) => i);
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[bl];
}

/** Таблица LCS по словам: dp[i][j] — длина LCS суффиксов a[i..], e[j..] */
function lcsTable(a, e) {
  const n = a.length;
  const m = e.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].fold === e[j].fold
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/**
 * Пословный diff. same/ins — слова эталона (с исходным регистром),
 * del — лишнее слово из ответа пользователя.
 */
function buildDiff(a, e, dp) {
  const n = a.length;
  const m = e.length;
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].fold === e[j].fold) {
      out.push({ t: 'same', w: e[j].raw });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: 'del', w: a[i].raw });
      i++;
    } else {
      out.push({ t: 'ins', w: e[j].raw });
      j++;
    }
  }
  while (i < n) out.push({ t: 'del', w: a[i++].raw });
  while (j < m) out.push({ t: 'ins', w: e[j++].raw });
  return out;
}

/**
 * Сравнение ответа с эталоном.
 * @returns {{result:'correct'|'almost'|'wrong', note:string, diff:{t:'same'|'del'|'ins', w:string}[]}}
 */
export function gradeTyped(answer, expected) {
  const a = tokenize(answer);
  const e = tokenize(expected);
  const diff = buildDiff(a, e, lcsTable(a, e));

  if (!a.length) return { result: 'wrong', note: 'Пустой ответ.', diff };
  if (!e.length) return { result: 'wrong', note: 'Нет эталонного ответа.', diff };

  const expectedText = e.map((t) => t.raw).join(' ');

  // Полное совпадение (с учётом ae/oe/ue/ss)
  const sameFold = a.length === e.length && a.every((t, i) => t.fold === e[i].fold);
  if (sameFold) {
    const exact = a.every((t, i) => t.norm === e[i].norm);
    return { result: 'correct', note: exact ? '' : FOLD_NOTE, diff };
  }

  // Артикль: ошибка в артикле — всегда wrong
  if (ARTICLES.includes(e[0].norm)) {
    if (ARTICLES.includes(a[0].norm)) {
      if (a[0].norm !== e[0].norm) {
        return { result: 'wrong', note: `Неверный артикль: нужно «${e[0].raw}».`, diff };
      }
    } else {
      const rest = e.slice(1);
      if (a.length === rest.length && a.every((t, i) => t.fold === rest[i].fold)) {
        return { result: 'wrong', note: `Пропущен артикль: «${e[0].raw}».`, diff };
      }
    }
  }

  // Почти верно: ровно одна опечатка (Левенштейн 1) в слове из 5+ букв
  if (a.length === e.length) {
    let idx = -1;
    let bad = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i].fold !== e[i].fold) {
        bad++;
        idx = i;
        if (bad > 1) break;
      }
    }
    if (bad === 1 && e[idx].norm.length >= 5 && lev(a[idx].fold, e[idx].fold) === 1) {
      return {
        result: 'almost',
        note: `Почти верно, опечатка: «${a[idx].raw}» → «${e[idx].raw}».`,
        diff,
      };
    }
  }

  return { result: 'wrong', note: `Неверно. Правильно: «${expectedText}».`, diff };
}

/**
 * Сравнение предложений/текстов. Та же нормализация, что у gradeTyped.
 * similarity = 2*LCS/(len(a)+len(b)); correct — все слова равны; almost — similarity >= 0.8.
 * @returns {{result:'correct'|'almost'|'wrong', similarity:number, diff:{t:string,w:string}[], note:string}}
 */
export function gradeSentence(answer, expected) {
  const a = tokenize(answer);
  const e = tokenize(expected);
  const dp = lcsTable(a, e);
  const diff = buildDiff(a, e, dp);

  if (!a.length) return { result: 'wrong', similarity: 0, diff, note: 'Пустой ответ.' };
  if (!e.length) return { result: 'wrong', similarity: 0, diff, note: 'Нет эталонного текста.' };

  const raw = (2 * dp[0][0]) / (a.length + e.length);
  const similarity = Math.round(raw * 1000) / 1000;
  const pct = Math.round(raw * 100);

  if (a.length === e.length && a.every((t, i) => t.fold === e[i].fold)) {
    const exact = a.every((t, i) => t.norm === e[i].norm);
    return { result: 'correct', similarity: 1, diff, note: exact ? '' : FOLD_NOTE };
  }
  if (raw >= 0.8) {
    return { result: 'almost', similarity, diff, note: `Почти совпадает с эталоном (сходство ${pct}%).` };
  }
  return { result: 'wrong', similarity, diff, note: `Заметно отличается от эталона (сходство ${pct}%).` };
}

/**
 * Авто-оценка FSRS 1..4.
 * @param {{result:string, responseMs?:number|null, hints?:number, mode?:string, difficulty?:string}} p
 */
export function autoRating(p) {
  const { result, responseMs, mode } = p || {};
  const hints = Number(p?.hints) || 0;
  const difficulty = p?.difficulty === 'easy' || p?.difficulty === 'hard' ? p.difficulty : 'medium';

  if (result !== 'correct' && result !== 'almost') return 1;
  if (hints >= 3) return 1;
  if (result === 'almost') return 2;
  if (hints >= 1) return 2;
  if (difficulty === 'easy') return 3; // на лёгком «Easy» не бывает

  const base = FAST_THRESHOLDS_MS[mode] ?? 4000;
  const limit = base * (difficulty === 'hard' ? 1.5 : 1);
  const ms = typeof responseMs === 'number' && Number.isFinite(responseMs) ? responseMs : null;
  return ms !== null && ms >= 0 && ms <= limit ? 4 : 3;
}

const NO_PLURAL_RE = /\b(nur\s+sg|kein\s+pl|singularetantum|pluraletantum|sg\.|pl\.)\b/i;
const SHORT_PLURAL_SUFFIXES = new Set(['en', 'n', 'e', 'er', 's', 'es', 'nen', 'ien', 'se', 'ten', 'ssen']);
const UMLAUT_MAP = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' };

/** Применяет умляут к последней подходящей гласной корня (au->äu, a/o/u->ä/ö/ü) */
function umlautLastVowel(word) {
  const s = str(word);
  // Сначала ищем последний дифтонг au или одиночные a/o/u (кроме e/i)
  const matches = [...s.matchAll(/au|[aou]/gi)];
  if (!matches.length) return s;
  const m = matches[matches.length - 1];
  const idx = m.index;
  const hit = m[0];
  let rep;
  if (hit.length === 2) {
    rep = (hit[0] === 'A' ? 'Ä' : 'ä') + hit[1];
  } else {
    rep = UMLAUT_MAP[hit] || hit;
  }
  return s.slice(0, idx) + rep + s.slice(idx + hit.length);
}

/**
 * Раскрывает сокращённую запись множественного числа ('-en', '¨-e', '-', '-studien')
 * в полную немецкую форму. Для нетестируемых ('nur Sg.', 'null', пусто) возвращает null.
 * @param {string} term существительное без артикля
 * @param {string|null|undefined} rawPlural
 * @returns {string|null}
 */
export function resolvePlural(term, rawPlural) {
  const t = str(term).normalize('NFC').trim();
  let raw = str(rawPlural).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!t || !raw || raw.toLowerCase() === 'null' || NO_PLURAL_RE.test(raw)) return null;
  raw = raw.replace(/^die\s+/i, '').trim();
  if (!raw) return null;

  if (raw === '-' || raw === '–' || raw === '=') return t;

  // Умляут + опциональный суффикс: '¨', '¨-', '¨-e', '¨-er', '-¨e', '¨e'
  const um = /^[-–]?¨[-–]?([a-zäöüß]*)$/i.exec(raw);
  if (um) {
    return umlautLastVowel(t) + (um[1] || '');
  }

  // Суффикс через дефис: '-en', '-s', '-studien'
  if (/^[-–]/.test(raw)) {
    const suffix = raw.replace(/^[-–]+/, '').trim();
    if (!suffix) return t;
    const lowSuf = suffix.toLowerCase();
    if (SHORT_PLURAL_SUFFIXES.has(lowSuf)) {
      return t + suffix;
    }
    // Составная замена конца слова (напр. Fernstudium + -studien -> Fernstudien)
    const lowTerm = t.toLowerCase();
    for (let k = Math.min(lowSuf.length, lowTerm.length); k >= 3; k -= 1) {
      const idx = lowTerm.lastIndexOf(lowSuf.slice(0, k));
      if (idx > 0) return t.slice(0, idx) + suffix;
    }
    return t + suffix;
  }

  return raw;
}