// Провайдеры LLM (OpenAI-совместимый API). Новый провайдер = один объект.
export const PROVIDERS = {
  groq: {
    name: 'groq',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_KEY',
    modelEnv: { strong: 'GROQ_MODEL_STRONG', fast: 'GROQ_MODEL_FAST' },
    supportsJsonMode: true, // Groq поддерживает response_format: json_object
  },
  gemini: {
    name: 'gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_KEY',
    modelEnv: { strong: 'GEMINI_MODEL_STRONG', fast: 'GEMINI_MODEL_FAST' },
    supportsJsonMode: false, // Gemini через OpenAI-compat не всегда принимает json_object
  },
  openrouter: {
    name: 'openrouter',
    base: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_KEY',
    modelEnv: { strong: 'OPENROUTER_MODEL_STRONG', fast: 'OPENROUTER_MODEL_FAST' },
    supportsJsonMode: true,
  },
};

export const DEFAULT_CHAIN = 'groq,gemini';

function readEnv(env, name) {
  const v = env?.[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** Известное имя провайдера. */
export function isProviderName(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, x);
}

/** Имена провайдеров из LLM_CHAIN (только известные, без повторов). */
export function chainNames(env = process.env) {
  const raw = readEnv(env, 'LLM_CHAIN') || DEFAULT_CHAIN;
  const seen = new Set();
  const out = [];
  for (const part of raw.split(',')) {
    const n = part.trim().toLowerCase();
    if (PROVIDERS[n] && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Рабочая цепочка: только провайдеры с ключом и моделью для данного tier. */
export function getChain(env, tier, excludeProvider) {
  const t = tier === 'fast' ? 'fast' : 'strong';
  const res = [];
  for (const n of chainNames(env)) {
    if (excludeProvider && n === excludeProvider) continue;
    const provider = PROVIDERS[n];
    const key = readEnv(env, provider.keyEnv);
    const model = readEnv(env, provider.modelEnv[t]);
    if (!key || !model) continue;
    res.push({ provider, key, model });
  }
  return res;
}

/** Есть ли хоть один настроенный провайдер. */
export function hasAnyProvider(env = process.env) {
  return getChain(env, 'strong').length > 0 || getChain(env, 'fast').length > 0;
}

/**
 * Описание цепочки для GET /ai/providers.
 * available = задан ключ и хотя бы одна модель (названия моделей не секрет).
 */
export function describeChain(env = process.env) {
  return chainNames(env).map((n) => {
    const p = PROVIDERS[n];
    const key = readEnv(env, p.keyEnv);
    const strong = readEnv(env, p.modelEnv.strong) || null;
    const fast = readEnv(env, p.modelEnv.fast) || null;
    return { name: n, available: !!key && !!(strong || fast), models: { strong, fast } };
  });
}