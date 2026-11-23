// Маршруты ИИ: исправление предложений, генерация слов, провайдеры, расход лимитов
import crypto from 'node:crypto';
import { Router } from 'express';
import { ApiError, asyncHandler } from '../errors.js';
import { query } from '../db.js';
import { getSettings } from '../settings.js';
import { normalizeKey } from '../keys.js';
import { upsertCards } from '../cards_service.js';
import { toCard } from './cards.js';
import { chatJSON, getUsage, loadPrompt, wrapData } from '../ai/llm.js';
import { describeChain, isProviderName } from '../ai/providers.js';
import { buildGenerateRequest, checkGender, isRedemittel, normalizeGenerated } from '../ai/enrich.js';
import {
  correctRequestSchema,
  correctSchema,
  generateBatchSchema,
  generateItemSchema,
  generateRequestSchema,
  parseOrThrow,
} from '../ai/schemas.js';

export const mountPath = '/api/ai';
const router = Router();
export default router;

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

// Значение настройки ai_provider_generate (auto или имя провайдера)
async function defaultGenerateProvider(userId) {
  try {
    const s = await getSettings(null, userId);
    const v = s?.ai_provider_generate;
    if (v === 'auto' || isProviderName(String(v ?? '').split(':')[0])) return v;
  } catch {
    // настройки недоступны: auto
  }
  return 'auto';
}

// ---------- GET /ai/providers ----------
router.get(
  '/providers',
  asyncHandler(async (req, res) => {
    let chain = [];
    if (req.user?.id) {
      try {
        const { resolveUserKeys } = await import('../ai/llm.js');
        const { chainNames, PROVIDERS } = await import('../ai/providers.js');
        const { aiMode, keys } = await resolveUserKeys(req.user.id);
        if (aiMode === 'off') {
          chain = chainNames(process.env).map((n) => {
            const p = PROVIDERS[n];
            const strong = process.env[p.modelEnv.strong]?.trim() || null;
            const fast = process.env[p.modelEnv.fast]?.trim() || null;
            return { name: n, available: false, models: { strong, fast } };
          });
        } else {
          chain = chainNames(process.env).map((n) => {
            const p = PROVIDERS[n];
            const key = keys[n];
            const strong = process.env[p.modelEnv.strong]?.trim() || null;
            const fast = process.env[p.modelEnv.fast]?.trim() || null;
            return { name: n, available: Boolean(key && (strong || fast)), models: { strong, fast } };
          });
        }
      } catch {
        chain = describeChain(process.env);
      }
    } else {
      chain = describeChain(process.env);
    }
    res.json({
      chain,
      default_generate: await defaultGenerateProvider(req.user?.id),
    });
  }),
);

// ---------- POST /ai/correct-sentence ----------
router.post(
  '/correct-sentence',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = parseOrThrow(correctRequestSchema, req.body);

    let card = null;
    if (body.card_id) {
      const rows = await query('SELECT * FROM cards WHERE id=? AND user_id=? AND active=1', [body.card_id, userId]);
      card = rows?.[0] || null;
      if (!card) throw new ApiError(404, 'NOT_FOUND', 'Карточка не найдена.');
    }
    const target = card ? (card.article ? `${card.article} ${card.term}` : card.term) : '(none)';
    const user = `${wrapData('TARGET', target)}\n${wrapData('SENTENCE', body.text)}`;

    const prefer = body.provider && body.provider !== 'auto' ? body.provider : undefined;
    const { data, provider } = await chatJSON({
      userId,
      feature: 'correct',
      tier: 'strong',
      system: loadPrompt('correct'),
      user,
      schema: correctSchema,
      cacheTtlDays: 7,
      maxTokens: 1500,
      ...(prefer ? { preferProvider: prefer } : {}),
    });

    const errors = data.errors;
    const same = norm(data.corrected) === norm(body.text);
    const isCorrect = errors.length ? false : data.is_correct || same;
    const usesTarget = card ? data.uses_target_word : false;

    const ins = await query(
      'INSERT INTO sentences (user_id, card_id, text, corrected, errors, is_correct, provider, created_at) ' +
        'VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())',
      [userId, card ? card.id : null, body.text, data.corrected, JSON.stringify(errors), isCorrect ? 1 : 0, provider],
    );

    res.json({
      id: ins?.insertId ?? null,
      corrected: data.corrected,
      is_correct: isCorrect,
      uses_target_word: usesTarget,
      errors,
      alternative: data.alternative ?? null,
    });
  }),
);

