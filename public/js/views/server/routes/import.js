// /api/import: импорт карточек (старый и новый формат), слияние дублей с изоляцией по user_id
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db.js';
import { asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { ARTICLES, LEVEL_VALUES, MODE_VALUES, POS_VALUES, normalizeKey, splitArticle } from '../keys.js';
import { makeCloze } from '../ai/enrich.js';
import { scheduleEnrich } from '../cards_service.js';
import { toSql } from '../time.js';

export const mountPath = '/api/import';
const router = Router();
export default router;

const INSERT_COLS = ['term', 'article', 'plural', 'pos', 'translation', 'grammar', 'example', 'example_translation',
  'example_cloze', 'cloze_answer', 'level', 'topic', 'source', 'check_flag', 'enriched', 'active', 'dedupe_key'];
// Поля, которые при слиянии заполняются только если у существующей карточки пусто
const FILL_FIELDS = ['translation', 'plural', 'grammar', 'example', 'example_translation', 'source'];

// 'слово (оборот из 2+ слов)' в конце термина
const PAREN_RE = /^(.*\S)\s*\(([^()]+)\)$/u;
// Скобки с грамматикой/пометками — это не отдельный оборот
const NOT_PHRASE_RE = /^(akk|dat|gen|nom|pl|sg|ugs|geh|fam|ist|hat|auch|oder|z\.\s?b|zb|bes|meist|veraltet|fachspr)\b/i;

const isEmpty = (v) => v === null || v === undefined || v === '';
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Любое значение -> строка (NFC, пробелы схлопнуты) или null */
function clean(v) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  return s || null;
}
const cut = (v, max) => { const s = clean(v); return s ? s.slice(0, max) : null; };

function isPhrase(inner) {
  return inner.split(/\s+/).length >= 2 && !/[,;/]/.test(inner) && !NOT_PHRASE_RE.test(inner);
}

// Zod-схема одного элемента импорта (поддерживает card1.json, v1 backup и gt-deck v2)
export const importCardItemSchema = z.object({
  id: z.any().optional(),
  term: z.union([z.string(), z.number()]),
  translation: z.union([z.string(), z.number()]),
  article: z.any().optional(),
  plural: z.any().optional(),
  pos: z.any().optional(),
  type: z.any().optional(),
  grammar: z.any().optional(),
  example: z.any().optional(),
  example_translation: z.any().optional(),
  example_cloze: z.any().optional(),
  cloze_answer: z.any().optional(),
  level: z.any().optional(),
  topic: z.any().optional(),
  source: z.any().optional(),
  check: z.any().optional(),
  check_flag: z.any().optional(),
  enriched: z.any().optional(),
  active: z.any().optional(),
  progress: z.array(z.unknown()).optional(),
}).passthrough();

/** Один элемент импорта -> карточка или null (мусор / слишком короткие term/translation) */
function mapOne(raw) {
  const parsed = importCardItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  let term = clean(raw.term);
  const translation = clean(raw.translation);
  if (!term || !translation || term.length < 2 || translation.length < 2 || term.length > 255) return null;

  const type = (clean(raw.type) ?? '').toLowerCase();
  let pos = POS_VALUES.includes(raw.pos) ? raw.pos : (/idiom/.test(type) ? 'idiom' : null);
  const a0 = (clean(raw.article) ?? '').toLowerCase();
  let article = ARTICLES.includes(a0) ? a0 : null;

  if (article) {
    const m = new RegExp(`^${article}\\s+(.+)$`, 'iu').exec(term);
    if (m) term = m[1].trim();
  } else if (pos === null || pos === 'noun') {
    const s = splitArticle(term);
    if (s.article) { article = s.article; term = s.term; pos = 'noun'; }
  }
  if (!pos) pos = article ? 'noun' : 'phrase';

  const key = normalizeKey(article, term);
  if (!key) return null;
  const topic = clean(raw.topic);
  const example = cut(raw.example, 2000);
  let example_cloze = cut(raw.example_cloze, 2000);
  let cloze_answer = cut(raw.cloze_answer, 255);
  if (example && (!example_cloze || !cloze_answer)) {
    const cl = makeCloze(example, cloze_answer || term) || makeCloze(example, term);
    if (cl) {
      example_cloze = cl.example_cloze;
      cloze_answer = cl.cloze_answer;
    }
  }
  return {
    term, article, pos,
    plural: cut(raw.plural, 255),
    translation: translation.slice(0, 500),
    grammar: cut(raw.grammar, 2000),
    example,
    example_translation: cut(raw.example_translation, 2000),
    example_cloze,
    cloze_answer,
    level: LEVEL_VALUES.includes(raw.level) ? raw.level : 'B2',
    topic: topic && topic.length <= 50 ? topic : 'Sonstiges',
    source: cut(raw.source, 255),
    check_flag: truthy(raw.check_flag ?? raw.check) ? 1 : 0,
    enriched: truthy(raw.enriched) ? 1 : 0,
    active: raw.active === false || raw.active === 0 || raw.active === '0' ? 0 : 1,
    dedupe_key: key,
  };
}

