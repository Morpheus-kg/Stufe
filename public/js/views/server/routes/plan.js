// План на сегодня: дискретный чек-лист конкретных действий (без расчёта поминутных весов) с изоляцией по user_id
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { getSettings } from '../settings.js';
import { localDay, nowUtc, toSql } from '../time.js';
import { shiftDay, clampInt, dayStr } from '../activities.js';

export const mountPath = '/api/plan';
const router = Router();

export const MAX_ITEMS = 4;
const HOEREN_ROTATION = ['listening', 'numbers', 'dictation_text'];
const ACTIVE_ROTATION = ['speaking', 'retell'];

const TITLES = {
  cards: 'Повторить карточки FSRS',
  reading: 'Разобрать 1 текст для чтения',
  listening: 'Прослушать и разобрать 1 аудио/диалог',
  dictation_text: 'Пройти 1 диктант по тексту',
  numbers: 'Потренировать числа на слух (1 сет)',
  translation: 'Перевести 1 сет предложений (Satzbau)',
  speaking: 'Устная практика: 1 монолог',
  retell: 'Пересказ 1 текста (RU → DE)',
  writing: 'Письмо: 1 развёрнутый ответ',
};

const TARGET_LABELS = {
  reading: '1 текст',
  listening: '1 аудио',
  dictation_text: '1 диктант',
  numbers: '1 сет',
  translation: '1 сет',
  speaking: '1 ответ',
  retell: '1 пересказ',
  writing: '1 письмо',
};

export function pickLeastRecent(kinds, lastDone) {
  return kinds
    .map((k, i) => ({ k, i, d: lastDone?.[k] ?? '' }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i))[0].k;
}

function routeFor(kind, texts) {
  const id = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  switch (kind) {
    case 'cards': return { route: '#/review', params: {} };
    case 'listening': {
      const t = id(texts?.listening);
      return t ? { route: `#/listen/${t}`, params: { text_id: t } } : { route: '#/listen', params: {} };
    }
    case 'dictation_text': {
      const t = id(texts?.dictation);
      return t
        ? { route: `#/listen/${t}`, params: { text_id: t, mode: 'dictation' } }
        : { route: '#/listen', params: { mode: 'dictation' } };
    }
    case 'reading': {
      const t = id(texts?.reading);
      return t ? { route: `#/text/${t}`, params: { text_id: t } } : { route: '#/texts?new=1', params: {} };
    }
    case 'numbers': return { route: '#/numbers', params: {} };
    case 'speaking': return { route: '#/speak', params: {} };
    case 'translation': return { route: '#/translate', params: {} };
    case 'retell': return { route: '#/retell', params: {} };
    default: return { route: '#/write', params: {} };
  }
}

export function buildChecklist(input) {
  const { date, settings = {}, lastDone = {}, doneToday = {}, cards = {}, texts = {} } = input ?? {};
  const due = Math.max(0, Number(cards.due) || 0);
  const fresh = Math.max(0, Number(cards.new) || 0);
  const reviewsToday = Math.max(0, Number(cards.reviewsToday) || 0);
  const maxSession = clampInt(settings?.max_session_items ?? 40, 1, 200, 40);

  const make = (kind, reason, done, targetLabel) => ({
    id: `${date}:${kind}`,
    kind,
    title: TITLES[kind] || kind,
    target_label: targetLabel || TARGET_LABELS[kind] || '1 задача',
    ...routeFor(kind, texts),
    done: Boolean(done),
    reason_ru: reason,
  });

  const items = [];

  // 1. Карточки FSRS (если есть очередь или уже повторяли сегодня)
  if (due + fresh > 0 || reviewsToday > 0) {
    const plannedCount = Math.min(due + fresh, maxSession);
    const cardsDone = (due + fresh === 0 && reviewsToday > 0) || (plannedCount > 0 && reviewsToday >= Math.min(plannedCount, 10));
    items.push(make(
      'cards',
      due + fresh > 0 ? `К повторению: ${due}, новых: ${fresh}` : `Повторено сегодня: ${reviewsToday}`,
      cardsDone,
      due + fresh > 0 ? `${plannedCount} карт.` : `${reviewsToday} карт.`,
    ));
  }

  // 2. Текст / Аудирование (чередуем чтение и восприятие на слух по давности)
  const hoerenKind = pickLeastRecent(HOEREN_ROTATION, lastDone);
  const textKind = pickLeastRecent(['reading', hoerenKind], lastDone);
  const textReason = textKind === 'reading'
    ? 'Чтение текста с вопросами и встроенным словарём'
    : 'Тренировка восприятия на слух';
  items.push(make(textKind, textReason, doneToday[textKind] === true));

  // 3. Перевод предложений (Satzbau)
  items.push(make(
    'translation',
    'Закрепление лексики и порядка слов в предложениях',
    doneToday.translation === true,
  ));

  // 4. Активный продуктивный навык (письмо раз в неделю, иначе говорение / пересказ)
  const lastWriteDay = lastDone.writing;
  let prodKind;
  let prodReason;
  if (!lastWriteDay || lastWriteDay < shiftDay(date, -7)) {
    prodKind = 'writing';
    prodReason = 'Письменной практики не было больше недели';
  } else {
    prodKind = pickLeastRecent(ACTIVE_ROTATION, lastDone);
    prodReason = prodKind === 'speaking'
      ? 'Устный монолог по теме с целевыми словами'
      : 'Пересказ абзаца с русского на немецкий';
  }
  items.push(make(prodKind, prodReason, doneToday[prodKind] === true));

  return items.slice(0, MAX_ITEMS);
}