// ---------- POST /ai/generate-words ----------
function placeholders(n) {
  return new Array(n).fill('?').join(',');
}

// Какие ключи уже есть в cards; dedupe_key в utf8mb4_bin, сравнение точное
async function findExistingKeys(keys, userId) {
  if (!keys.length) return new Set();
  const ph = placeholders(keys.length);
  const a = await query(`SELECT dedupe_key FROM cards WHERE user_id=? AND dedupe_key IN (${ph})`, [userId, ...keys]);
  const set = new Set();
  for (const r of a || []) set.add(r.dedupe_key);
  return set;
}

router.post(
  '/generate-words',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const body = parseOrThrow(generateRequestSchema, req.body);
    const want = Math.min(30, Math.ceil(body.count * 1.5));
    const redemittel = isRedemittel(body.topic);

    // Выбор провайдера: тело запроса, иначе настройка; auto = обычная цепочка
    const chosen = body.provider ?? (await defaultGenerateProvider(userId));
    const named = chosen !== 'auto' && isProviderName(String(chosen ?? '').split(':')[0]) ? chosen : undefined;

    const { data, provider } = await chatJSON({
      userId,
      feature: 'generate',
      tier: 'fast',
      system: loadPrompt('generate'),
      user: wrapData(
        'REQUEST',
        JSON.stringify(
          buildGenerateRequest({ topic: body.topic, count: want, pos_mix: body.pos_mix, level: body.level }),
        ),
      ),
      schema: generateBatchSchema,
      preferProvider: body.strict ? undefined : named,
      strictProvider: body.strict ? named : undefined,
      temperature: 0.7,
      maxTokens: 4000,
    });

    // Валидация и дедупликация внутри пачки
    let dropped = 0;
    const seen = new Set();
    let candidates = [];
    for (const raw of data.items) {
      const r = generateItemSchema.safeParse(raw);
      if (!r.success) continue;
      const it = normalizeGenerated(r.data, { topic: body.topic, level: body.level, redemittel });
      if (!it) continue;
      const key = normalizeKey(it.article, it.term);
      if (!key || seen.has(key)) {
        dropped += 1;
        continue;
      }
      seen.add(key);
      candidates.push({ ...it, dedupe_key: key });
    }

    // Дубликаты в БД
    const existing = await findExistingKeys(candidates.map((c) => c.dedupe_key), userId);
    candidates = candidates.filter((c) => {
      if (existing.has(c.dedupe_key)) {
        dropped += 1;
        return false;
      }
      return true;
    });

    // Существительные вперёд (стабильно), обрезка до count
    if (body.pos_mix === 'nouns_first' && !redemittel) {
      candidates = [
        ...candidates.filter((c) => c.pos === 'noun'),
        ...candidates.filter((c) => c.pos !== 'noun'),
      ];
    }
    const items = candidates.slice(0, body.count);

    // Проверка рода вторым провайдером
    const nouns = items
      .map((it, i) => ({ id: i, term: it.term, translation: it.translation, it }))
      .filter((n) => n.it.pos === 'noun');
    if (nouns.length) {
      const gmap = await checkGender(nouns, { excludeProvider: provider, feature: 'generate', userId });
      if (gmap) {
        for (const n of nouns) {
          const g = gmap.get(n.id);
          if (!g) continue;
          const plDiff =
            g.plural && n.it.plural && norm(g.plural).replace(/^die /, '') !== norm(n.it.plural).replace(/^die /, '');
          if ((g.article && g.article !== n.it.article) || plDiff) n.it.check_flag = 1;
        }
      }
    }

    const batchId = crypto.randomUUID();
    if (!items.length) {
      return res.json({ batch_id: batchId, items: [], dropped_duplicates: dropped });
    }

    // Карточки сразу попадают в колоду; дубли отсеивает upsertCards; provider = тот, кто сгенерировал
    const r = await upsertCards(items, userId, { source: `ai:${provider}`, batchId });
    res.json({
      batch_id: batchId,
      items: r.added.map(toCard),
      dropped_duplicates: dropped + r.duplicates,
    });
  }),
);
// ---------- GET /ai/usage ----------
// Работает и без ключей ИИ (только статистика)
router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    res.json(await getUsage(req.user?.id));
  }),
);