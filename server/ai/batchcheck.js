// Пакетная проверка ответов: чанки по 6, один вызов ИИ на чанк, агрегация в коде.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ERROR_CATEGORIES } from '../../shared/constants.js';
import { checkResponseSchema } from './schemas_v2b.js';

export const CHUNK_SIZE = 6;
const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const promptCache = new Map();

export async function loadPromptText(name) {
  if (!promptCache.has(name)) {
    promptCache.set(name, await readFile(path.join(PROMPT_DIR, `${name}.txt`), 'utf8'));
  }
  return promptCache.get(name);
}

// Экранируем маркеры данных внутри пользовательского текста
export function esc(s) {
  return String(s ?? '').replace(/<<<|>>>/g, '‹‹‹').trim();
}
const clip = (s, n) => String(s ?? '').slice(0, n);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

export function chunk(arr, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function sanitizeErrors(list, max = 10) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const category = ERROR_CATEGORIES.includes(e.category) ? e.category : 'sonstiges';
    const original = clip(e.original, 300);
    const fix = clip(e.fix, 300);
    if (!original && !fix) continue;
    out.push({ category, original, fix, explanation_ru: clip(e.explanation_ru, 400) });
    if (out.length >= max) break;
  }
  return out;
}

const DIRECTIONS = {
  ru_de: 'русский -> немецкий (ответ ученика на немецком)',
  de_ru: 'немецкий -> русский (ответ ученика на русском)',
  transform: 'немецкий: преобразование предложения по инструкции (ответ на немецком)',
  basket: 'русский -> немецкий (ответ ученика на немецком)',
};

function buildUser(items, ctx) {
  const lines = [`DIRECTION: ${DIRECTIONS[ctx.kind] || DIRECTIONS.ru_de}`, `LEVEL: ${ctx.level || 'B2'}`, '<<<DATA'];
  for (const it of items) {
    lines.push(`[idx ${it.idx}]`);
    lines.push(`SOURCE: ${esc(it.source)}`);
    if (it.instruction) lines.push(`INSTRUCTION: ${esc(it.instruction)}`);
    lines.push(`USER_ANSWER: ${esc(it.answer)}`);
    if (it.reference) lines.push(`REFERENCE: ${esc(it.reference)}`);
    if (it.targets?.length) lines.push(`TARGET_WORDS: ${it.targets.map((t) => `id=${t.card_id} "${esc(t.display)}"`).join('; ')}`);
    lines.push('');
  }
  lines.push('>>>DATA');
  return lines.join('\n');
}

async function loadChat() {
  return (await import('./llm.js')).chatJSON;
}

// Один вызов ИИ для чанка; мусор в ответе даёт пустой результат (дальше сработает перезапрос)
async function askChunk(chat, items, ctx) {
  const system = await loadPromptText('check_batch');
  const opts = {
    feature: ctx.feature || 'translate', tier: 'strong', system, user: buildUser(items, ctx),
    schema: checkResponseSchema, temperature: 0.2, maxTokens: 3000,
  };
  if (ctx.userId) opts.userId = ctx.userId;
  if (ctx.provider && ctx.provider !== 'auto') opts.preferProvider = ctx.provider;
  const { data } = await chat(opts);
  const parsed = checkResponseSchema.safeParse(data);
  if (!parsed.success) return { results: [], summary: {} };
  return parsed.data;
}

function sanitizeResult(r, item) {
  const score = clamp(r.score, 0, 100);
  const allowed = new Set((item.targets || []).map((t) => t.card_id));
  const used = [...new Set((r.used_target_words || []).filter((id) => allowed.has(id)))];
  return {
    idx: item.idx,
    answered: true,
    is_acceptable: typeof r.is_acceptable === 'boolean' ? r.is_acceptable : score >= 60,
    score,
    corrected: clip(r.corrected, 800) || item.answer,
    model_translation: clip(r.model_translation, 800) || item.reference || '',
    errors: sanitizeErrors(r.errors),
    used_target_words: used,
    comment_ru: clip(r.comment_ru, 500),
  };
}

/**
 * Агрегация только в коде: счёт, паттерны ошибок, слова на повторение.
 * @param {Array} results элементы BatchResult.items
 * @param {Map<number,object>} metas idx -> {targets}
 * @param {object} ai {tips, strengths, focus, overall}
 * @param {Set<number>} skipped idx без оценки ИИ (не входят в средний балл)
 */
