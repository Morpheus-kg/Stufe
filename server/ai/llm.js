// Клиент LLM: кэш -> лимит -> цепочка провайдеров -> валидация (zod)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ApiError } from '../errors.js';
import { getChain, hasAnyProvider } from './providers.js';

const TIMEOUT_MS = 25000;
const RETRY_AFTER_MAX_S = 15; // дольше не ждём, сразу следующий провайдер
const DEFAULT_CAP = 100; // лимит по умолчанию, если AI_DAILY_CAP_<FEATURE> не задан

// Известные фичи (для отчёта /ai/usage); лимит работает для любой фичи
const KNOWN_FEATURES = ['correct', 'generate', 'enrich', 'text', 'translate', 'speak', 'write', 'lookup'];

// Зависимости; тесты подменяют через __setDeps, прод грузит лениво
const deps = {
  fetch: null,
  query: null,
  localDay: null,
  aiEnabled: null,
  env: process.env,
  timeoutMs: TIMEOUT_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (...a) => console.warn(...a),
};

/** Только для тестов. */
export function __setDeps(o) {
  Object.assign(deps, o);
}

export async function dbQuery(sql, params = []) {
  if (!deps.query) deps.query = (await import('../db.js')).query;
  return deps.query(sql, params);
}

async function getDay(userId) {
  if (!deps.localDay) {
    const t = await import('../time.js');
    deps.localDay = t.localDay;
    deps.localDayForUser = t.localDayForUser;
  }
  if (userId && deps.localDayForUser) return deps.localDayForUser(new Date(), userId);
  return deps.localDay(new Date());
}

async function isEnabled(userId) {
  try {
    if (deps.aiEnabled) return await deps.aiEnabled();
    const { getSettings } = await import('../settings.js');
    const s = await getSettings(null, userId);
    return s?.ai_enabled !== false;
  } catch {
    return true;
  }
}

/** ИИ доступен: включён в настройках и есть хотя бы один провайдер. */
export async function isAiAvailable() {
  return (await isEnabled()) && hasAnyProvider(deps.env);
}

// ---------- Промпты и данные пользователя ----------
const promptCache = new Map();
const PROMPT_NAMES = new Set(['enrich', 'correct', 'generate', 'gender']);

export function loadPrompt(name) {
  if (!PROMPT_NAMES.has(name)) throw new Error('unknown prompt');
  if (!promptCache.has(name)) {
    const url = new URL(`./prompts/${name}.txt`, import.meta.url);
    promptCache.set(name, fs.readFileSync(url, 'utf8'));
  }
  return promptCache.get(name);
}

/** Оборачивает пользовательский текст в маркеры (маркеры внутри текста вычищаются). */
export function wrapData(tag, text) {
  const clean = String(text ?? '').replace(/<<<|>>>/g, ' ');
  return `<<<${tag}\n${clean}\n${tag}>>>`;
}

