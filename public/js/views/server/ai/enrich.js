// Обогащение карточек, проверка рода вторым провайдером, нормализация сгенерированных слов
import { ApiError } from '../errors.js';
import { TOPICS } from '../../shared/constants.js';
import { chatJSON, dbQuery, loadPrompt, wrapData } from './llm.js';
import {
  enrichBatchSchema,
  enrichItemSchema,
  genderBatchSchema,
  genderItemSchema,
} from './schemas.js';

const CHUNK = 25;
const FILL_COLS = ['pos', 'article', 'plural', 'grammar', 'rektion', 'example', 'example_translation', 'level', 'topic', 'example_cloze', 'cloze_answer', 'examples_json'];

const hasText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Собирает массив валидных контекстных примеров [{de, ru, cloze, answer}] для ротации в cloze.
 */
export function buildExamplesList(primaryEx, primaryRu, primaryCloze, primaryAns, rawExamples, term) {
  const list = [];
  const seen = new Set();
  if (primaryEx && primaryCloze && primaryAns) {
    list.push({ de: primaryEx, ru: primaryRu || null, cloze: primaryCloze, answer: primaryAns });
    seen.add(primaryEx.toLowerCase());
  }
  if (Array.isArray(rawExamples)) {
    for (const item of rawExamples) {
      if (!item || typeof item !== 'object') continue;
      const de = typeof item.de === 'string' ? item.de.trim() : '';
      const ru = typeof item.ru === 'string' ? item.ru.trim() : null;
      const ans = typeof item.answer === 'string' && item.answer.trim() ? item.answer.trim() : term;
      if (!de || seen.has(de.toLowerCase())) continue;
      const cl = makeCloze(de, ans) || (ans !== term ? makeCloze(de, term) : null);
      if (cl) {
        list.push({ de, ru: ru || null, cloze: cl.example_cloze, answer: cl.cloze_answer });
        seen.add(de.toLowerCase());
      }
      if (list.length >= 4) break;
    }
  }
  return list;
}

/**
 * Делает пропуск в примере: форма слова заменяется на ____.
 * Возвращает {example_cloze, cloze_answer} или null, если форма не найдена.
 */
export function makeCloze(example, answer) {
  if (typeof example !== 'string' || typeof answer !== 'string') return null;
  const ex = example.trim();
  const ans = answer.trim();
  if (!ex || !ans || ans.length > 255) return null;
  const esc = ans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m;
  try {
    m = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu').exec(ex);
  } catch {
    return null;
  }
  if (!m) return null;
  const cloze = `${ex.slice(0, m.index)}____${ex.slice(m.index + m[0].length)}`;
  if (cloze.replace('____', '').trim() === '') return null;
  return { example_cloze: cloze, cloze_answer: m[0] };
}

const normPlural = (s) =>
  String(s ?? '').normalize('NFC').toLowerCase().replace(/^die\s+/, '').trim();

/**
 * Второе мнение о роде и множественном числе у ДРУГОГО провайдера.
 * @param {{id:number, term:string, translation?:string}[]} nouns
 * @param {{excludeProvider?:string, feature:string, userId?:number}} opts
 * @returns {Promise<Map<number,{article:string|null, plural:string|null}>|null>} null = проверка не удалась
 */
export async function checkGender(nouns, { excludeProvider, feature, userId }) {
  const map = new Map();
  if (!nouns.length) return map;
  try {
    const payload = nouns.map((n) => ({ id: n.id, term: n.term, translation: n.translation ?? '' }));
    const { data } = await chatJSON({
      userId,
      feature,
      tier: 'fast',
      system: loadPrompt('gender'),
      user: wrapData('WORDS', JSON.stringify(payload)),
      schema: genderBatchSchema,
      excludeProvider,
      maxTokens: 2000,
    });
    for (const raw of data.items) {
      const r = genderItemSchema.safeParse(raw);
      if (r.success) map.set(r.data.id, { article: r.data.article, plural: r.data.plural });
    }
    return map;
  } catch (e) {
    if (!(e instanceof ApiError)) console.warn('[ai] gender check failed');
    return null;
  }
}

/** Расхождение двух мнений: разные артикли или разные (оба заданы) формы множественного числа. */
export function genderDisagrees(article, plural, other) {
  if (!other) return false;
  if (other.article && article !== other.article) return true;
  if (other.plural && plural && normPlural(other.plural) !== normPlural(plural)) return true;
  return false;
}

// ---------- Генерация слов: помощники ----------
/** Тема Redemittel (без учёта регистра и пробелов): устойчивые выражения и коннекторы. */
export function isRedemittel(topic) {
  return typeof topic === 'string' && topic.trim().toLowerCase() === 'redemittel';
}

/** Данные запроса для промпта generate.txt (кладутся в маркеры REQUEST). */
export function buildGenerateRequest({ topic, count, pos_mix, level }) {
  const redemittel = isRedemittel(topic);
  return {
    mode: redemittel ? 'redemittel' : 'words',
    topic: redemittel ? 'Redemittel' : topic,
    count,
    pos_mix,
    level: level || 'B2',
  };
}