// Совместимость со старым именем экспорта
export const buildPlan = buildChecklist;

const num = (v) => Number(v) || 0;

router.get('/today', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = nowUtc();
  const date = localDay(now);
  const settings = await getSettings(null, userId);

  const unattempted = (kinds, mode) => query(
    `SELECT t.id FROM texts t WHERE t.user_id = ? AND t.kind IN (${kinds}) AND NOT EXISTS
       (SELECT 1 FROM text_attempts a WHERE a.user_id = ? AND a.text_id = t.id AND a.mode = '${mode}' AND a.local_day < ?)
     ORDER BY t.created_at DESC, t.id DESC LIMIT 1`,
    [userId, userId, date],
  );

  const [lastAct, lastWrite, todayAct, todayWrite, statsRows, dueRows, unseenRows, rd, ls, dc] =
    await Promise.all([
      query('SELECT kind, MAX(local_day) AS d FROM activities WHERE user_id = ? AND local_day < ? GROUP BY kind', [userId, date]),
      query("SELECT (task_type = 'retell') AS is_retell, MAX(local_day) AS d FROM writing_attempts WHERE user_id = ? AND local_day < ? GROUP BY is_retell", [userId, date]),
      query('SELECT kind, SUM(seconds) AS secs FROM activities WHERE user_id = ? AND local_day = ? GROUP BY kind', [userId, date]),
      query("SELECT DISTINCT (task_type = 'retell') AS is_retell FROM writing_attempts WHERE user_id = ? AND local_day = ?", [userId, date]),
      query('SELECT reviews, new_cards, active_seconds FROM daily_stats WHERE user_id = ? AND day = ?', [userId, date]),
      query('SELECT COUNT(*) AS n FROM card_state cs JOIN cards c ON c.id = cs.card_id AND c.user_id = ? WHERE c.user_id = ? AND c.active = 1 AND cs.due <= ?', [userId, userId, toSql(now)]),
      query('SELECT COUNT(*) AS n FROM cards c WHERE c.user_id = ? AND c.active = 1 AND NOT EXISTS (SELECT 1 FROM card_state cs WHERE cs.user_id = ? AND cs.card_id = c.id)', [userId, userId]),
      unattempted("'reading'", 'read'),
      unattempted("'listening','dialogue'", 'listen'),
      unattempted("'listening','dialogue'", 'dictation'),
    ]);

  const lastDone = {};
  for (const r of lastAct) if (r.kind !== 'writing') lastDone[r.kind] = dayStr(r.d);
  for (const r of lastWrite) lastDone[num(r.is_retell) ? 'retell' : 'writing'] = dayStr(r.d);

  const doneToday = {};
  for (const r of todayAct) {
    if (r.kind !== 'writing') doneToday[r.kind] = true;
  }
  for (const r of todayWrite) doneToday[num(r.is_retell) ? 'retell' : 'writing'] = true;

  const st = statsRows[0] ?? {};
  const newLimit = Math.max(0, clampInt(settings?.new_per_day ?? 10, 0, 1000, 10) - num(st.new_cards));
  const first = (rows) => (rows[0] ? Number(rows[0].id) : null);

  const items = buildChecklist({
    date,
    settings,
    lastDone,
    doneToday,
    cards: {
      due: num(dueRows[0]?.n),
      new: Math.min(newLimit, num(unseenRows[0]?.n)),
      reviewsToday: num(st.reviews),
    },
    texts: { reading: first(rd), listening: first(ls), dictation: first(dc) },
  });

  const doneTasks = items.filter((i) => i.done).length;
  res.json({
    date,
    total_tasks: items.length,
    done_tasks: doneTasks,
    items,
  });
}));

export default router;