// ---------- Лимиты и учёт ----------
/** Лимит фичи F = env AI_DAILY_CAP_<F в верхнем регистре>, по умолчанию 100. */
export function capFor(feature) {
  const name = `AI_DAILY_CAP_${String(feature).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const n = Number.parseInt(deps.env?.[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CAP;
}

/** Глобальный лимит фичи F (сумма по всем пользователям), если задан. */
export function globalCapFor(feature) {
  const name = `AI_GLOBAL_CAP_${String(feature).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const v = deps.env?.[name];
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function usedToday(feature, day, userId) {
  try {
    if (userId) {
      const rows = await dbQuery(
        'SELECT COALESCE(SUM(calls - failures),0) AS n FROM ai_usage WHERE user_id=? AND day=? AND feature=?',
        [userId, day, feature],
      );
      return Number(rows?.[0]?.n) || 0;
    }
    const rows = await dbQuery(
      'SELECT COALESCE(SUM(calls - failures),0) AS n FROM ai_usage WHERE day=? AND feature=? /* scope-ok: test fallback */',
      [day, feature],
    );
    return Number(rows?.[0]?.n) || 0;
  } catch {
    return 0;
  }
}

async function globalUsedToday(feature, day) {
  try {
    const rows = await dbQuery(
      'SELECT COALESCE(SUM(calls - failures),0) AS n FROM ai_usage WHERE day=? AND feature=? /* scope-ok: global ai cap */',
      [day, feature],
    );
    return Number(rows?.[0]?.n) || 0;
  } catch {
    return 0;
  }
}

async function recordUsage(userId, day, provider, feature, failed) {
  try {
    const uid = userId ?? 1;
    await dbQuery(
      'INSERT INTO ai_usage (user_id, day, provider, feature, calls, failures) VALUES (?,?,?,?,1,?) ' +
        'ON DUPLICATE KEY UPDATE calls=calls+1, failures=failures+VALUES(failures)',
      [uid, day, provider, feature, failed ? 1 : 0],
    );
  } catch {
    deps.log('[ai] usage not recorded');
  }
}

/** Для GET /ai/usage. */
export async function getUsage(userId) {
  const day = await getDay();
  const rows = userId
    ? await dbQuery(
        'SELECT feature, SUM(calls) AS calls, SUM(failures) AS failures FROM ai_usage WHERE user_id=? AND day=? GROUP BY feature',
        [userId, day],
      )
    : await dbQuery(
        'SELECT feature, SUM(calls) AS calls, SUM(failures) AS failures FROM ai_usage WHERE day=? GROUP BY feature /* scope-ok: test fallback */',
        [day],
      );
  const by_feature = {};
  const caps = {};
  const add = (f) => {
    if (!by_feature[f]) {
      by_feature[f] = { calls: 0, failures: 0 };
      caps[f] = capFor(f);
    }
  };
  for (const f of KNOWN_FEATURES) add(f);
  for (const r of rows || []) {
    if (typeof r.feature !== 'string' || !r.feature) continue;
    add(r.feature);
    by_feature[r.feature] = { calls: Number(r.calls) || 0, failures: Number(r.failures) || 0 };
  }
  return { day, by_feature, caps };
}

/**
 * Разрешение эффективных ключей пользователя с учётом ai_mode и personal keys.
 * @param {number} [userId]
 * @returns {Promise<{aiMode: 'shared'|'own'|'off', keys: Record<string, string|null>}>}
 */
export async function resolveUserKeys(userId) {
  const env = deps.env || process.env;
  if (!userId) {
    return {
      aiMode: 'shared',
      keys: {
        groq: env?.GROQ_KEY?.trim() || null,
        gemini: env?.GEMINI_KEY?.trim() || null,
        openrouter: env?.OPENROUTER_KEY?.trim() || null,
      },
    };
  }

  let userRow = null;
  try {
    const rows = await dbQuery('SELECT id, ai_mode, disabled FROM users WHERE id=? /* scope-ok: auth lookup */', [userId]);
    userRow = rows?.[0] || null;
  } catch {
    userRow = null;
  }
  if (!userRow || userRow.disabled) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Пользователь отключён или не существует.');
  }
  const aiMode = userRow.ai_mode || 'shared';
  if (aiMode === 'off') {
    return {
      aiMode: 'off',
      keys: { groq: null, gemini: null, openrouter: null },
    };
  }

  // Загружаем личные ключи пользователя
  const personal = {};
  try {
    const rows = await dbQuery('SELECT provider, ciphertext, iv, tag FROM user_keys WHERE user_id=?', [userId]);
    const { decryptKey, hasValidKeysSecret } = await import('../crypto_keys.js');
    if (hasValidKeysSecret(env?.KEYS_SECRET)) {
      for (const r of rows || []) {
        try {
          personal[r.provider] = decryptKey(r, env.KEYS_SECRET);
        } catch {
          // Повреждённый ключ игнорируем
        }
      }
    }
  } catch {
    // Ошибки чтения ключей не фатальны
  }

  const keys = {};
  for (const p of ['groq', 'gemini', 'openrouter']) {
    if (personal[p]) {
      keys[p] = personal[p];
    } else if (aiMode === 'shared') {
      const serverKey = env?.[(await import('./providers.js')).PROVIDERS[p]?.keyEnv]?.trim() || null;
      keys[p] = serverKey;
    } else {
      keys[p] = null;
    }
  }
  return { aiMode, keys };
}

// ---------- Кэш ----------
export const CACHE_SCHEMA_VERSION = 'v2';
const schemaFpCache = new WeakMap();

export function schemaFingerprint(schema) {
  if (!schema || typeof schema !== 'object') return CACHE_SCHEMA_VERSION;
  if (schemaFpCache.has(schema)) return schemaFpCache.get(schema);
  let fp = CACHE_SCHEMA_VERSION;
  try {
    const keys = schema.shape && typeof schema.shape === 'object' ? Object.keys(schema.shape).sort().join(',') : '';
    fp = `${CACHE_SCHEMA_VERSION}:${keys}`;
  } catch {
    fp = CACHE_SCHEMA_VERSION;
  }
  schemaFpCache.set(schema, fp);
  return fp;
}

export function cacheKeyOf(feature, schemaVer, tier, system, user) {
  return crypto.createHash('sha256').update(`${feature}|${schemaVer}|${tier}|${system}|${user}`).digest('hex');
}

// Кэш не берём, если он от исключённого провайдера, не от выбранного (prefer/strict) или от более слабого tier
async function readCache(key, ttlDays, schema, { excludeProvider, wantProvider, wantTier }) {
  try {
    const rows = await dbQuery(
      'SELECT response FROM ai_cache WHERE cache_key=? AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? DAY)',
      [key, Math.ceil(ttlDays)],
    );
    if (!rows?.[0]) return null;
    const stored = JSON.parse(rows[0].response);
    if (excludeProvider && stored?.provider === excludeProvider) return null;
    if (wantProvider && stored?.provider !== wantProvider) return null;
    if (wantTier && stored?.tier && stored.tier !== wantTier) return null;
    const r = schema.safeParse(stored?.raw);
    if (!r.success) return null;
    return { data: r.data, provider: stored.provider };
  } catch {
    return null;
  }
}

async function writeCache(key, feature, raw, provider, tier) {
  try {
    await dbQuery(
      'INSERT INTO ai_cache (cache_key, feature, response, created_at) VALUES (?,?,?,UTC_TIMESTAMP()) ' +
        'ON DUPLICATE KEY UPDATE response=VALUES(response), created_at=UTC_TIMESTAMP()',
      [key, feature, JSON.stringify({ raw, provider, tier })],
    );
  } catch {
    deps.log('[ai] cache not written');
  }
}

// ---------- Вызов провайдера ----------
function extractJson(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error('no json');
  }
}

