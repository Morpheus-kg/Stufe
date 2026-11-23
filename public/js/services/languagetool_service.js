// Фронтенд-сервис LanguageToolService: обращается к /api/languagetool/check с таймаутом и тихим fallback.
// Никогда не бросает исключений — при проблемах сети / rate-limit возвращает {available:false, degraded:true, matches:[]}.

const DEFAULT_TIMEOUT_MS = 5500;

export function createLanguageToolClient(deps = {}) {
  const fetchFn = deps.fetch ?? (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  const endpoint = deps.endpoint ?? '/api/languagetool/check';

  /**
   * @param {string} text
   * @param {{language?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<{available:boolean, degraded:boolean, reason?:string, language:string, matches:Array}>}
   */
  async function check(text, opts = {}) {
    const language = opts.language || 'de-DE';
    const clean = String(text ?? '').slice(0, 5000);
    if (!clean.trim()) {
      return { available: true, degraded: false, reason: 'empty', language, matches: [] };
    }
    if (!fetchFn) {
      return { available: false, degraded: true, reason: 'network', language, matches: [] };
    }

    const timeoutMs = Math.min(15000, Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExtAbort = () => ctrl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        return { available: false, degraded: true, reason: 'timeout', language, matches: [] };
      }
      opts.signal.addEventListener('abort', onExtAbort, { once: true });
    }

    try {
      const res = await fetchFn(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ text: clean, language }),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        return { available: false, degraded: true, reason: 'rate_limit', language, matches: [] };
      }
      if (!res.ok) {
        return { available: false, degraded: true, reason: 'http_error', language, matches: [] };
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        return { available: false, degraded: true, reason: 'http_error', language, matches: [] };
      }
      return {
        available: data.available !== false,
        degraded: !!data.degraded,
        ...(data.reason ? { reason: data.reason } : {}),
        language: data.language || language,
        matches: Array.isArray(data.matches) ? data.matches : [],
      };
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'timeout' : 'network';
      return { available: false, degraded: true, reason, language, matches: [] };
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onExtAbort);
    }
  }

  return { check };
}

export const languageToolService = createLanguageToolClient();
export default languageToolService;
