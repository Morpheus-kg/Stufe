// Схемы и чистые функции модуля M8c: речь и свободное письмо
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ERROR_CATEGORIES } from '../../shared/constants.js';
import { ApiError } from '../errors.js';

const CATS = Array.isArray(ERROR_CATEGORIES) && ERROR_CATEGORIES.length ? [...ERROR_CATEGORIES] : ['sonstiges'];
const FALLBACK_CAT = CATS.includes('sonstiges') ? 'sonstiges' : CATS[0];

export const WRITING_TYPES = ['forum', 'letter_formal', 'letter_informal', 'opinion'];
// Минимальный объём по типу задания (считает код, не ИИ)
export const MIN_WORDS_BY_TYPE = { forum: 150, letter_formal: 120, letter_informal: 100, opinion: 150 };
export const SPEAKING_TOPICS = [
  'Arbeit und Beruf', 'Wohnen', 'Umwelt und Klima', 'Medien und Social Media', 'Gesundheit und Sport',
  'Bildung und Lernen', 'Reisen und Urlaub', 'Konsum und Werbung', 'Integration und Gesellschaft',
  'Technik im Alltag', 'Freizeit und Hobbys', 'Familie und Freunde', 'Stadt und Land',
];
export const WRITING_TOPICS = SPEAKING_TOPICS;
export const PRON_NOTE = 'Произношение не оценивается: проверка идёт по расшифровке речи.';

// ---------- вспомогательные функции ----------

/** Разбор по zod-схеме: при ошибке 400 без значений запроса в сообщении. */
export function parseOrBadRequest(schema, data, message = 'Некорректный запрос.') {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'BAD_REQUEST', message);
  return r.data;
}

const promptCache = new Map();
/** Читает текст промпта из server/ai/prompts. */
export function loadPromptText(name) {
  if (!/^[a-z_]+\.txt$/.test(name)) throw new Error('bad prompt name');
  if (!promptCache.has(name)) {
    promptCache.set(name, readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8').trim());
  }
  return promptCache.get(name);
}

/** Оборачивает пользовательские данные в маркеры; сами маркеры из текста вырезаются. */
export function wrapUserData(label, text, max = 5000) {
  const clean = String(text ?? '').replace(/<<<|>>>/g, ' ').slice(0, max);
  return `<<<${label}\n${clean}\n${label}>>>`;
}

/** Одна строка без маркеров, с обрезкой. */
export function cleanLine(text, max = 60) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/<<<|>>>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function pickFrom(arr, rnd = Math.random) {
  const i = Math.floor((Number(rnd()) || 0) * arr.length);
  return arr[Math.min(arr.length - 1, Math.max(0, i))];
}

export const displayCard = (c) => (c && c.article ? `${c.article} ${c.term}` : String(c?.term ?? ''));

/** Число слов (считает код). */
export function countWords(text) {
  const m = String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/** Итоговый балл 0..100 из критериев 0..5 (считает код). */
export function scoreFromCriteria(criteria) {
  const vals = Object.values(criteria || {}).map((v) => Math.min(5, Math.max(0, Number(v) || 0)));
  if (!vals.length) return 0;
  return Math.round((vals.reduce((a, b) => a + b, 0) / (vals.length * 5)) * 100);
}

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Какие целевые карточки встретились в расшифровке (код, не ИИ). */
export function findUsedTargets(text, cards) {
  const clean = norm(text);
  const hay = ` ${clean} `;
  const tokens = clean.split(' ').filter(Boolean);
  const used = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    const forms = [c?.term, c?.plural, c?.cloze_answer].map(norm).filter(Boolean);
    let hit = false;
    for (const f of forms) {
      if (hay.includes(` ${f} `)) { hit = true; break; }
      // одиночное слово от 5 букв: допускаем другую форму по общему началу
      if (!f.includes(' ') && f.length >= 5) {
        const stem = f.slice(0, Math.max(4, f.length - 2));
        if (tokens.some((t) => t.startsWith(stem))) { hit = true; break; }
      }
    }
    if (hit) used.push(c.id);
  }
  return used;
}

/** Чистит список ErrorItem от ИИ: категория из справочника, без пустых и одинаковых пар. */
export function cleanErrors(list, max = 12) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const original = String(e.original ?? '').trim();
    const fix = String(e.fix ?? '').trim();
    if (!original || !fix || original === fix) continue;
    out.push({
      category: CATS.includes(e.category) ? e.category : FALLBACK_CAT,
      original: original.slice(0, 300),
      fix: fix.slice(0, 300),
      explanation_ru: String(e.explanation_ru ?? '').trim().slice(0, 400),
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---------- мягкие кирпичики для ответов ИИ ----------
const str = (max, min = 0) =>
  z.string().transform((s) => s.trim().slice(0, max)).refine((s) => s.length >= min, { message: 'too short' });
const optStr = (max) => z.preprocess((v) => (v == null ? '' : v), str(max));
const strList = (maxItems, maxLen) =>
  z.preprocess(
    (v) => (Array.isArray(v)
      ? v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems)
      : []),
    z.array(z.string()),
  );
const score05 = z.preprocess((v) => {
  if (v == null || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(5, Math.max(0, Math.round(n))) : v;
}, z.number().int().min(0).max(5));

const numInt = (min, max) =>
  z.preprocess((v) => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : v;
  }, z.number().int().min(min).max(max).optional());

const ErrorItemAI = z.object({
  category: z.preprocess(
    (v) => (typeof v === 'string' && CATS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : FALLBACK_CAT),
    z.string(),
  ),
  original: optStr(300),
  fix: optStr(300),
  explanation_ru: optStr(400),
});
const errorsAI = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []),
  z.array(ErrorItemAI),
);