/** Элемент импорта -> 0, 1 или 2 карточки (скобки с оборотом = две карточки) */
function mapItem(raw, split) {
  const term = clean(raw.term);
  const m = split && term ? PAREN_RE.exec(term) : null;
  if (m && m[1].trim().length >= 2 && isPhrase(m[2].trim())) {
    const word = mapOne({ ...raw, term: m[1].trim() });
    if (!word) return [];
    // Оборот: тот же пример и перевод, но без грамматики слова
    const phrase = mapOne({
      ...raw, term: m[2].trim(), article: null, plural: null, grammar: null,
      example_cloze: null, cloze_answer: null, pos: 'phrase', enriched: 0,
    });
    return phrase && phrase.dedupe_key !== word.dedupe_key ? [word, phrase] : [word];
  }
  const one = mapOne(raw);
  return one ? [one] : [];
}

/**
 * Подготовка карточек к записи (без БД).
 */
export function prepareCards(items, { split = true } = {}) {
  const prepared = [];
  let flagged = 0;
  items.forEach((raw, index) => {
    const cards = raw && typeof raw === 'object' && !Array.isArray(raw) ? mapItem(raw, split) : [];
    if (!cards.length) flagged += 1;
    for (const card of cards) prepared.push({ card, index });
  });
  return { prepared, flagged };
}

/**
 * Записывает карточки: новые вставляет, дубли сливает (заполняет только пустые поля).
 * @param {{query: Function}} db соединение mysql2 (внутри транзакции)
 * @param {object[]} prepared
 * @param {number} userId
 * @returns {Promise<{added: number, merged: number}>}
 */
