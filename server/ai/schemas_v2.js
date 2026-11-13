// Схемы M8a: запросы и ответы ИИ для текстов, анализа текста и словаря.
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { TOPICS } from '../../shared/constants.js';
import { makeCloze } from './enrich.js';

export const TEXT_KINDS = ['reading', 'listening', 'dialogue'];
export const LEVELS = ['B1', 'B2', 'C1'];
export const POS_VALUES = ['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation'];
export const ARTICLES = ['der', 'die', 'das'];
export const LENGTH_WORDS = { short: 120, medium: 220, long: 350 };

/** Разбор тела запроса: любая ошибка -> 400 без значений из запроса. */
export function parseBody(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'BAD_REQUEST', 'Некорректные данные запроса');
  return r.data;
}

/** Строка: схлопнуть пробелы, обрезать; не строка -> ''. */
export function clip(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// ---------- запросы ----------
const providerName = z.string().trim().regex(/^[A-Za-z0-9_:-]{1,30}$/);

export const generateTextRequestSchema = z.object({
  kind: z.enum(TEXT_KINDS),
  topic: z.string().trim().min(1).max(60),
  level: z.enum(LEVELS).default('B2'),
  length: z.enum(['short', 'medium', 'long']).default('medium'),
  question_count: z.coerce.number().int().min(3).max(8).default(5),
  use_due_words: z.boolean().default(true),
  provider: providerName.nullable().optional(),
});

export const analyzeTextRequestSchema = z.object({
  text_id: z.coerce.number().int().min(1),
  provider: providerName.nullable().optional(),
});

export const lookupRequestSchema = z.object({
  word: z.string().trim().min(1).max(60),
  context: z.string().max(200).nullable().optional(),
});

export const stagingItemSchema = z.object({
  word: z.string().trim().min(1).max(100),
  lemma: z.string().trim().min(1).max(255),
  article: z.string().max(10).nullable().optional(),
  plural: z.string().max(255).nullable().optional(),
  pos: z.enum(POS_VALUES),
  translation_ru: z.string().trim().min(1).max(2000),
  example: z.string().max(2000).nullable().optional(),
  example_ru: z.string().max(2000).nullable().optional(),
  topic: z.string().max(50).nullable().optional(),
  level: z.string().max(5).nullable().optional(),
});

export const stagingBulkSchema = z.object({
  items: z.array(stagingItemSchema).min(1).max(50),
});

export const stagingFromErrorsSchema = z.object({
  items: z.array(z.object({
    category: z.string().max(50),
    original: z.string().max(1000),
    fix: z.string().trim().min(1).max(1000),
    explanation_ru: z.string().max(2000),
    sentence: z.string().max(2000).nullable().optional(),
  })).min(1).max(10),
});

// ---------- ответы ИИ (лояльные: детали проверяет код) ----------

/** Диалог: строки `Имя: текст`. null, если хоть одна строка не подходит. */
export function parseDialogue(body) {
  const lines = String(body ?? '').replace(/\*/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const turns = [];
  for (const line of lines) {
    const m = /^([^:\n]{1,30}):\s*(.+)$/.exec(line);
    if (!m) return null;
    turns.push({ speaker: m[1].trim(), text: m[2].trim() });
  }
  return turns;
}

export function speakerNames(turns) {
  return [...new Set(turns.map((t) => t.speaker))];
}

/** Ответ ИИ с текстом. Для диалога требуем 2-3 говорящих (иначе провайдер считается неудачным). */
export function aiTextSchema(kind) {
  const base = z.object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(50),
    speakers: z.any().optional(),
    questions: z.any().optional(),
    glossary: z.any().optional(),
  });
  if (kind !== 'dialogue') return base;
  return base.refine((d) => {
    const t = parseDialogue(d.body);
    if (!t) return false;
    const n = speakerNames(t).length;
    return n >= 2 && n <= 3;
  }, { message: 'dialogue needs 2-3 speakers' });
}

export const aiQuestionsSchema = z.object({ questions: z.array(z.any()) });

export const aiAnalyzeSchema = z.object({
  level_estimate: z.string().nullable().optional(),
  summary_ru: z.string().nullable().optional(),
  words: z.array(z.any()).optional(),
});