// ---------- ответы ИИ ----------
export const SpeakingPromptAISchema = z.object({
  prompt_ru: str(600, 5),
  prompt_de: str(800, 5),
});

export const SpeakingEvalAISchema = z.object({
  criteria: z.object({ content: score05, vocabulary: score05, grammar: score05, coherence: score05 }),
  strengths_ru: strList(3, 200),
  improvements_ru: strList(3, 300),
  corrected_sample: optStr(1500),
  note_ru: optStr(400),
});

export const SpeakingAudioEvalAISchema = z.object({
  transcript: optStr(4000),
  criteria: z.object({
    content: score05,
    vocabulary: score05,
    grammar: score05,
    coherence: score05,
    pronunciation: score05.optional(),
  }),
  wpm: numInt(0, 400),
  fluency_ru: optStr(400),
  pronunciation_ru: optStr(400),
  strengths_ru: strList(3, 200),
  improvements_ru: strList(3, 300),
  corrected_sample: optStr(1500),
  note_ru: optStr(400),
});

export const DiscussionStartAISchema = z.object({
  persona_ru: str(300, 3),
  opening_de: str(800, 5),
  opening_ru: optStr(600),
  suggested_redemittel: strList(5, 120),
});

export const DiscussionTurnAISchema = z.object({
  reply_de: str(800, 5),
  reply_ru: optStr(600),
  micro_fix_de: optStr(400),
  micro_fix_ru: optStr(400),
  suggested_redemittel: strList(4, 120),
});

export const DiscussionFinishAISchema = z.object({
  criteria: z.object({
    argumentation: score05,
    interaction: score05,
    vocabulary: score05,
    grammar: score05,
  }),
  used_redemittel: strList(6, 120),
  strengths_ru: strList(3, 250),
  improvements_ru: strList(3, 300),
  summary_ru: optStr(500),
});

export const WritingTaskAISchema = z.object({
  prompt_de: str(1200, 10),
  bullets_de: strList(5, 300),
});

export const WritingEvalAISchema = z.object({
  criteria: z.object({ task: score05, coherence: score05, vocabulary: score05, grammar: score05 }),
  errors: errorsAI,
  corrected_text: optStr(3500),
  improvements_ru: strList(3, 300),
  feedback_ru: optStr(300),
});

// ---------- запросы ----------
const optProvider = z.string().trim().max(30).nullish();

export const SpeakingPromptReq = z.object({
  kind: z.enum(['shadow', 'free']),
  topic: z.string().max(60).nullish(),
  level: z.enum(['B1', 'B2', 'C1']).default('B2'),
  provider: optProvider,
});

export const SpeakingEvaluateReq = z.object({
  kind: z.enum(['free']),
  prompt: z.string().trim().min(1).max(2000),
  expected: z.string().max(2000).nullish(),
  transcript: z.string().max(4000),
  duration_s: numInt(0, 3600),
  engine: z.string().trim().min(1).max(20),
  target_card_ids: z.array(z.coerce.number().int().positive()).max(8).optional(),
  provider: optProvider,
});

export const WritingTaskReq = z.object({
  type: z.enum(['forum', 'letter_formal', 'letter_informal', 'opinion']),
  topic: z.string().max(80).nullish(),
  provider: optProvider,
});

export const WritingEvaluateReq = z.object({
  task_id: z.coerce.number().int().positive(),
  text: z.string().max(3000),
  seconds: numInt(0, 86400),
  provider: optProvider,
});

export const DiscussionStartReq = z.object({
  topic: z.string().max(80).nullish(),
  level: z.enum(['B1', 'B2', 'C1']).default('B2'),
  provider: optProvider,
});

export const DiscussionTurnReq = z.object({
  text: z.string().trim().min(2).max(2000),
  duration_s: numInt(0, 1800),
  provider: optProvider,
});

export const DiscussionFinishReq = z.object({
  duration_s: numInt(0, 3600),
  provider: optProvider,
});