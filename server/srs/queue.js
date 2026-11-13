// Построение очереди на сегодня. Чистая функция, без обращения к БД.
import { createHash } from 'node:crypto';
import { parseDate } from './engine.js';
import { MODES } from '../../shared/constants.js';

/** Минимальная дистанция между элементами одной карточки (позиции i и j: |i-j| >= MIN_GAP) */
export const MIN_GAP = 4;
/** Лесенка режимов: максимум новых режимов для старых карточек в день */
export const NEW_MODES_PER_DAY = 5;
/** Порог стабильности (в днях), при котором карточка считается выученной (mature) */
export const LEARNED_STABILITY = 60;

const LADDER_MODES = ['cloze', 'article'];
const LADDER_MIN_STABILITY = 3;
const LEVEL_RANK = { B1: 0, B2: 1, C1: 2 };
const ARTICLES = ['der', 'die', 'das'];
const SECOND_MODES = ['cloze', 'article'];

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function parseExamplesList(card) {
  const raw = card?.examples ?? card?.examples_json;
  if (!raw) return null;
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  const valid = arr.filter((x) => x && typeof x === 'object' && nonEmpty(x.cloze) && nonEmpty(x.answer));
  return valid.length ? valid : null;
}

/** Подходит ли карточка для режима */
export function isEligible(card, mode) {
  if (!card) return false;
  switch (mode) {
    case 'ru_de': return true;
    case 'cloze': return (nonEmpty(card.example_cloze) && nonEmpty(card.cloze_answer)) || Boolean(parseExamplesList(card));
    case 'article': return card.pos === 'noun' && ARTICLES.includes(card.article);
    default: return false;
  }
}

/** Отображаемая форма: «article term» или term */
export function displayForm(card) {
  const t = String(card?.term ?? '').trim();
  return ARTICLES.includes(card?.article) ? `${card.article} ${t}` : t;
}

function shuffleInPlace(arr, rng) {
  if (!rng || !Array.isArray(arr) || arr.length < 2) return arr;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickSecondMode(card, rng = null) {
  const elig = SECOND_MODES.filter((m) => isEligible(card, m));
  if (!elig.length) return null;
  if (!rng || elig.length === 1) return elig[0];
  return elig[Math.floor(rng() * elig.length)];
}

function pickClozeCard(card, day = '', reps = 0) {
  const list = parseExamplesList(card);
  if (!list || list.length <= 1) return card;
  const dayHash = String(day).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const idx = Math.abs((Number(reps) || 0) + dayHash + (Number(card.id) || 0)) % list.length;
  const v = list[idx];
  return {
    ...card,
    example: v.de || card.example,
    example_translation: v.ru ?? card.example_translation,
    example_cloze: v.cloze,
    cloze_answer: v.answer,
  };
}

function makeItem(card, mode, kind, due, day = '', reps = 0) {
  const effectiveCard = mode === 'cloze' ? pickClozeCard(card, day, reps) : card;
  return {
    key: `${card.id}:${mode}`,
    card_id: card.id,
    mode,
    kind,
    card: effectiveCard,
    due: due ? due.toISOString() : null,
  };
}

/** Варианты ответа для ru_de и cloze: 2..4 разных строки, порядок задан хэшем key+день */
function withChoices(item, cards, day) {
  if (item.mode !== 'ru_de' && item.mode !== 'cloze') return item;
  const card = item.card;
  const isRu = item.mode === 'ru_de';
  const valueOf = (c) => (isRu ? displayForm(c) : String(c.cloze_answer ?? '').trim());
  const correct = valueOf(card);
  if (!correct) return item;

  const seen = new Set([correct.toLowerCase()]);
  const pool = [];
  for (const o of cards) {
    if (o.id === card.id) continue;
    if (isRu && o.pos !== card.pos) continue;
    const v = valueOf(o);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    pool.push({ v, h: sha(`${item.key}|${day}|pick|${o.id}`) });
  }
  if (!pool.length) return item;

  pool.sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : 0));
  const picked = [correct, ...pool.slice(0, 3).map((p) => p.v)]
    .map((v) => ({ v, h: sha(`${item.key}${day}|${v}`) }))
    .sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : 0))
    .map((p) => p.v);
  return { ...item, choices: picked };
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normSettings(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    new_per_day: clampInt(o.new_per_day, 10, 0, 1000),
    max_reviews_per_day: clampInt(o.max_reviews_per_day, 150, 0, 10000),
    max_session_items: clampInt(o.max_session_items, 40, 0, 1000),
    ai_enabled: o.ai_enabled !== false,
  };
}

/** Число нарушений: пары одной карточки ближе MIN_GAP */
function violations(order) {
  let v = 0;
  const last = new Map();
  order.forEach((it, i) => {
    const p = last.get(it.card_id);
    if (p !== undefined && i - p < MIN_GAP) v++;
    last.set(it.card_id, i);
  });
  return v;
}