export async function saveCards(db, prepared, userId) {
  const [rows] = await db.query(
    'SELECT id, dedupe_key, translation, plural, grammar, example, example_translation, '
    + 'example_cloze, cloze_answer, source FROM cards WHERE user_id = ?',
    [userId],
  );
  const byKey = new Map();
  for (const r of rows) byKey.set(r.dedupe_key, { data: r, id: r.id, isNew: false, dirty: {} });

  const fresh = [];
  let added = 0;
  let merged = 0;
  for (const { card } of prepared) {
    const hit = byKey.get(card.dedupe_key);
    if (!hit) {
      const data = { ...card };
      fresh.push(data);
      byKey.set(card.dedupe_key, { data, isNew: true, dirty: {} });
      added += 1;
      continue;
    }
    merged += 1;
    const fill = (f) => {
      if (isEmpty(hit.data[f]) && !isEmpty(card[f])) {
        hit.data[f] = card[f];
        if (!hit.isNew) hit.dirty[f] = card[f];
      }
    };
    FILL_FIELDS.forEach(fill);
    // cloze берём только если пример совпал, иначе пропуск не будет соответствовать тексту
    if (hit.data.example === card.example) { fill('example_cloze'); fill('cloze_answer'); }
  }

  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500).map((c) => [userId, ...INSERT_COLS.map((k) => c[k])]);
    await db.query(`INSERT INTO cards (user_id, ${INSERT_COLS.join(', ')}) VALUES ?`, [chunk]);
  }
  for (const h of byKey.values()) {
    const keys = Object.keys(h.dirty);
    if (h.isNew || !keys.length) continue;
    await db.query(`UPDATE cards SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
      [...keys.map((k) => h.dirty[k]), h.id, userId]);
  }
  return { added, merged };
}

const bodySchema = z.object({
  format: z.string().nullish(),
  version: z.number().int().nullish(),
  filename: z.string().max(255).nullish(),
  cards: z.array(z.unknown()).max(5000),
  card_state: z.array(z.unknown()).max(25000).optional(),
});

const sqlOrNull = (v) => { try { return v ? toSql(v) : null; } catch { return null; } };
const int = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
};
const num = (v, def = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);

router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  // Допускаем голый массив карточек, gt-deck v2 или объект с cards
  const input = Array.isArray(req.body) ? { cards: req.body } : req.body;
  const body = validate(bodySchema, input, 'Некорректный импорт (максимум 5000 карточек)');
  const { prepared, flagged } = prepareCards(body.cards);
  const out = await tx(async (conn) => {
    const { added, merged } = await saveCards(conn, prepared, userId);

    // Опциональное восстановление прогресса FSRS (из progress[] карточек gt-deck v2 или card_state)
    const hasProgress = prepared.some(({ index }) => Array.isArray(body.cards[index]?.progress))
      || (Array.isArray(body.card_state) && body.card_state.length > 0);
    let restoredStates = 0;
    if (hasProgress) {
      const [idRows] = await conn.query('SELECT id, dedupe_key, pos, article FROM cards WHERE user_id = ?', [userId]);
      const keyToId = new Map(idRows.map((r) => [r.dedupe_key, r.id]));
      const nounArtIds = new Set(
        idRows.filter((r) => r.pos === 'noun' && ARTICLES.includes(r.article)).map((r) => r.id),
      );
      const idMap = new Map();
      const rawStates = [];
      for (const { card, index } of prepared) {
        const newId = keyToId.get(card.dedupe_key);
        const raw = body.cards[index];
        if (!newId || !raw || typeof raw !== 'object') continue;
        if (Number.isInteger(Number(raw.id)) && Number(raw.id) > 0) idMap.set(Number(raw.id), newId);
        if (Array.isArray(raw.progress)) {
          for (const p of raw.progress) {
            if (p && typeof p === 'object') rawStates.push({ ...p, _cardId: newId });
          }
        }
      }
      if (Array.isArray(body.card_state)) {
        for (const s of body.card_state) {
          if (s && typeof s === 'object') rawStates.push(s);
        }
      }
      const stateRows = [];
      for (const s of rawStates) {
        const cardId = s._cardId || idMap.get(Number(s.card_id));
        const due = sqlOrNull(s.due);
        if (!cardId || !MODE_VALUES.includes(s.mode) || !due) continue;
        if (s.mode === 'article' && !nounArtIds.has(cardId)) continue;
        stateRows.push([
          cardId, s.mode, userId, int(s.state, 0, 0, 3), due, num(s.stability), num(s.difficulty),
          int(s.elapsed_days, 0, 0, 1e6), int(s.scheduled_days, 0, 0, 1e6), int(s.learning_steps, 0, 0, 100),
          int(s.reps, 0, 0, 1e6), int(s.lapses, 0, 0, 1e6), sqlOrNull(s.last_review),
        ]);
      }
      for (let i = 0; i < stateRows.length; i += 500) {
        await conn.query(
          'INSERT INTO card_state (card_id, mode, user_id, state, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, last_review) VALUES ? '
          + 'ON DUPLICATE KEY UPDATE state = IF(VALUES(reps) > reps, VALUES(state), state), due = IF(VALUES(reps) > reps, VALUES(due), due), '
          + 'stability = IF(VALUES(reps) > reps, VALUES(stability), stability), difficulty = IF(VALUES(reps) > reps, VALUES(difficulty), difficulty), '
          + 'elapsed_days = IF(VALUES(reps) > reps, VALUES(elapsed_days), elapsed_days), scheduled_days = IF(VALUES(reps) > reps, VALUES(scheduled_days), scheduled_days), '
          + 'learning_steps = IF(VALUES(reps) > reps, VALUES(learning_steps), learning_steps), lapses = IF(VALUES(reps) > reps, VALUES(lapses), lapses), '
          + 'last_review = IF(VALUES(reps) > reps, VALUES(last_review), last_review), reps = IF(VALUES(reps) > reps, VALUES(reps), reps)',
          [stateRows.slice(i, i + 500)],
        );
        restoredStates += Math.min(500, stateRows.length - i);
      }
    }

    const [run] = await conn.query(
      'INSERT INTO import_runs (user_id, filename, total, added, merged, flagged) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, body.filename ? body.filename.slice(0, 255) : null, body.cards.length, added, merged, flagged],
    );
    return { run_id: run.insertId, total: body.cards.length, added, merged, flagged, restored_states: restoredStates };
  });
  if (prepared.some(({ card }) => !card.enriched)) {
    scheduleEnrich(userId, 5);
  }
  res.json(out);
}));