export const aiLookupSchema = z.object({
  is_german: z.boolean().optional(),
  word: z.string().nullable().optional(),
  lemma: z.string().nullable().optional(),
  article: z.string().nullable().optional(),
  plural: z.string().nullable().optional(),
  pos: z.string().nullable().optional(),
  translation_ru: z.string().nullable().optional(),
  example: z.string().nullable().optional(),
  example_ru: z.string().nullable().optional(),
  note_ru: z.string().nullable().optional(),
});

// ---------- нормализация ----------
export function normalizeArticle(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return ARTICLES.includes(s) ? s : null;
}

export function splitLeadingArticle(s) {
  const m = /^(der|die|das)\s+(.+)$/i.exec(String(s ?? '').trim());
  return m ? { article: m[1].toLowerCase(), rest: m[2].trim() } : null;
}

const POS_MAP = {
  noun: 'noun', nomen: 'noun', substantiv: 'noun', n: 'noun',
  verb: 'verb', v: 'verb',
  adj: 'adj', adjective: 'adj', adjektiv: 'adj',
  adv: 'adv', adverb: 'adv',
  phrase: 'phrase', idiom: 'idiom', collocation: 'collocation', kollokation: 'collocation',
};

/** Любая метка части речи -> значение из enum; незнакомое -> 'phrase'. */
export function normalizePos(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/\.$/, '') : '';
  return Object.hasOwn(POS_MAP, s) ? POS_MAP[s] : 'phrase';
}

export function cleanPlural(v) {
  let s = clip(v, 255).replace(/^(der|die|das)\s+/i, '');
  if (!/\p{L}{2,}/u.test(s) || /^[-–—¨]/.test(s)) return null;
  return s;
}

/** Сырой объект ИИ -> LookupResult (без in_cards) или null, если непригоден. */
export function normalizeLookupResult(raw, fallbackWord = '') {
  if (!raw || typeof raw !== 'object') return null;
  let lemma = clip(raw.lemma, 255) || clip(raw.word, 255);
  let article = normalizeArticle(raw.article);
  let pos = normalizePos(raw.pos);
  const sp = splitLeadingArticle(lemma);
  if (sp && (pos === 'noun' || article)) {
    article = article ?? sp.article;
    lemma = sp.rest;
  }
  const translation = clip(raw.translation_ru, 500);
  if (!lemma || !translation) return null;
  if (article) pos = 'noun';
  if (pos !== 'noun') article = null;
  return {
    word: clip(raw.word, 100) || clip(fallbackWord, 100) || lemma,
    lemma,
    article,
    plural: pos === 'noun' ? cleanPlural(raw.plural) : null,
    pos,
    translation_ru: translation,
    example: clip(raw.example, 500) || null,
    example_ru: clip(raw.example_ru, 500) || null,
  };
}

/** Список слов глоссария текста (без дублей, до 80 записей). */
export function normalizeGlossary(raw, max = 80) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const r = normalizeLookupResult(item, item?.word ?? '');
    if (!r) continue;
    const k = `${r.word.toLowerCase()}|${r.lemma.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/** Вход from-lookup/bulk -> поля staging-карточки или null. */
export function toStagingItem(input) {
  if (!input || typeof input !== 'object') return null;
  let term = clip(input.lemma, 255);
  let article = normalizeArticle(input.article);
  const pos = normalizePos(input.pos);
  if (pos === 'noun') {
    const sp = splitLeadingArticle(term);
    if (sp) {
      article = article ?? sp.article;
      term = sp.rest;
    }
  } else {
    article = null;
  }
  const translation = clip(input.translation_ru, 500);
  if (!term || !translation) return null;
  const example = clip(input.example, 1000) || null;
  const wordForm = clip(input.word, 100);
  const cl = example ? (makeCloze(example, wordForm || term) || makeCloze(example, term)) : null;
  const topic = Array.isArray(TOPICS) && TOPICS.includes(input.topic) ? input.topic : 'Sonstiges';
  return {
    term,
    article,
    plural: pos === 'noun' ? cleanPlural(input.plural) : null,
    pos,
    translation,
    example,
    example_translation: clip(input.example_ru, 1000) || null,
    example_cloze: cl ? cl.example_cloze : null,
    cloze_answer: cl ? cl.cloze_answer : null,
    level: LEVELS.includes(input.level) ? input.level : 'B2',
    topic,
    check_flag: pos === 'noun' && !article ? 1 : 0,
  };
}