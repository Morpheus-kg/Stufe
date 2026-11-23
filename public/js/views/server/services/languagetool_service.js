// Изолированный сервис LanguageTool API (de-DE) с таймаутом и тихим graceful fallback.
// Не заменяет LLM API, не обращается к БД, базовый URL задаётся через LANGUAGETOOL_URL (.env).
import { config } from '../config.js';

const MAX_TEXT_CHARS = 5000;
const MAX_MATCHES = 30;
const MAX_REPLACEMENTS = 5;

const SHORT_FUNC_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'kein', 'keine', 'keinen', 'keinem', 'keiner', 'mein', 'meine', 'dein', 'deine', 'sein', 'seine', 'ihr', 'ihre',
  'in', 'im', 'an', 'am', 'auf', 'aus', 'bei', 'beim', 'für', 'mit', 'nach', 'seit', 'über', 'um', 'unter', 'von', 'vom', 'vor', 'zu', 'zum', 'zur',
]);

const CATEGORY_LABEL_RU = {
  artikel: 'Артикль',
  kasus: 'Падеж',
  wortstellung: 'Порядок слов',
  praeposition: 'Предлог',
  konjugation: 'Спряжение',
  rechtschreibung: 'Орфография и пунктуация',
  wortschatz: 'Лексика и стиль',
  sonstiges: 'Грамматика',
};

/** Маппинг категории/правила LanguageTool -> внутренние категории Stufe */
export function mapLtCategory(rule) {
  const catId = String(rule?.category?.id || '').toUpperCase();
  const issueType = String(rule?.issueType || '').toLowerCase();
  const ruleId = String(rule?.id || '').toUpperCase();
  const desc = String(rule?.description || '').toLowerCase();

  if (
    catId === 'TYPOS'
    || catId === 'CASING'
    || catId === 'COMPOUNDING'
    || catId === 'PUNCTUATION'
    || catId === 'TYPOGRAPHY'
    || issueType === 'misspelling'
    || issueType === 'typographical'
  ) {
    return 'rechtschreibung';
  }
  if (/ARTIKEL|GENUS|GENDER|DER_DIE_DAS/.test(ruleId) || /artikel|genus|geschlecht/.test(desc)) {
    return 'artikel';
  }
  if (/KASUS|DATIV|AKKUSATIV|GENITIV|NOMINATIV|DEKLINATION/.test(ruleId) || /kasus|dativ|akkusativ|genitiv/.test(desc)) {
    return 'kasus';
  }
  if (/PRAEPOSITION|PRÄPOSITION/.test(ruleId) || /präposition/.test(desc)) {
    return 'praeposition';
  }
  if (/KONJUGATION|VERB|TEMPUS|SUBJEKT_VERB/.test(ruleId) || /konjugation|verbform|subjekt/.test(desc)) {
    return 'konjugation';
  }
  if (/WORTSTELLUNG|SATZBAU|WORD_ORDER/.test(ruleId) || /wortstellung|satzbau/.test(desc)) {
    return 'wortstellung';
  }
  if (catId === 'STYLE' || catId === 'COLLOCATIONS' || catId === 'REDUNDANCY' || catId === 'SEMANTICS' || issueType === 'style') {
    return 'wortschatz';
  }
  return 'sonstiges';
}