/**
 * Приводит элемент модели к виду staging-карточки (или null, если непригоден).
 */
export function normalizeGenerated(raw, { topic, level, redemittel }) {
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const term = clean(raw.term);
  const translation = clean(raw.translation);
  if (!term || !translation) return null;

  let pos = clean(raw.pos).toLowerCase();
  let article = clean(raw.article).toLowerCase();
  if (article && !['der', 'die', 'das'].includes(article)) article = null;
  if (redemittel) {
    pos = 'phrase';
    article = null;
  } else {
    if (article) pos = 'noun';
  }
  if (!pos || !['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation'].includes(pos)) {
    pos = article ? 'noun' : 'phrase';
  }
  if (pos === 'noun' && !article && !redemittel) return null;

  const example = clean(raw.example) || null;
  const exampleTranslation = clean(raw.example_translation) || null;
  let clozeAnswer = clean(raw.cloze_answer) || null;
  let exampleCloze = null;
  if (example && clozeAnswer) {
    const cl = makeCloze(example, clozeAnswer);
    if (cl) {
      exampleCloze = cl.example_cloze;
      clozeAnswer = cl.cloze_answer;
    } else clozeAnswer = null;
  } else clozeAnswer = null;

  const plural = pos === 'noun' ? clean(raw.plural) || null : null;
  const grammar = clean(raw.grammar) || null;
  const rektion = clean(raw.rektion).slice(0, 100) || null;
  const top = redemittel ? 'Redemittel' : (clean(raw.topic) || topic || 'Sonstiges');
  const lev = ['B1', 'B2', 'C1'].includes(raw.level) ? raw.level : (level || 'B2');
  const exList = buildExamplesList(example, exampleTranslation, exampleCloze, clozeAnswer, raw.examples, term);

  const out = {
    term,
    article: article || null,
    plural,
    pos,
    translation,
    grammar,
    example,
    example_translation: exampleTranslation,
    example_cloze: exampleCloze,
    cloze_answer: clozeAnswer,
    level: lev,
    topic: top,
    check_flag: 0,
  };
  if (rektion) out.rektion = rektion;
  if (exList.length > 1) out.examples_json = JSON.stringify(exList);
  return out;
}

// ---------- Обогащение карточек (server/routes/enrich.js) ----------
function computeNeeds(c) {
  const needs = [];
  if (c.pos === 'phrase' && !c.article) needs.push('pos');
  if (c.pos === 'noun' || c.article) {
    if (!c.article) needs.push('article');
    if (!hasText(c.plural)) needs.push('plural');
  }
  if (!hasText(c.grammar)) needs.push('grammar');
  if (!c.level || c.level === 'B2') needs.push('level');
  if (!hasText(c.topic) || c.topic === 'Sonstiges') needs.push('topic');
  if (!hasText(c.example)) {
    needs.push('example', 'example_translation', 'cloze_answer');
  } else if (!hasText(c.example_cloze) && !hasText(c.cloze_answer)) {
    needs.push('cloze_answer');
  }
  return needs;
}

function applyAi(c, m) {
  const upd = {};
  if (c.pos === 'phrase') {
    if (c.article) upd.pos = 'noun';
    else if (m?.pos && m.pos !== 'phrase') upd.pos = m.pos;
  }
  if (!m) return upd;
  const pos = upd.pos ?? c.pos;
  if (pos === 'noun') {
    if (!c.article && m.article) upd.article = m.article;
    if (!c.plural && m.plural) upd.plural = m.plural;
  }
  if (!hasText(c.grammar) && m.grammar) upd.grammar = m.grammar;
  if (!hasText(c.rektion) && m.rektion) upd.rektion = m.rektion;
  if (!hasText(c.example) && m.example) {
    upd.example = m.example;
    if (m.example_translation) upd.example_translation = m.example_translation;
  }
  if (c.level === 'B2' && m.level && m.level !== 'B2') upd.level = m.level;
  if ((!hasText(c.topic) || c.topic === 'Sonstiges') && m.topic && m.topic !== 'Sonstiges') {
    upd.topic = m.topic;
  }
  const ex = upd.example ?? c.example;
  if (!hasText(c.example_cloze) && !hasText(c.cloze_answer) && hasText(ex)) {
    const cl = makeCloze(ex, m.cloze_answer || c.term);
    if (cl) Object.assign(upd, cl);
  }
  if (!hasText(c.examples_json) && Array.isArray(m.examples) && m.examples.length > 0) {
    const exRu = upd.example_translation ?? c.example_translation;
    const exCloze = upd.example_cloze ?? c.example_cloze;
    const exAns = upd.cloze_answer ?? c.cloze_answer;
    const list = buildExamplesList(ex, exRu, exCloze, exAns, m.examples, c.term);
    if (list.length > 1) upd.examples_json = JSON.stringify(list);
  }
  return upd;
}

