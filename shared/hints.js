// Лесенка подсказок. Чистый модуль: без Node и DOM API.

export const MAX_HINT_STEP = 3;

const ARTICLES = ['der', 'die', 'das'];
const PART_RE = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u;

/** Маскируем слово: оставляем первые keep символов, остальное — подчёркивания */
function maskCore(core, keep) {
  const chars = [...core];
  if (chars.length <= 2) return core; // короткие слова показываем целиком
  const k = Math.min(chars.length, Math.max(1, keep));
  return chars.slice(0, k).join('') + '_'.repeat(chars.length - k);
}

/**
 * Подсказка к эталону.
 * Шаг 1: первые буквы слов; шаг 2: первая половина слов; шаг 3: полный ответ (считается ошибкой).
 * Ведущий der/die/das (если за ним есть слова) показывается целиком.
 * @param {string} expected
 * @param {number} step 1..3
 * @returns {string}
 */
export function makeHint(expected, step) {
  if (typeof expected !== 'string') return '';
  const text = expected.trim();
  if (!text) return '';
  let st = Math.floor(Number(step));
  if (!Number.isFinite(st) || st < 1) return '';
  if (st >= MAX_HINT_STEP) return text;

  const tokens = text.split(/\s+/);
  const out = tokens.map((tok, i) => {
    const m = PART_RE.exec(tok);
    if (!m) return tok;
    const [, pre, core, post] = m;
    if (!core) return tok;
    if (i === 0 && tokens.length > 1 && ARTICLES.includes(core.toLowerCase())) return tok;
    const len = [...core].length;
    const keep = st === 1 ? 1 : Math.ceil(len / 2);
    return pre + maskCore(core, keep) + post;
  });
  return out.join(' ');
}