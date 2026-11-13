// Схемы zod, нормализаторы и мапперы для модуля ИИ
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { ERROR_CATEGORIES, TOPICS } from '../../shared/constants.js';
import { PROVIDERS } from './providers.js';

export const ARTICLES = ['der', 'die', 'das'];
export const POS_VALUES = ['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation'];
export const LEVEL_VALUES = ['B1', 'B2', 'C1'];
export const PROVIDER_CHOICES = [
  'auto',
  ...Object.keys(PROVIDERS),
  ...Object.keys(PROVIDERS).flatMap((p) => [`${p}:strong`, `${p}:fast`]),
];

// ---------- Мягкие примитивы для ответов модели ----------
const str = (max) =>
  z.any().transform((v) => (typeof v === 'string' ? v.trim().slice(0, max) : ''));

const strOrNull = (max) =>
  z.any().transform((v) => {
    if (typeof v !== 'string') return null;
    const s = v.trim().slice(0, max);
    return s === '' || s.toLowerCase() === 'null' ? null : s;
  });

// Множественное число: "-" и пустое значит "нет"
const pluralOrNull = z.any().transform((v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 255);
  if (s === '' || s.toLowerCase() === 'null' || /^[-–—]+$/.test(s)) return null;
  return s;
});

const oneOf = (arr, dflt = null) =>
  z.any().transform((v) => {
    if (typeof v !== 'string') return dflt;
    const s = v.trim().toLowerCase();
    return arr.find((x) => x.toLowerCase() === s) ?? dflt;
  });

const boolFlex = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

// ---------- Исправление предложения ----------
function normalizeError(e) {
  if (!e || typeof e !== 'object') return null;
  const cat = typeof e.category === 'string' ? e.category.trim().toLowerCase() : '';
  const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const out = {
    category: ERROR_CATEGORIES.includes(cat) ? cat : 'sonstiges',
    original: clip(e.original, 300),
    fix: clip(e.fix, 300),
    explanation_ru: clip(e.explanation_ru, 500),
  };
  if (!out.original && !out.fix && !out.explanation_ru) return null;
  return out;
}

export const correctSchema = z
  .object({
    corrected: str(800),
    is_correct: boolFlex,
    uses_target_word: boolFlex.default(false),
    errors: z.any().transform((v) =>
      Array.isArray(v) ? v.slice(0, 10).map(normalizeError).filter(Boolean) : [],
    ),
    alternative: strOrNull(800),
  })
  .refine((d) => d.corrected.length > 0, { message: 'corrected is empty' });

// ---------- Обогащение ----------
export const enrichBatchSchema = z.object({ items: z.array(z.any()) });

const exampleVariantSchema = z.object({
  de: strOrNull(500),
  ru: strOrNull(500),
  answer: strOrNull(255),
});

export const enrichItemSchema = z.object({
  id: z.coerce.number().int(),
  pos: oneOf(POS_VALUES),
  article: oneOf(ARTICLES),
  plural: pluralOrNull,
  grammar: strOrNull(500),
  rektion: strOrNull(100).optional(),
  example: strOrNull(500).optional(),
  example_translation: strOrNull(500).optional(),
  examples: z.any().transform((v) =>
    Array.isArray(v)
      ? v.slice(0, 4).map((x) => exampleVariantSchema.safeParse(x)).filter((r) => r.success && r.data.de).map((r) => r.data)
      : [],
  ).optional(),
  level: oneOf(LEVEL_VALUES),
  topic: oneOf(TOPICS),
  cloze_answer: strOrNull(255),
});

// ---------- Проверка рода ----------
export const genderBatchSchema = z.object({ items: z.array(z.any()) });

export const genderItemSchema = z.object({
  id: z.coerce.number().int(),
  article: oneOf(ARTICLES),
  plural: pluralOrNull,
});

// ---------- Генерация слов ----------
export const generateBatchSchema = z.object({ items: z.array(z.any()) });