function parseAndValidate(text, schema) {
  let raw;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, error: 'ответ не является JSON' };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const msg = (r.error?.issues || [])
      .slice(0, 3)
      .map((i) => `${(i.path || []).join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error: msg || 'не прошёл схему' };
  }
  return { ok: true, raw, data: r.data };
}

// Retry-After в секундах (только числовой формат); иначе null
function parseRetryAfter(headers) {
  let raw = null;
  try {
    raw = headers?.get?.('retry-after') ?? null;
  } catch {
    raw = null;
  }
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function requestOnce(entry, messages, temperature, maxTokens, retry) {
  const f = deps.fetch || globalThis.fetch;
  const send = async () => {
    try {
      return await f(`${entry.provider.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${entry.key}`,
        },
        body: JSON.stringify({
          model: entry.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(entry.provider.supportsJsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch {
      throw new Error('network/timeout');
    }
  };

  let res = await send();
  // 429 с коротким Retry-After: один раз ждём и повторяем у того же провайдера
  if (res.status === 429 && !retry.used) {
    const wait = parseRetryAfter(res.headers);
    if (wait !== null && wait <= RETRY_AFTER_MAX_S) {
      retry.used = true;
      await deps.sleep(wait * 1000);
      res = await send();
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('bad body');
  }
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

async function tryProvider(entry, { system, user, schema, temperature, maxTokens }) {
  const retry = { used: false }; // повтор по Retry-After не больше одного на провайдера
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let text = await requestOnce(entry, messages, temperature, maxTokens, retry);
  let parsed = parseAndValidate(text, schema);
  if (parsed.ok) return parsed;

  // Один ремонтный повтор у того же провайдера
  messages.push(
    { role: 'assistant', content: String(text).slice(0, 4000) },
    {
      role: 'user',
      content: `Ответ не прошёл проверку: ${parsed.error}. Верни ТОЛЬКО исправленный JSON по схеме, без пояснений и без markdown.`,
    },
  );
  text = await requestOnce(entry, messages, temperature, maxTokens, retry);
  parsed = parseAndValidate(text, schema);
  if (parsed.ok) return parsed;
  throw new Error('invalid json');
}

const cleanName = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : '');

function parseProviderSpec(v) {
  const s = cleanName(v);
  if (!s || s === 'auto') return { name: '', tier: null };
  const [name, tier] = s.split(':');
  return {
    name: name || '',
    tier: tier === 'strong' || tier === 'fast' ? tier : null,
  };
}

// ---------- Публичный API ----------
/**
 * @param {{feature:string, tier:'strong'|'fast', system:string, user:string, schema:any,
 *   cacheTtlDays?:number, excludeProvider?:string, preferProvider?:string, strictProvider?:string,
 *   temperature?:number, maxTokens?:number}} o
 * preferProvider: пробуем первым (допускается суффикс :strong или :fast, например 'gemini:strong'), затем обычная цепочка.
 * strictProvider: только он, без запасных; при сбое 503 AI_UNAVAILABLE (strict сильнее prefer).
 * @returns {Promise<{data:any, provider:string, cached:boolean}>}
 */
export async function chatJSON({
  userId,
  feature,
  tier,
  system,
  user,
  schema,
  cacheTtlDays,
  excludeProvider,
  preferProvider,
  strictProvider,
  temperature = 0.2,
  maxTokens = 1500,
}) {
  if (!(await isEnabled(userId))) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ отключён в настройках.');
  }

  const { aiMode, keys: effectiveKeys } = await resolveUserKeys(userId);
  if (aiMode === 'off') {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ отключён администратором.');
  }

  const strictSpec = parseProviderSpec(strictProvider);
  const preferSpec = strictSpec.name ? { name: '', tier: null } : parseProviderSpec(preferProvider);
  const strict = strictSpec.name;
  const prefer = preferSpec.name;
  const excluded = parseProviderSpec(excludeProvider).name;
  const requestedTier = tier === 'fast' ? 'fast' : 'strong';
  const effectiveTier = strictSpec.tier || preferSpec.tier || requestedTier;
  const isLowTierFallback = requestedTier === 'strong' && effectiveTier === 'fast';

  // 1. кэш (ключ включает версию схемы и запрошенный класс модели)
  const schemaVer = schemaFingerprint(schema);
  const key = cacheKeyOf(feature, schemaVer, requestedTier, system, user);
  if (cacheTtlDays > 0 && !isLowTierFallback) {
    const hit = await readCache(key, cacheTtlDays, schema, {
      excludeProvider: excluded,
      wantProvider: strict || prefer,
      wantTier: requestedTier,
    });
    if (hit) return { data: hit.data, provider: hit.provider, cached: true };
  }

  // 2. цепочка провайдеров и лимит
  const t = effectiveTier;
  const { chainNames, PROVIDERS } = await import('./providers.js');
  let chain = [];
  for (const n of chainNames(deps.env)) {
    if (excluded && n === excluded) continue;
    const provider = PROVIDERS[n];
    const keyVal = effectiveKeys[n];
    const model = deps.env?.[provider.modelEnv[t]]?.trim();
    if (!keyVal || !model) continue;
    chain.push({ provider, key: keyVal, model, tier: t });
  }

  if (strict) {
    chain = chain.filter((e) => e.provider.name === strict);
  } else if (prefer) {
    const i = chain.findIndex((e) => e.provider.name === prefer);
    if (i > 0) chain.unshift(chain.splice(i, 1)[0]);
  }

  if (!chain.length) {
    throw new ApiError(
      503,
      'AI_UNAVAILABLE',
      strict ? 'Выбранный ИИ-провайдер недоступен.' : 'ИИ недоступен: не настроены провайдеры.',
    );
  }

  const day = await getDay(userId);

  // Лимиты: если ai_mode === 'own', лимиты не применяются
  if (aiMode !== 'own') {
    const gCap = globalCapFor(feature);
    if (gCap !== null) {
      const gUsed = await globalUsedToday(feature, day);
      if (gUsed >= gCap) {
        throw new ApiError(429, 'AI_CAP', 'Общий дневной лимит ИИ исчерпан на сегодня.');
      }
    }
    const cap = capFor(feature);
    const uUsed = await usedToday(feature, day, userId);
    if (uUsed >= cap) {
      throw new ApiError(429, 'AI_CAP', 'Дневной лимит ИИ-запросов исчерпан.');
    }
  }

  // 3. перебор провайдеров (запрещено кэшировать ответ модели :fast, если запрашивался :strong)
  for (const entry of chain) {
    try {
      const r = await tryProvider(entry, { system, user, schema, temperature, maxTokens });
      await recordUsage(userId, day, entry.provider.name, feature, false);
      const canCache = cacheTtlDays > 0 && !isLowTierFallback && entry.tier === requestedTier;
      if (canCache) await writeCache(key, feature, r.raw, entry.provider.name, entry.tier);
      return { data: r.data, provider: entry.provider.name, cached: false };
    } catch (e) {
      await recordUsage(userId, day, entry.provider.name, feature, true);
      deps.log(`[ai] ${entry.provider.name} failed: ${e?.message || 'error'}`);
    }
  }
  throw new ApiError(
    503,
    'AI_UNAVAILABLE',
    strict ? 'Выбранный ИИ-провайдер не ответил. Попробуйте другой.' : 'ИИ сейчас недоступен. Попробуйте позже.',
  );
}

/**
 * Прямая мультимодальная оценка аудио через Gemini Native generateContent (inlineData).
 * Оценивает интонацию, темп (WPM), паузы, умлауты, долготу гласных и грамматику напрямую по звуку.
 */
export async function chatAudioJSON({
  userId,
  feature = 'speak',
  tier = 'strong',
  system,
  user,
  audioBuffer,
  mimeType = 'audio/webm',
  schema,
  temperature = 0.2,
  maxTokens = 1500,
}) {
  if (!(await isEnabled(userId))) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ отключён в настройках.');
  }
  const { aiMode, keys: effectiveKeys } = await resolveUserKeys(userId);
  if (aiMode === 'off') {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ИИ отключён администратором.');
  }
  const geminiKey = effectiveKeys.gemini;
  const model = (tier === 'fast'
    ? (deps.env?.GEMINI_MODEL_FAST || deps.env?.GEMINI_MODEL_STRONG)
    : (deps.env?.GEMINI_MODEL_STRONG || deps.env?.GEMINI_MODEL_FAST)
  )?.trim() || 'gemini-2.5-flash';
  if (!geminiKey) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Для мультимодальной оценки аудио требуется ключ Gemini.');
  }

  const day = await getDay(userId);
  if (aiMode !== 'own') {
    const gCap = globalCapFor(feature);
    if (gCap !== null && (await globalUsedToday(feature, day)) >= gCap) {
      throw new ApiError(429, 'AI_CAP', 'Общий дневной лимит ИИ исчерпан на сегодня.');
    }
    const cap = capFor(feature);
    if ((await usedToday(feature, day, userId)) >= cap) {
      throw new ApiError(429, 'AI_CAP', 'Дневной лимит ИИ-запросов исчерпан.');
    }
  }

  const f = deps.fetch || globalThis.fetch;
  const base64Audio = Buffer.isBuffer(audioBuffer)
    ? audioBuffer.toString('base64')
    : String(audioBuffer || '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;

  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: mimeType || 'audio/webm', data: base64Audio } },
              { text: user },
            ],
          },
        ],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = parseAndValidate(text, schema);
    if (!parsed.ok) throw new Error(parsed.error || 'invalid json');
    await recordUsage(userId, day, 'gemini', feature, false);
    return { data: parsed.data, provider: 'gemini', cached: false };
  } catch (e) {
    await recordUsage(userId, day, 'gemini', feature, true);
    deps.log(`[ai] gemini audio failed: ${e?.message || 'error'}`);
    throw new ApiError(503, 'AI_UNAVAILABLE', 'Мультимодальная оценка аудио временно недоступна.');
  }
}