// M8a: поиск слова и прямое добавление карточек (lookup, cards/from-lookup, bulk, from-errors) с изоляцией по user_id
import { Router } from 'express';
import { ApiError, asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { chatJSON } from '../ai/llm.js';
import {
  batchIdFor, findCardMatch, loadActiveCards, loadPrompt, wrapData,
} from '../ai/textgen.js';
import {
  aiLookupSchema, clip, lookupRequestSchema, normalizeLookupResult, parseBody, stagingBulkSchema,
  stagingFromErrorsSchema, stagingItemSchema, toStagingItem,
} from '../ai/schemas_v2.js';
import { toCard } from './cards.js';
import { upsertCards } from '../cards_service.js';

export const mountPath = '/api';
const router = Router();

function cardToLookup(word, row) {
  return {
    word, lemma: row.term, article: row.article ?? null, plural: row.plural ?? null, pos: row.pos,
    translation_ru: row.translation, example: row.example ?? null, example_ru: row.example_translation ?? null,
    in_cards: toCard(row),
  };
}

/** Карточка из базы пользователя или один вызов ИИ (быстрый уровень, кэш 30 дней). */
async function lookupWord(rawWord, rawContext, userId) {
  const word = clip(rawWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), 60);
  if (!word) throw new ApiError(400, 'BAD_REQUEST', 'Введите слово');
  const cards = await loadActiveCards(userId);
  const hit = findCardMatch(cards, word);
  if (hit) return cardToLookup(word, hit);

  const context = clip(rawContext, 200);
  const { data } = await chatJSON({
    userId,
    feature: 'lookup', tier: 'fast', system: loadPrompt('lookup.txt'),
    user: [wrapData('WORD', word), wrapData('CONTEXT', context || '(none)')].join('\n'),
    schema: aiLookupSchema, cacheTtlDays: 30, temperature: 0.1, maxTokens: 500,
  });
  if (data?.is_german === false) {
    throw new ApiError(400, 'BAD_REQUEST', clip(data.note_ru, 200) || 'Не похоже на немецкое слово');
  }
  const r = normalizeLookupResult(data, word);
  if (!r) throw new ApiError(502, 'AI_BAD_OUTPUT', 'ИИ не смог разобрать слово. Попробуйте ещё раз.');
  const own = findCardMatch(cards, r.article ? `${r.article} ${r.lemma}` : r.lemma);
  return { ...r, in_cards: own ? toCard(own) : null };
}

router.post('/lookup', requireAuth, asyncHandler(async (req, res) => {
  const { word, context } = parseBody(lookupRequestSchema, req.body);
  res.json(await lookupWord(word, context, req.user.id));
}));

const cardOut = (c) => toCard(c);

router.post('/cards/from-lookup', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const item = toStagingItem(parseBody(stagingItemSchema, req.body));
  if (!item) throw new ApiError(400, 'BAD_REQUEST', 'Некорректные данные запроса');
  const r = await upsertCards([item], userId, { source: 'lookup', batchId: batchIdFor('lookup') });
  if (!r.added.length) throw new ApiError(409, 'CONFLICT', 'Такая карточка уже есть');
  res.status(201).json(cardOut(r.added[0]));
}));

router.post('/cards/bulk', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { items } = parseBody(stagingBulkSchema, req.body);
  const list = items.map((i) => toStagingItem(i)).filter(Boolean);
  const batchId = batchIdFor('lookup');
  const r = await upsertCards(list, userId, { source: 'lookup', batchId });
  res.json({ added: r.added.length, duplicates: r.duplicates + r.skipped + (items.length - list.length), batch_id: batchId });
}));

// Ошибки -> карточки без ИИ
router.post('/cards/from-errors', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { items } = parseBody(stagingFromErrorsSchema, req.body);
  const batchId = batchIdFor('errors');
  const list = [];
  for (const it of items) {
    const term = clip(it.fix, 255);
    if (!term) continue;
    list.push({
      term, article: null, plural: null, pos: 'phrase',
      translation: clip(it.explanation_ru, 500) || 'Исправление ошибки',
      example: clip(it.sentence, 1000) || null, example_translation: null,
      level: 'B2', topic: 'Sonstiges', check_flag: 0,
    });
  }
  const r = await upsertCards(list, userId, { source: 'errors', batchId });
  res.json({ added: r.added.length, duplicates: items.length - r.added.length, batch_id: batchId });
}));

// Совместимость со старым клиентом из кэша PWA (одноразовый алиас)
for (const p of ['from-lookup', 'bulk', 'from-errors']) {
  router.post(`/staging/${p}`, (req, res) => res.redirect(308, `/api/cards/${p}`));
}

export default router;