// level без значения по умолчанию: пустой уровень заменяется запрошенным в роуте
export const generateItemSchema = z
  .object({
    term: str(255),
    article: oneOf(ARTICLES),
    plural: pluralOrNull,
    pos: oneOf(POS_VALUES, 'phrase'),
    translation: str(500),
    grammar: strOrNull(500),
    rektion: strOrNull(100).optional(),
    example: strOrNull(500),
    example_translation: strOrNull(500),
    examples: z.any().transform((v) =>
      Array.isArray(v)
        ? v.slice(0, 4).map((x) => exampleVariantSchema.safeParse(x)).filter((r) => r.success && r.data.de).map((r) => r.data)
        : [],
    ).optional(),
    cloze_answer: strOrNull(255),
    level: oneOf(LEVEL_VALUES),
    topic: oneOf(TOPICS),
  })
  .refine((d) => d.term.length > 0 && d.translation.length > 0, {
    message: 'term/translation required',
  });

// ---------- Запросы API ----------
export const correctRequestSchema = z.object({
  card_id: z.number().int().positive().nullish(),
  text: z.string().trim().min(1).max(400),
  provider: z.enum(PROVIDER_CHOICES).nullish(),
});

export const generateRequestSchema = z.object({
  topic: z.string().trim().min(1).max(60),
  count: z.number().int().min(1).max(15).default(10),
  pos_mix: z.enum(['nouns_first', 'balanced']).default('nouns_first'),
  provider: z.enum(PROVIDER_CHOICES).nullish(),
  level: z.enum(LEVEL_VALUES).default('B2'),
  strict: z.boolean().nullish(),
});

export const enrichRunSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

export const stagingQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Пустая строка из формы = null
const emptyToNull = (inner) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), inner);

export const editsSchema = z
  .object({
    term: z.string().trim().min(1).max(255),
    article: emptyToNull(z.enum(ARTICLES).nullable()),
    plural: emptyToNull(z.string().trim().max(255).nullable()),
    pos: z.enum(POS_VALUES),
    translation: z.string().trim().min(1).max(500),
    grammar: emptyToNull(z.string().trim().max(2000).nullable()),
    example: emptyToNull(z.string().trim().max(1000).nullable()),
    example_translation: emptyToNull(z.string().trim().max(1000).nullable()),
    level: z.enum(LEVEL_VALUES),
    topic: z.string().trim().min(1).max(50),
  })
  .partial();

export const acceptBodySchema = z.object({ edits: editsSchema.optional() });

export const rejectBodySchema = z.object({
  reason: z.string().trim().max(255).nullish(),
});

/** Валидация входа; при ошибке 400 BAD_REQUEST. */
export function parseOrThrow(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'BAD_REQUEST', 'Некорректные данные запроса.');
  return r.data;
}

// ---------- Мапперы строк БД в JSON API ----------
export function sqlToIso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) {
    return `${v.slice(0, 10)}T${v.slice(11, 19)}Z`;
  }
  return v ?? null;
}

export function rowToCard(r) {
  return {
    id: r.id,
    term: r.term,
    article: r.article ?? null,
    plural: r.plural ?? null,
    pos: r.pos,
    translation: r.translation,
    grammar: r.grammar ?? null,
    example: r.example ?? null,
    example_translation: r.example_translation ?? null,
    example_cloze: r.example_cloze ?? null,
    cloze_answer: r.cloze_answer ?? null,
    level: r.level,
    topic: r.topic,
    source: r.source ?? null,
    check_flag: !!r.check_flag,
    enriched: !!r.enriched,
    active: !!r.active,
  };
}

export function rowToStaging(r) {
  return {
    id: r.id,
    batch_id: r.batch_id,
    term: r.term,
    article: r.article ?? null,
    plural: r.plural ?? null,
    pos: r.pos,
    translation: r.translation,
    grammar: r.grammar ?? null,
    example: r.example ?? null,
    example_translation: r.example_translation ?? null,
    example_cloze: r.example_cloze ?? null,
    cloze_answer: r.cloze_answer ?? null,
    level: r.level,
    topic: r.topic,
    check_flag: !!r.check_flag,
    provider: r.provider ?? null,
    status: r.status,
    reason: r.reason ?? null,
    created_at: sqlToIso(r.created_at),
  };
}