async function enrichChunk(cards, userId) {
  const jobs = cards.map((card) => ({ card, needs: computeNeeds(card) }));
  const ask = jobs.filter((j) => j.needs.length);
  const aiMap = new Map();
  let provider;

  if (ask.length) {
    const payload = ask.map(({ card: c, needs }) => ({
      id: c.id,
      term: c.term,
      translation: c.translation,
      pos: c.pos,
      article: c.article ?? null,
      example: c.example ?? null,
      needs,
    }));
    const res = await chatJSON({
      userId,
      feature: 'enrich',
      tier: 'fast',
      system: loadPrompt('enrich'),
      user: wrapData('CARDS', JSON.stringify(payload)),
      schema: enrichBatchSchema,
      maxTokens: 4000,
    });
    provider = res.provider;
    for (const raw of res.data.items) {
      const r = enrichItemSchema.safeParse(raw);
      if (r.success) aiMap.set(r.data.id, r.data);
    }
  }

  const rows = jobs.map(({ card }) => {
    const upd = applyAi(card, aiMap.get(card.id));
    return { card, upd, fin: { ...card, ...upd }, flag: false };
  });

  const nouns = rows.filter((r) => r.fin.pos === 'noun');
  if (nouns.length) {
    const gmap = await checkGender(
      nouns.map((r) => ({ id: r.card.id, term: r.card.term, translation: r.card.translation })),
      { excludeProvider: provider, feature: 'enrich', userId },
    );
    if (gmap) {
      for (const r of nouns) {
        const g = gmap.get(r.card.id);
        if (!g) continue;
        if (!r.fin.article && g.article) {
          r.upd.article = g.article;
          r.fin.article = g.article;
          r.flag = true;
        } else if (genderDisagrees(r.fin.article, r.fin.plural, g)) {
          r.flag = true;
        }
      }
    }
  }

  let processed = 0;
  let flagged = 0;
  for (const r of rows) {
    const wasFlagged = Boolean(r.card.check_flag);
    const sets = [];
    const params = [];
    for (const col of FILL_COLS) {
      if (r.upd[col] !== undefined) {
        sets.push(`${col}=?`);
        params.push(r.upd[col]);
      }
    }
    sets.push('enriched=1');
    if (r.flag) sets.push('check_flag=1');
    params.push(r.card.id, userId);
    const res = await dbQuery(
      `UPDATE cards SET ${sets.join(', ')} WHERE id=? AND user_id=? AND enriched=0`,
      params,
    );
    if (res && typeof res.affectedRows === 'number' && res.affectedRows === 0) continue;
    processed += 1;
    if (r.flag && !wasFlagged) flagged += 1;
  }
  return { processed, flagged };
}

/**
 * Обогащает до `limit` карточек с enriched=0 для конкретного пользователя.
 * @param {number} limit
 * @param {number} userId
 * @returns {Promise<{processed:number, flagged:number}>}
 */
const inFlightUsers = new Set();
export const ENRICH_MAX_ATTEMPTS = 5;

async function markBackoff(cards, userId) {
  for (const c of cards) {
    try {
      await dbQuery(
        'UPDATE cards SET enrich_attempts = enrich_attempts + 1, '
        + 'enrich_next_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL POW(2, LEAST(enrich_attempts + 1, 8)) MINUTE) '
        + 'WHERE id=? AND user_id=? AND enriched=0',
        [c.id, userId],
      );
    } catch { /* колонок может не быть в тестовой БД */ }
  }
}

/**
 * Обогащает до `limit` карточек с enriched=0 для конкретного пользователя.
 * Защита от наложения: пока идёт обогащение этого пользователя, повторный вызов возвращает skipped.
 * @param {number} limit
 * @param {number} userId
 * @param {{respectBackoff?: boolean}} [opts] воркер: пропускать карточки, исчерпавшие попытки или ждущие паузы
 * @returns {Promise<{processed:number, flagged:number, skipped?:boolean}>}
 */
export async function enrichCards(limit = 25, userId, opts = {}) {
  if (inFlightUsers.has(userId)) return { processed: 0, flagged: 0, skipped: true };
  inFlightUsers.add(userId);
  try {
    const lim = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 25));
    const backoff = opts.respectBackoff
      ? ` AND enrich_attempts < ${ENRICH_MAX_ATTEMPTS} AND (enrich_next_at IS NULL OR enrich_next_at <= UTC_TIMESTAMP())`
      : '';
    const rows = await dbQuery(
      `SELECT * FROM cards WHERE user_id=? AND enriched=0 AND active=1${backoff} ORDER BY id LIMIT ${lim}`,
      [userId],
    );
    let processed = 0;
    let flagged = 0;
    for (let i = 0; i < (rows || []).length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        const r = await enrichChunk(chunk, userId);
        processed += r.processed;
        flagged += r.flagged;
      } catch (e) {
        const soft = e instanceof ApiError && (e.code === 'AI_UNAVAILABLE' || e.code === 'AI_CAP');
        if (opts.respectBackoff) await markBackoff(chunk, userId);
        if (soft && processed > 0) break;
        throw e;
      }
    }
    return { processed, flagged };
  } finally {
    inFlightUsers.delete(userId);
  }
}
