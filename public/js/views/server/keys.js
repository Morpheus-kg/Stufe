// Ключ дедупликации и справочники карточек (M1 не зависит от shared/constants.js)
export const ARTICLES = ['der', 'die', 'das'];
export const POS_VALUES = ['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation'];
export const LEVEL_VALUES = ['B1', 'B2', 'C1'];
export const MODE_VALUES = ['ru_de', 'cloze', 'article'];

const EDGE_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

function clean(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_RE, '')
    .replace(/\s+/g, ' ');
}

/**
 * Ключ дедупликации: NFC, нижний регистр, пробелы схлопнуты,
 * внешняя пунктуация убрана, артикль (если есть) — префикс.
 * @param {string|null|undefined} article
 * @param {string} term
 * @returns {string} '' если термин пустой
 */
export function normalizeKey(article, term) {
  const t = clean(term);
  if (!t) return '';
  const a = String(article ?? '').trim().toLowerCase();
  return (ARTICLES.includes(a) ? `${a} ${t}` : t).slice(0, 300);
}

/**
 * Отделяет ведущий артикль: 'die Armut' -> {article:'die', term:'Armut'}.
 * Если после артикля ничего нет — не трогает.
 */
export function splitArticle(term) {
  const s = String(term ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const m = /^(der|die|das)\s+(.+)$/iu.exec(s);
  return m ? { article: m[1].toLowerCase(), term: m[2].trim() } : { article: null, term: s };
}