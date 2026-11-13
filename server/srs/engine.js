// Обёртка над ts-fsrs. Чистые функции: состояние карточки в режиме -> новое состояние.
import { fsrs, generatorParameters } from 'ts-fsrs';

const schedulers = new Map();

/** Планировщик с кэшем по retention; параметры по умолчанию, fuzz включён */
function getScheduler(retention) {
  let r = Number(retention);
  if (!Number.isFinite(r)) r = 0.9;
  r = Math.round(Math.min(0.99, Math.max(0.7, r)) * 1000) / 1000;
  let f = schedulers.get(r);
  if (!f) {
    f = fsrs(generatorParameters({ request_retention: r, enable_fuzz: true }));
    schedulers.set(r, f);
  }
  return f;
}

/**
 * Парсинг времени: Date, ISO-строка или SQL 'YYYY-MM-DD HH:MM:SS' (это UTC).
 * @returns {Date|null}
 */
export function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v);
  if (typeof v !== 'string' || !v) return null;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fin = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v) => Math.max(0, Math.trunc(fin(v)));

/** Пустое состояние для первого показа (due = now). due/last_review — ISO UTC */
export function createEmptyState(cardId, mode, now = new Date()) {
  const at = parseDate(now) ?? new Date();
  return {
    card_id: cardId,
    mode,
    state: 0,
    due: at.toISOString(),
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    last_review: null,
  };
}

/**
 * Применить оценку 1..4. Не мутирует вход.
 * @param {object} state состояние (поля card_state; due/last_review — Date, ISO или SQL-строка)
 * @param {number} rating 1..4
 * @param {Date|string} now момент ответа
 * @param {{requestRetention?:number}} [opts]
 * @returns {object} новое состояние (due/last_review — ISO UTC)
 */
export function applyReview(state, rating, now = new Date(), opts = {}) {
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 4) throw new RangeError('rating must be 1..4');

  let at = parseDate(now) ?? new Date();
  const base = state && typeof state === 'object' ? state : {};
  const last = parseDate(base.last_review);
  if (last && at < last) at = last; // защита от отрицательного интервала

  const card = {
    due: parseDate(base.due) ?? at,
    stability: fin(base.stability),
    difficulty: fin(base.difficulty),
    elapsed_days: int(base.elapsed_days),
    scheduled_days: int(base.scheduled_days),
    learning_steps: int(base.learning_steps),
    reps: int(base.reps),
    lapses: int(base.lapses),
    state: Math.min(3, int(base.state)),
  };
  if (last) card.last_review = last;

  const { card: next } = getScheduler(opts?.requestRetention).next(card, at, r);
  const nextLast = parseDate(next.last_review) ?? at;

  return {
    card_id: base.card_id ?? null,
    mode: base.mode ?? null,
    state: Math.min(3, int(next.state)),
    due: (parseDate(next.due) ?? at).toISOString(),
    stability: fin(next.stability),
    difficulty: fin(next.difficulty),
    elapsed_days: int(next.elapsed_days),
    scheduled_days: int(next.scheduled_days),
    learning_steps: int(next.learning_steps),
    reps: int(next.reps),
    lapses: int(next.lapses),
    last_review: nextLast.toISOString(),
  };
}