/** Жадная расстановка; byCount — приоритет карточкам с большим числом оставшихся элементов */
function arrange(items, byCount) {
  const remaining = items.map((it) => ({ it }));
  const cnt = new Map();
  for (const it of items) cnt.set(it.card_id, (cnt.get(it.card_id) || 0) + 1);
  const last = new Map();
  const out = [];
  // кортеж: [допустим, приоритет по счётчику, дистанция для недопустимых]
  const better = (x, y) => (x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2]);

  while (remaining.length) {
    const pos = out.length;
    let best = -1;
    let bestScore = null;
    for (let k = 0; k < remaining.length; k++) {
      const cid = remaining[k].it.card_id;
      const p = last.get(cid);
      const gap = p === undefined ? Infinity : pos - p;
      const ok = gap >= MIN_GAP;
      const score = [ok ? 1 : 0, ok && byCount ? cnt.get(cid) : 0, ok ? 0 : gap];
      if (best === -1 || better(score, bestScore)) {
        best = k;
        bestScore = score;
      }
    }
    const [picked] = remaining.splice(best, 1);
    out.push(picked.it);
    last.set(picked.it.card_id, pos);
    cnt.set(picked.it.card_id, cnt.get(picked.it.card_id) - 1);
  }
  return out;
}

/** Перемешивание так, чтобы одна карточка не повторялась ближе MIN_GAP (по возможности) */
export function interleave(items) {
  if (!Array.isArray(items) || items.length < 2) return Array.isArray(items) ? items.slice() : [];
  const a = arrange(items, false);
  const va = violations(a);
  if (va === 0) return a;
  const b = arrange(items, true);
  return violations(b) < va ? b : a;
}

/**
 * Очередь на сегодня.
 * @param {object} args
 * @param {object[]} args.cards Card[]
 * @param {object[]} args.states строки card_state (due/last_review — ISO или SQL UTC)
 * @param {number} args.introducedToday сколько карточек введено сегодня
 * @param {number} args.doneToday сколько ответов уже сделано сегодня
 * @param {Date|string} args.now
 * @param {object} args.settings результат getSettings()
 * @param {number[]} [args.introducedIds] (необяз.) id введённых сегодня, новые первыми
 * @param {number[]} [args.lapsedIds] (необяз.) id с «Again» сегодня, последние первыми
 * @param {number} [args.ladderDoneToday] (необяз.) сколько новых режимов лесенки уже введено сегодня
 * @param {string} [args.localDay] (необяз.) локальный день 'YYYY-MM-DD' для детерминированных choices
 */
