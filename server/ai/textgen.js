// M8a: генерация текстов, анализ текста, поиск слов и общие помощники для staging.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chatJSON } from './llm.js';
import { query, pool } from '../db.js';
import { ApiError } from '../errors.js';
import { normalizeKey } from '../keys.js';
import { upsertCards } from '../cards_service.js';
import { localDay, nowUtc, toIso, toSql } from '../time.js';
import { STOPWORDS } from '../../shared/stopwords.js';
import {
  LENGTH_WORDS, aiTextSchema, aiQuestionsSchema, aiAnalyzeSchema, clip,
  normalizeGlossary, normalizeLookupResult, parseDialogue, speakerNames, toStagingItem,
} from './schemas_v2.js';

const MAX_TARGETS = 8;
const MAX_CANDIDATES = 30;

// ---------- промпты и данные ----------
const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
const promptCache = new Map();

/** Читает server/ai/prompts/<name>.txt (кэш в памяти). */
export function loadPrompt(name) {
  if (!/^[a-z_0-9]+\.txt$/.test(name)) throw new Error('bad prompt name');
  if (!promptCache.has(name)) promptCache.set(name, readFileSync(path.join(PROMPT_DIR, name), 'utf8'));
  return promptCache.get(name);
}

/** Данные пользователя/ИИ в маркерах; сами маркеры из текста вырезаются. */
export function wrapData(label, text) {
  const clean = String(text ?? '').replace(/<<<|>>>/g, ' ');
  return `<<<${label}\n${clean}\n${label}>>>`;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const lowerNorm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const stripLeadingArticle = (s) => String(s ?? '').replace(/^\s*(der|die|das)\s+/i, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- токены ----------
const TOKEN_RE = /\p{L}+(?:[-'’]\p{L}+)*/gu;
export function tokenize(text) {
  return String(text ?? '').match(TOKEN_RE) ?? [];
}

/** Убирает «Имя:» в начале строк диалога. */
export function stripSpeakers(body) {
  return String(body ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*\*{0,2}[^:\n]{1,30}:\s*/, '')).join('\n');
}

/** Чистка текста ИИ: без markdown-звёздочек и заголовков, без лишних пустых строк. */
export function cleanBody(body, kind) {
  let s = String(body ?? '').replace(/\r\n?/g, '\n').replace(/\*+/g, '').replace(/^#{1,6}\s+/gm, '');
  if (kind === 'dialogue') {
    return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  }
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function hasPhrase(lower, phrase) {
  if (!phrase) return false;
  try {
    return new RegExp(`(?<![\\p{L}])${escapeRe(phrase)}(?![\\p{L}])`, 'u').test(lower);
  } catch {
    return false;
  }
}

// ---------- грубое сопоставление словоформ ----------
const SUFFIXES = new Set(['', 'e', 'en', 'er', 'es', 'em', 'n', 's', 't', 'st', 'te', 'ten', 'tet', 'test',
  'et', 'ete', 'eten', 'end', 'ende', 'enden', 'ender']);

/** Слово = основа + типичное окончание (с необязательной приставкой ge-). */
export function wordMatchesStem(word, stem) {
  if (!word || !stem) return false;
  const bases = [word];
  if (word.length > stem.length + 2 && word.startsWith('ge')) bases.push(word.slice(2));
  return bases.some((b) => b.startsWith(stem) && SUFFIXES.has(b.slice(stem.length)));
}

function verbStem(w) {
  if (w.length >= 5 && w.endsWith('en')) return w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('n')) return w.slice(0, -1);
  return w;
}

const displayForm = (c) => (c.article ? `${c.article} ${c.term}` : c.term);

// ---------- целевые слова ----------
/** Случайная выборка n карточек из пула (rng подменяется в тестах). */
export function pickTargets(rows, n = MAX_TARGETS, rng = Math.random) {
  const pool2 = [...(Array.isArray(rows) ? rows : [])];
  for (let i = pool2.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool2[i], pool2[j]] = [pool2[j], pool2[i]];
  }
  return pool2.slice(0, n);
}

/** Карточки к повторению или с ошибками; если таких нет, самые новые. */
export async function loadTargetCards(limit = MAX_TARGETS, userId) {
  const now = toSql(nowUtc());
  const whereUser = userId ? 'c.user_id = ? AND s.user_id = ? AND ' : '';
  const params = userId ? [userId, userId, now] : [now];
  let rows = await query(
    `SELECT c.id, c.term, c.article, c.plural, c.pos, c.cloze_answer, c.translation, c.example, c.example_translation
       FROM cards c JOIN card_state s ON s.card_id = c.id
      WHERE /* user_id */ ${whereUser}c.active = 1 AND s.reps > 0 AND (s.due <= ? OR s.lapses > 0)
      GROUP BY c.id
      ORDER BY MIN(s.due) ASC, SUM(s.lapses) DESC
      LIMIT 16`, params);
  if (!rows || !rows.length) {
    const w2 = userId ? 'WHERE user_id = ? AND active = 1' : 'WHERE active = 1';
    const p2 = userId ? [userId] : [];
    rows = await query(
      `SELECT id, term, article, plural, pos, cloze_answer, translation, example, example_translation FROM cards /* user_id */ ${w2} ORDER BY id DESC LIMIT 8`, p2);
  }
  return pickTargets(rows, limit);
}

function cardOccurs(c, tokens, lower) {
  const extras = [c.cloze_answer, c.plural]
    .map((f) => lowerNorm(stripLeadingArticle(f)))
    .filter((f) => f.length >= 2 && /\p{L}/u.test(f) && !/^[-–—¨]/.test(f));
  if (extras.some((f) => hasPhrase(lower, f))) return true;
  const term = lowerNorm(c.term);
  const words = tokenize(term);
  if (!words.length) return false;
  if (words.length === 1) {
    return tokens.some((t) => wordMatchesStem(t, words[0])
      || (c.pos === 'verb' && wordMatchesStem(t, verbStem(words[0]))));
  }
  if (hasPhrase(lower, term)) return true;
  const content = words.filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (!content.length) return false;
  const hits = content.filter((w) => tokens.some((t) => wordMatchesStem(t, w)
    || (w.length >= 6 && w.endsWith('en') && wordMatchesStem(t, verbStem(w))))).length;
  return hits * 2 >= content.length;
}

/** id целевых карточек, чьи формы реально встретились в тексте. */
export function termsInBody(body, cards) {
  const lower = lowerNorm(body);
  const tokens = [...new Set(tokenize(lower))];
  return (cards ?? []).filter((c) => c && Number.isInteger(c.id) && cardOccurs(c, tokens, lower)).map((c) => c.id);
}

// ---------- вопросы ----------
const TF = ['Richtig', 'Falsch'];

function tfAnswer(a, options) {
  if (typeof a === 'boolean') return a ? 0 : 1;
  let v = a;
  if (typeof a === 'string') {
    const s = a.trim().toLowerCase();
    if (/^(richtig|true|wahr|ja|r)$/.test(s)) return 0;
    if (/^(falsch|false|nein|f)$/.test(s)) return 1;
    if (/^[01]$/.test(s)) v = Number(s);
  }
  if (Number.isInteger(v) && v >= 0 && v <= 1) {
    const t = String(options[v] ?? '').toLowerCase();
    if (t === 'falsch') return 1;
    if (t === 'richtig') return 0;
    return v;
  }
  return null;
}

function mcAnswer(a, n) {
  let v = a;
  if (typeof a === 'string') {
    const s = a.trim();
    if (/^[a-dA-D]$/.test(s)) v = s.toLowerCase().charCodeAt(0) - 97;
    else if (/^\d+$/.test(s)) v = Number(s);
  }
  return Number.isInteger(v) && v >= 0 && v < n ? v : null;
}

function normalizeQuestion(q, body) {
  if (!q || typeof q !== 'object') return null;
  const text = clip(q.text ?? q.question, 500);
  const evidence = String(q.evidence ?? '').trim().replace(/^[„“"'«»‚‘’\s.…]+|[„“"'«»‚‘’\s.…]+$/g, '');
  if (!text || evidence.length < 5 || !body.includes(evidence)) return null;
  let options = Array.isArray(q.options)
    ? q.options.map((o) => clip(o, 200).replace(/^[A-Da-d][).:]\s+/, '')) : [];
  const t = String(q.type ?? '').toLowerCase();
  let type;
  if (/^(tf|true|bool|richtig|r\/f)/.test(t)) type = 'tf';
  else if (/^(mc|multi|choice)/.test(t)) type = 'mc';
  else type = options.length >= 3 ? 'mc' : 'tf';
  const explanation_ru = clip(q.explanation_ru, 400);
  if (type === 'tf') {
    const answer = tfAnswer(q.answer, options);
    return answer === null ? null : { id: '', type, text, options: [...TF], answer, explanation_ru, evidence };
  }
  if (options.length < 3 || options.length > 4 || options.some((o) => !o)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  let answer = mcAnswer(q.answer, options.length);
  if (answer === null) return null;
  if (options.length === 4) {
    // лишний неверный вариант (с конца) выкидываем
    let drop = 3;
    while (drop === answer) drop--;
    options = options.filter((_, i) => i !== drop);
    if (drop < answer) answer -= 1;
  }
  // детерминированное перемешивание, чтобы верный ответ не был всегда первым
  const keyed = options.map((o, i) => ({ o, i, h: sha(`${text}|${o}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return {
    id: '', type, text, options: keyed.map((k) => k.o),
    answer: keyed.findIndex((k) => k.i === answer), explanation_ru, evidence,
  };
}

/** Валидные вопросы (без дублей, максимум max), id q1..qn. */
export function normalizeQuestions(raw, body, max = 8) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const q of raw) {
    const nq = normalizeQuestion(q, body);
    if (!nq) continue;
    const k = nq.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(nq);
    if (out.length >= max) break;
  }
  return out.map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

// ---------- TextItem ----------
function parseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function textRowToItem(row) {
  const speakers = parseJson(row.speakers, null);
  const ids = parseJson(row.target_card_ids, []);
  const qs = parseJson(row.questions, []);
  const glossary = parseJson(row.glossary, []);
  let created = null;
  try { created = toIso(row.created_at); } catch { created = null; }
  return {
    id: row.id, kind: row.kind, title: row.title, body: row.body,
    speakers: Array.isArray(speakers) ? speakers : null,
    level: row.level, topic: row.topic, source: row.source,
    target_card_ids: Array.isArray(ids) ? ids.filter(Number.isInteger) : [],
    questions: Array.isArray(qs) ? qs : [],
    glossary: Array.isArray(glossary) ? glossary : [],
    word_count: row.word_count ?? 0, provider: row.provider ?? null, created_at: created,
  };
}

export async function insertText(rec, userId) {
  const [res] = await pool.query(
    `INSERT INTO texts (user_id, kind, title, body, speakers, level, topic, source, target_card_ids, questions, glossary, word_count, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?)`,
    [userId, rec.kind, rec.title, rec.body, rec.speakers ? JSON.stringify(rec.speakers) : null, rec.level, rec.topic,
      JSON.stringify(rec.target_card_ids), JSON.stringify(rec.questions), JSON.stringify(rec.glossary ?? []), rec.word_count, rec.provider]);
  const rows = await query('SELECT * FROM texts WHERE id = ? AND user_id = ?', [res.insertId, userId]);
  if (!rows[0]) throw new ApiError(500, 'INTERNAL', 'Не удалось сохранить текст');
  return textRowToItem(rows[0]);
}

async function loadRecentTitles(kind, topic, userId) {
  const whereUser = userId ? 'user_id = ? AND ' : '';
  const params = userId ? [userId, kind, clip(topic, 50)] : [kind, clip(topic, 50)];
  const rows = await query(`SELECT title FROM texts WHERE /* user_id */ ${whereUser}kind = ? AND topic = ? ORDER BY id DESC LIMIT 5`,
    params);
  return rows.map((r) => r.title);
}

/** Генерация текста: один вызов ИИ + при нехватке вопросов один повторный только для вопросов. */
export async function generateText(params, deps = {}, explicitUserId) {
  const userId = explicitUserId ?? params.userId;
  const chat = deps.chat ?? chatJSON;
  const save = deps.save ?? insertText;
  const { kind, topic, level, length, question_count: qn, use_due_words: useDue, provider } = params;
  let targets = [];
  if (useDue) {
    try { targets = await (deps.loadTargets ?? loadTargetCards)(MAX_TARGETS, userId); } catch { targets = []; }
  }
  let recent = [];
  try { recent = await (deps.loadRecent ?? loadRecentTitles)(kind, topic, userId); } catch { recent = []; }

  const system = loadPrompt(kind === 'reading' ? 'text_reading.txt' : 'text_listening.txt');
  const words = LENGTH_WORDS[length] ?? LENGTH_WORDS.medium;
  const user = [
    'MODE: full_text', `KIND: ${kind}`, `LEVEL: ${level}`, `LENGTH_WORDS: ${words}`, `QUESTION_COUNT: ${qn}`,
    wrapData('TOPIC', topic),
    wrapData('TARGET_WORDS', targets.map(displayForm).join('\n') || '(none)'),
    wrapData('AVOID_TITLES', recent.join('\n') || '(none)'),
  ].join('\n');
  const prefer = provider && provider !== 'auto' ? provider : undefined;

  const first = await chat({
    userId,
    feature: 'text', tier: 'strong', system, user, schema: aiTextSchema(kind),
    temperature: 0.8, maxTokens: Math.min(4500, 1400 + words * 4 + qn * 160), preferProvider: prefer,
  });
  const data = first.data ?? {};
  const body = cleanBody(data.body, kind);
  if (body.length < 50) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул слишком короткий текст. Попробуйте ещё раз.');
  let speakers = null;
  let spoken = body;
  if (kind === 'dialogue') {
    const turns = parseDialogue(body);
    const names = turns ? speakerNames(turns) : [];
    if (!turns || names.length < 2 || names.length > 3) {
      throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ вернул диалог в неверном формате. Попробуйте ещё раз.');
    }
    speakers = names.map((name) => ({ name }));
    spoken = turns.map((t) => t.text).join('\n');
  }

  let questions = normalizeQuestions(data.questions, body, qn);
  if (questions.length < 3) {
    const retry = await chat({
      userId,
      feature: 'text', tier: 'strong', system,
      user: ['MODE: questions_only', `KIND: ${kind}`, `LEVEL: ${level}`, `QUESTION_COUNT: ${qn}`, wrapData('TEXT', body)].join('\n'),
      schema: aiQuestionsSchema, temperature: 0.5, maxTokens: 400 + qn * 220, preferProvider: prefer,
    });
    questions = normalizeQuestions([...questions, ...(retry.data?.questions ?? [])], body, qn);
  }
  if (questions.length < 3) {
    throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ не смог составить корректные вопросы. Попробуйте ещё раз.');
  }

  const usedIds = termsInBody(body, targets);
  const glossary = normalizeGlossary(data.glossary);
  const usedCards = (targets ?? []).filter((c) => c && usedIds.includes(c.id));
  for (const g of glossary) {
    const m = findCardMatch(usedCards, g.article ? `${g.article} ${g.lemma}` : g.lemma) || findCardMatch(usedCards, g.word);
    if (m) g.in_cards = { id: m.id, term: m.term, translation: m.translation ?? g.translation_ru };
  }
  for (const c of usedCards) {
    if (!c.term || !c.translation) continue;
    const hit = glossary.some((g) => g.lemma.toLowerCase() === c.term.toLowerCase());
    if (!hit) {
      glossary.push({
        word: c.term,
        lemma: c.term,
        article: c.article ?? null,
        plural: c.plural ?? null,
        pos: c.pos || 'noun',
        translation_ru: c.translation,
        example: c.example ?? null,
        example_ru: c.example_translation ?? null,
        in_cards: { id: c.id, term: c.term, translation: c.translation },
      });
    }
  }

  return save({
    kind, title: clip(data.title, 200) || clip(topic, 200), body, speakers, level, topic: clip(topic, 50),
    target_card_ids: usedIds, questions, glossary,
    word_count: tokenize(spoken).length, provider: first.provider ?? null,
  }, userId);
}

// ---------- известные слова и покрытие ----------
export async function loadActiveCards(userId) {
  const where = userId ? 'WHERE user_id = ? AND active = 1' : 'WHERE active = 1';
  const params = userId ? [userId] : [];
  return query(`SELECT * FROM cards /* user_id */ ${where}`, params);
}

/** Индекс известных форм: термины, plural, cloze_answer карточек. */
export function buildKnownIndex(cards) {
  const forms = new Set();
  const stems = new Map();
  const addStem = (s) => {
    if (s.length < 3) return;
    const k = s.slice(0, 3);
    let a = stems.get(k);
    if (!a) { a = []; stems.set(k, a); }
    a.push(s);
  };
  for (const c of cards ?? []) {
    for (const field of ['term', 'plural', 'cloze_answer']) {
      for (const w of tokenize(stripLeadingArticle(c[field]))) {
        const lw = w.toLowerCase();
        forms.add(lw);
        if (lw.length >= 4) {
          addStem(lw);
          if (field === 'term' && c.pos === 'verb') addStem(verbStem(lw));
        }
      }
    }
  }
  return { forms, stems };
}

export function isKnownToken(token, idx) {
  const lw = token.toLowerCase();
  if (lw.length <= 2 || STOPWORDS.has(lw) || idx.forms.has(lw)) return true;
  const lists = [idx.stems.get(lw.slice(0, 3)), lw.startsWith('ge') ? idx.stems.get(lw.slice(2, 5)) : null];
  return lists.some((a) => a && a.some((s) => wordMatchesStem(lw, s)));
}

/** coverage_pct и самые частые неизвестные слова (4+ букв). */
export function analyzeCoverage(body, idx, kind) {
  const tokens = tokenize(kind === 'dialogue' ? stripSpeakers(body) : body);
  let known = 0;
  const freq = new Map();
  for (const tok of tokens) {
    if (isKnownToken(tok, idx)) { known++; continue; }
    const lw = tok.toLowerCase();
    if (lw.length < 4) continue;
    const e = freq.get(lw);
    if (e) e.count++;
    else freq.set(lw, { word: tok, count: 1, order: freq.size });
  }
  const candidates = [...freq.values()]
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length || a.order - b.order)
    .slice(0, MAX_CANDIDATES).map(({ word, count }) => ({ word, count }));
  return { coverage_pct: tokens.length ? Math.round((known * 100) / tokens.length) : 0, total: tokens.length, candidates };
}

/** Поиск карточки по слову: термин, форма с артиклем, plural, cloze_answer. */
export function findCardMatch(cards, rawWord) {
  const w = lowerNorm(String(rawWord ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  if (!w) return null;
  const m = /^(der|die|das)\s+(.+)$/.exec(w);
  const art = m ? m[1] : null;
  const bare = m ? m[2] : w;
  const list = (cards ?? []).map((c) => ({
    c, term: lowerNorm(c.term), article: c.article ?? null,
    plural: lowerNorm(stripLeadingArticle(c.plural)), cloze: lowerNorm(c.cloze_answer),
  }));
  const passes = [
    (x) => art && x.article === art && x.term === bare,
    (x) => x.term === bare || x.term === w,
    (x) => x.plural && x.plural === bare,
    (x) => x.cloze && (x.cloze === bare || x.cloze === w),
  ];
  for (const p of passes) {
    const hit = list.find((x) => p(x));
    if (hit) return hit.c;
  }
  return null;
}

// ---------- анализ текста ----------
async function loadTextRow(id, userId) {
  const where = userId ? 'WHERE id = ? AND user_id = ?' : 'WHERE id = ?';
  const params = userId ? [id, userId] : [id];
  const rows = await query(`SELECT * FROM texts /* user_id */ ${where}`, params);
  return rows[0] ?? null;
}

async function stageAnalyzed(item, batchId, userId) {
  const r = await upsertCards([item], userId, { source: batchId, batchId });
  return r.added.length > 0;
}

export async function analyzeText(textId, deps = {}, explicitUserId) {
  const userId = explicitUserId ?? deps.userId;
  const chat = deps.chat ?? chatJSON;
  const row = await (deps.loadText ?? loadTextRow)(textId, userId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Текст не найден');
  const cards = await (deps.loadCards ?? loadActiveCards)(userId);
  const body = String(row.body ?? '');
  const cov = analyzeCoverage(body, buildKnownIndex(cards), row.kind);
  const sample = (row.kind === 'dialogue' ? stripSpeakers(body) : body).slice(0, 3500);

  const prefer = deps.provider && deps.provider !== 'auto' ? deps.provider : undefined;
  const { data } = await chat({
    userId,
    feature: 'lookup', tier: 'fast', system: loadPrompt('analyze_text.txt'),
    user: [wrapData('TEXT_SAMPLE', sample),
      wrapData('CANDIDATES', cov.candidates.map((c) => `${c.word} | ${c.count}`).join('\n') || '(none)')].join('\n'),
    schema: aiAnalyzeSchema, cacheTtlDays: 7, temperature: 0.2, maxTokens: 3000, preferProvider: prefer,
  });

  const cand = cov.candidates.map((c) => c.word.toLowerCase());
  const candSet = new Set(cand);
  const seen = new Set();
  const unknown = [];
  for (const raw of Array.isArray(data?.words) ? data.words : []) {
    const r = normalizeLookupResult(raw, '');
    if (!r) continue;
    const lemma = r.lemma.toLowerCase();
    const stem = r.pos === 'verb' ? verbStem(lemma) : lemma;
    if (!candSet.has(r.word.toLowerCase()) && !candSet.has(lemma) && !cand.some((t) => wordMatchesStem(t, stem))) continue;
    const key = `${r.article ?? ''} ${lemma}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (findCardMatch(cards, r.article ? `${r.article} ${r.lemma}` : r.lemma)) continue;
    unknown.push({ ...r, in_cards: null });
    if (unknown.length >= MAX_CANDIDATES) break;
  }

  let staged = 0;
  const stage = deps.stage ?? stageAnalyzed;
  for (const u of unknown) {
    const item = toStagingItem({ ...u, level: row.level, topic: row.topic });
    if (!item) continue;
    try {
      if (await stage(item, `text-${row.id}`, userId)) staged++;
    } catch {
      // одна неудачная вставка не должна ломать весь анализ
    }
  }
  const lvl = /\b(A1|A2|B1|B2|C1|C2)\b/i.exec(String(data?.level_estimate ?? ''));
  return {
    level_estimate: lvl ? lvl[1].toUpperCase() : null,
    summary_ru: clip(data?.summary_ru, 500),
    coverage_pct: cov.coverage_pct,
    unknown_words: unknown,
    staged,
  };
}

// ---------- ключи и пакеты ----------
export const stagingKey = (item) => normalizeKey(item.article, item.term);

export const batchIdFor = (prefix) => `${prefix}-${localDay(nowUtc()).replace(/-/g, '')}`;