/** Извлекает предложение из текста вокруг offset..offset+length для примера в FSRS */
export function extractContextSentence(text, offset, length) {
  const s = String(text || '');
  if (!s) return '';
  const startPos = Math.max(0, Math.min(s.length, offset));
  const endPos = Math.max(startPos, Math.min(s.length, offset + Math.max(0, length)));

  let lo = startPos;
  while (lo > 0 && !/[.!?\n]/.test(s[lo - 1])) lo -= 1;
  let hi = endPos;
  while (hi < s.length && !/[.!?\n]/.test(s[hi])) hi += 1;
  if (hi < s.length && /[.!?]/.test(s[hi])) hi += 1;

  return s.slice(lo, hi).replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * Формирует осмысленную фразу для карточки FSRS:
 * если исправление — одиночный артикль/предлог ("die"), подклеиваем следующее слово ("die Wohnung").
 */
export function buildSuggestedCardTerm(text, offset, length, replacement) {
  const rep = String(replacement || '').trim();
  const bad = String(text || '').slice(offset, offset + length).trim();
  const base = rep || bad;
  if (!base) return '';

  const low = base.toLowerCase();
  if (SHORT_FUNC_WORDS.has(low)) {
    const after = String(text || '').slice(offset + length);
    const nextWord = /^\s+([\p{L}\p{N}-]{2,40})/u.exec(after);
    if (nextWord) return `${base} ${nextWord[1]}`.slice(0, 200);
  }
  return base.slice(0, 200);
}

function normalizeMatch(raw, text) {
  if (!raw || typeof raw !== 'object') return null;
  const offset = Number(raw.offset);
  const length = Number(raw.length);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || offset > text.length) {
    return null;
  }
  const safeLen = Math.min(length, text.length - offset);
  const bad = text.slice(offset, offset + safeLen);
  const replacements = Array.isArray(raw.replacements)
    ? raw.replacements
      .map((r) => (r && typeof r.value === 'string' ? r.value.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_REPLACEMENTS)
    : [];
  const category = mapLtCategory(raw.rule);
  const contextSentence = extractContextSentence(text, offset, safeLen);
  const suggestedCardTerm = buildSuggestedCardTerm(text, offset, safeLen, replacements[0]);

  return {
    offset,
    length: safeLen,
    bad,
    replacements,
    category,
    categoryLabelRu: CATEGORY_LABEL_RU[category] || CATEGORY_LABEL_RU.sonstiges,
    message: String(raw.message || '').trim().slice(0, 400),
    shortMessage: String(raw.shortMessage || '').trim().slice(0, 160),
    ruleId: String(raw.rule?.id || '').trim().slice(0, 100),
    contextSentence,
    suggestedCardTerm,
  };
}

/**
 * Фабрика LanguageToolService (удобно тестировать с мок-fetch).
 * @param {{baseUrl?:string, timeoutMs?:number, username?:string, apiKey?:string, fetch?:Function}} [opts]
 */
export function createLanguageToolService(opts = {}) {
  const baseUrl = opts.baseUrl || config.languageTool.baseUrl;
  const defaultTimeoutMs = opts.timeoutMs || config.languageTool.timeoutMs || 4500;
  const username = opts.username ?? config.languageTool.username;
  const apiKey = opts.apiKey ?? config.languageTool.apiKey;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  /**
   * Проверить немецкий текст через LanguageTool API.
   * Никогда не бросает исключений — при таймауте/429/сети возвращает {available:false, degraded:true, matches:[]}.
   * @param {string} rawText
   * @param {{language?:string, timeoutMs?:number, signal?:AbortSignal}} [callOpts]
   */
  async function check(rawText, callOpts = {}) {
    const language = typeof callOpts.language === 'string' && callOpts.language.trim() ? callOpts.language.trim() : 'de-DE';
    const text = String(rawText ?? '').slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) {
      return { available: true, degraded: false, reason: 'empty', language, matches: [] };
    }
    if (!baseUrl || typeof fetchFn !== 'function') {
      return { available: false, degraded: true, reason: 'network', language, matches: [] };
    }

    const timeoutMs = Math.min(15000, Math.max(500, Number(callOpts.timeoutMs) || defaultTimeoutMs));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExtAbort = () => ctrl.abort();
    if (callOpts.signal) {
      if (callOpts.signal.aborted) {
        clearTimeout(timer);
        return { available: false, degraded: true, reason: 'timeout', language, matches: [] };
      }
      callOpts.signal.addEventListener('abort', onExtAbort, { once: true });
    }

    try {
      const form = new URLSearchParams({
        text,
        language,
        enabledOnly: 'false',
      });
      if (username && apiKey) {
        form.set('username', username);
        form.set('apiKey', apiKey);
      }

      const res = await fetchFn(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: ctrl.signal,
      });

      if (res.status === 429) {
        return { available: false, degraded: true, reason: 'rate_limit', language, matches: [] };
      }
      if (!res.ok) {
        return { available: false, degraded: true, reason: 'http_error', language, matches: [] };
      }

      const data = await res.json();
      const rawMatches = Array.isArray(data?.matches) ? data.matches : [];
      const matches = [];
      for (const m of rawMatches) {
        const clean = normalizeMatch(m, text);
        if (clean) matches.push(clean);
        if (matches.length >= MAX_MATCHES) break;
      }

      return {
        available: true,
        degraded: false,
        language,
        matches,
      };
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'timeout' : 'network';
      return { available: false, degraded: true, reason, language, matches: [] };
    } finally {
      clearTimeout(timer);
      if (callOpts.signal) callOpts.signal.removeEventListener('abort', onExtAbort);
    }
  }

  return { check, baseUrl, timeoutMs: defaultTimeoutMs };
}

export const languageToolService = createLanguageToolService();
export default languageToolService;