export function buildQueue(args) {
  const a = args && typeof args === 'object' ? args : {};
  const nowD = parseDate(a.now) ?? new Date();
  const s = normSettings(a.settings);
  const day = typeof a.localDay === 'string' && a.localDay ? a.localDay : nowD.toISOString().slice(0, 10);
  const introducedToday = Math.max(0, Number(a.introducedToday) || 0);
  const doneToday = Math.max(0, Number(a.doneToday) || 0);
  const ladderDone = Math.max(0, Number(a.ladderDoneToday) || 0);
  const introducedIds = Array.isArray(a.introducedIds) ? a.introducedIds.map(Number) : [];
  let lapsedIds = Array.isArray(a.lapsedIds) ? a.lapsedIds.map(Number) : [];
  const rng = typeof a.rng === 'function' ? a.rng : a.shuffle ? Math.random : null;
  const doneSet = new Set(
    Array.isArray(a.doneKeysToday)
      ? a.doneKeysToday.map(String)
      : a.doneKeysToday instanceof Set
        ? [...a.doneKeysToday].map(String)
        : [],
  );
  const doneCardsToday = new Set([...doneSet].map((k) => Number(k.split(':')[0])).filter(Number.isFinite));
  // Связанный сдвиг (bury siblings): успешный ответ (rating >= 3) в сложном режиме сегодня откладывает ru_de той же карточки на завтра
  const goodSet = new Set(Array.isArray(a.goodKeysToday) ? a.goodKeysToday.map(String) : a.goodKeysToday instanceof Set ? [...a.goodKeysToday].map(String) : []);
  const buriedRuDe = new Set();
  for (const k of goodSet) {
    const [cid, mode] = k.split(':');
    if (mode === 'cloze' || mode === 'article') buriedRuDe.add(Number(cid));
  }

  const cardById = new Map();
  for (const c of Array.isArray(a.cards) ? a.cards : []) {
    if (!c || !Number.isInteger(Number(c.id))) continue;
    if (c.active === false || c.active === 0) continue;
    cardById.set(Number(c.id), { ...c, id: Number(c.id) });
  }

  // Состояния: какие карточки уже «не новые», какие просрочены, какие режимы уже есть
  const hasState = new Set();
  const modesOf = new Map();
  const ruDeState = new Map();
  const dueRows = [];
  const relearning = [];
  for (const st of Array.isArray(a.states) ? a.states : []) {
    if (!st || !MODES.includes(st.mode)) continue;
    const cid = Number(st.card_id);
    hasState.add(cid);
    if (!modesOf.has(cid)) modesOf.set(cid, new Set());
    modesOf.get(cid).add(st.mode);
    if (st.mode === 'ru_de') ruDeState.set(cid, st);
    const due = parseDate(st.due);
    if (due && due <= nowD && !doneSet.has(`${cid}:${st.mode}`) && !(st.mode === 'ru_de' && buriedRuDe.has(cid))) {
      dueRows.push({ cid, mode: st.mode, due, reps: Number(st.reps) || 0 });
    }
    const lr = parseDate(st.last_review);
    if (Number(st.state) === 3 && lr && nowD - lr <= 24 * 3600 * 1000) relearning.push({ cid, lr });
  }

  // (1) просроченные: по due, с лимитом
  dueRows.sort((x, y) => x.due - y.due || x.cid - y.cid || MODES.indexOf(x.mode) - MODES.indexOf(y.mode));
  const reviewCap = Math.max(0, s.max_reviews_per_day - doneToday);
  const dueItems = [];
  for (const r of dueRows) {
    if (dueItems.length >= reviewCap || dueItems.length >= s.max_session_items) break;
    const card = cardById.get(r.cid);
    if (!card || !isEligible(card, r.mode)) continue;
    dueItems.push(makeItem(card, r.mode, 'review', r.due, day, r.reps));
  }

  // (5 контракта v1) лесенка режимов: освоенной в ru_de карточке — один следующий режим (выученные stability >= LEARNED_STABILITY (60) и уже пройденные сегодня пропускаем)
  const ladderCap = Math.max(0, Math.min(NEW_MODES_PER_DAY - ladderDone, s.max_session_items - dueItems.length));
  const ladderItems = [];
  if (ladderCap > 0) {
    const cands = [];
    for (const [cid, st] of ruDeState) {
      if (doneCardsToday.has(cid)) continue;
      const stab = Number(st.stability) || 0;
      if (stab >= LEARNED_STABILITY) continue;
      const mastered = Number(st.state) >= 2 || stab >= LADDER_MIN_STABILITY;
      if (!mastered) continue;
      const card = cardById.get(cid);
      if (!card) continue;
      const have = modesOf.get(cid) ?? new Set();
      const avail = LADDER_MODES.filter((m) => isEligible(card, m) && !have.has(m));
      const next = avail.length ? (rng && avail.length > 1 ? avail[Math.floor(rng() * avail.length)] : avail[0]) : null;
      if (next) cands.push({ card, mode: next, stab: Number(st.stability) || 0, reps: Number(st.reps) || 0 });
    }
    if (rng) shuffleInPlace(cands, rng);
    else cands.sort((x, y) => y.stab - x.stab || x.card.id - y.card.id);
    for (const c of cands.slice(0, ladderCap)) ladderItems.push(makeItem(c.card, c.mode, 'review', null, day, c.reps));
  }

  // (2) новые: level asc, id asc (или случайно внутри уровня при shuffle); пара ru_de + второй режим всегда целиком
  const newLimit = Math.max(0, s.new_per_day - introducedToday);
  const rawNew = [...cardById.values()].filter((c) => !hasState.has(c.id));
  if (rng) shuffleInPlace(rawNew, rng);
  const newCards = rawNew.sort((x, y) => (LEVEL_RANK[x.level] ?? 1) - (LEVEL_RANK[y.level] ?? 1) || (rng ? 0 : x.id - y.id));
  const newItems = [];
  const newIds = [];
  let slots = s.max_session_items - dueItems.length - ladderItems.length;
  for (const c of newCards) {
    if (newIds.length >= newLimit || slots <= 0) break;
    const second = pickSecondMode(c, rng);
    const need = second ? 2 : 1;
    if (need > slots) continue;
    newItems.push(makeItem(c, 'ru_de', 'new', null, day, 0));
    if (second) newItems.push(makeItem(c, second, 'new', null, day, 0));
    newIds.push(c.id);
    slots -= need;
  }

  // (3) перемешивание, (4) лимит на сессию, затем варианты ответа
  const pool = [...cardById.values()];
  let combined = [...dueItems, ...ladderItems, ...newItems];
  if (rng && combined.length > 1) {
    // Перемешиваем порядок карточек в очереди, сохраняя внутренний порядок режимов одной карточки (ru_de перед вторым режимом)
    const groups = new Map();
    for (const it of combined) {
      if (!groups.has(it.card_id)) groups.set(it.card_id, []);
      groups.get(it.card_id).push(it);
    }
    const groupList = [...groups.values()];
    shuffleInPlace(groupList, rng);
    combined = groupList.flat();
  }
  const queue = interleave(combined)
    .slice(0, s.max_session_items)
    .map((it) => withChoices(it, pool, day));

  // (6) не более одной задачи «предложение»
  if (s.ai_enabled) {
    if (!lapsedIds.length) {
      lapsedIds = relearning.sort((x, y) => y.lr - x.lr).map((r) => r.cid);
    }
    const usable = (id) => cardById.has(id) && nonEmpty(cardById.get(id).term);
    const pickedId = lapsedIds.find(usable)
      ?? introducedIds.find(usable)
      ?? [...newIds].reverse().find(usable);
    if (pickedId !== undefined) {
      queue.push({
        key: `${pickedId}:sentence`,
        card_id: pickedId,
        mode: 'sentence',
        kind: 'sentence',
        card: cardById.get(pickedId),
        due: null,
      });
    }
  }

  return queue;
}