export function aggregate(results, metas, ai = {}, skipped = new Set()) {
  const counted = results.filter((r) => !skipped.has(r.idx));
  const score = counted.length ? clamp(counted.reduce((s, r) => s + r.score, 0) / counted.length, 0, 100) : 0;

  const counts = new Map();
  for (const r of results) for (const e of r.errors) counts.set(e.category, (counts.get(e.category) || 0) + 1);
  const tipFor = new Map();
  for (const t of ai.tips || []) if (t?.category && t.tip_ru && !tipFor.has(t.category)) tipFor.set(t.category, clip(t.tip_ru, 300));
  const patterns = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count, tip_ru: tipFor.get(category) || '' }));

  const review = [];
  for (const r of results) {
    if (skipped.has(r.idx)) continue;
    for (const t of metas.get(r.idx)?.targets || []) {
      if (!r.used_target_words.includes(t.card_id) && !review.includes(t.card_id)) review.push(t.card_id);
    }
  }
  const uniq = (arr, n) => [...new Set((arr || []).map((s) => clip(s, 300).trim()).filter(Boolean))].slice(0, n);
  return {
    score,
    summary: {
      patterns,
      strengths_ru: uniq(ai.strengths, 3),
      focus_ru: uniq(ai.focus, 3),
      words_to_review: review,
      overall_ru: uniq(ai.overall, 2).join(' '),
    },
  };
}

/**
 * @param {Array<{idx,source,answer,instruction?,reference?,card_id?|card_ids?}>} items
 * @param {{kind,level?,provider?,feature?,chat?,targetsById?:Map}} ctx
 *   ctx.targetsById: card_id -> display (для TARGET_WORDS)
 * @returns {Promise<{score, items, summary}>} BatchResult без id
 */
export async function checkBatch(items, ctx = {}) {
  const chat = ctx.chat || (await loadChat());
  const seen = new Set();
  const list = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const idx = Number(raw?.idx);
    if (!Number.isInteger(idx) || seen.has(idx)) continue;
    seen.add(idx);
    const ids = raw.card_ids || (raw.card_id ? [raw.card_id] : []);
    list.push({
      idx, source: String(raw.source ?? ''), answer: String(raw.answer ?? '').trim(),
      instruction: raw.instruction || '', reference: raw.reference || '',
      targets: ids.map((id) => ({ card_id: id, display: ctx.targetsById?.get(id) || '' })),
    });
  }
  list.sort((a, b) => a.idx - b.idx);

  const answered = list.filter((i) => i.answer);
  const judged = new Map();
  const ai = { tips: [], strengths: [], focus: [], overall: [] };
  const collect = (res, chunkItems) => {
    const byIdx = new Map(chunkItems.map((i) => [i.idx, i]));
    for (const r of res.results || []) {
      const it = byIdx.get(r.idx);
      if (it && !judged.has(r.idx)) judged.set(r.idx, sanitizeResult(r, it));
    }
    const s = res.summary || {};
    ai.tips.push(...(s.tips || []));
    ai.strengths.push(...(s.strengths_ru || []));
    ai.focus.push(...(s.focus_ru || []));
    if (s.overall_ru) ai.overall.push(s.overall_ru);
  };

  for (const part of chunk(answered)) {
    collect(await askChunk(chat, part, ctx), part);
    const missing = part.filter((i) => !judged.has(i.idx));
    if (missing.length) collect(await askChunk(chat, missing, ctx), missing); // один перезапрос
  }

  const skipped = new Set();
  const results = list.map((it) => {
    if (!it.answer) {
      return { idx: it.idx, answered: false, is_acceptable: false, score: 0, corrected: '',
        model_translation: it.reference || '', errors: [], used_target_words: [], comment_ru: 'Нет ответа.' };
    }
    if (judged.has(it.idx)) return judged.get(it.idx);
    skipped.add(it.idx);
    return { idx: it.idx, answered: true, is_acceptable: false, score: 0, corrected: it.answer,
      model_translation: it.reference || '', errors: [], used_target_words: [],
      comment_ru: 'ИИ не вернул оценку этого предложения. Проверьте его позже.' };
  });

  const metas = new Map(list.map((i) => [i.idx, i]));
  const agg = aggregate(results, metas, ai, skipped);
  if (ctx.userId) {
    const allErrors = results.flatMap((r) => r.errors || []);
    if (allErrors.length) {
      import('../error_profile.js').then((m) => m.recordUserErrors(ctx.userId, allErrors)).catch(() => {});
    }
  }
  return { score: agg.score, items: results, summary: agg.summary };
}