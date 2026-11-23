// Общая вставка карточек (генерация слов, словарь, ошибки, анализ текста): дедупликация по dedupe_key, пользователь всегда явный
import { tx } from './db.js';
import { normalizeKey } from './keys.js';
import { makeCloze, enrichCards } from './ai/enrich.js';

const hasText = (v) => typeof v === 'string' && v.trim() !== '';
const COLS = ['term', 'article', 'plural', 'pos', 'translation', 'grammar', 'example', 'example_translation',
  'example_cloze', 'cloze_answer', 'level', 'topic', 'source', 'source_batch', 'check_flag', 'enriched', 'active', 'dedupe_key'];

/** Элемент (формат staging/lookup) -> строка для cards или null, если непригоден */
export function prepareItem(raw, { source = null, batchId = null } = {}) {
  if (!raw || !hasText(raw.term) || !hasText(raw.translation)) return null;
  const article = ['der', 'die', 'das'].includes(raw.article) ? raw.article : null;
  const term = raw.term.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 255);
  const key = normalizeKey(article, term);
  if (!key) return null;
  const pos = article ? 'noun' : (raw.pos || 'phrase');
  let cloze = hasText(raw.example_cloze) && hasText(raw.cloze_answer)
    ? { example_cloze: raw.example_cloze, cloze_answer: raw.cloze_answer } : null;
  if (!cloze && hasText(raw.example)) cloze = makeCloze(raw.example, term);
  const grammar = hasText(raw.grammar) ? raw.grammar : null;
  const plural = hasText(raw.plural) ? raw.plural : null;
  const enriched = grammar && cloze && (pos !== 'noun' || (article && plural)) ? 1 : 0;
  return {
    term, article, plural, pos,
    translation: raw.translation.trim().slice(0, 500),
    grammar,
    example: hasText(raw.example) ? raw.example : null,
    example_translation: hasText(raw.example_translation) ? raw.example_translation : null,
    example_cloze: cloze ? cloze.example_cloze : null,
    cloze_answer: cloze ? cloze.cloze_answer : null,
    level: raw.level || 'B2',
    topic: raw.topic || 'Sonstiges',
    source: source ? String(source).slice(0, 255) : null,
    source_batch: batchId ? String(batchId).slice(0, 36) : null,
    check_flag: raw.check_flag ? 1 : 0,
    enriched,
    active: 1,
    dedupe_key: key,
  };
}

/**
 * Добавляет карточки пользователя напрямую в cards.
 * Дубль активной карточки пропускается; мягко удалённая (active=0) восстанавливается.
 * @returns {Promise<{added: object[], restored: number, duplicates: number, skipped: number}>}
 */
export async function upsertCards(items, userId, opts = {}) {
  if (!Number.isInteger(userId)) throw new Error('upsertCards: userId обязателен');
  const prepared = [];
  const seen = new Set();
  let skipped = 0;
  let duplicates = 0;
  for (const raw of items || []) {
    const c = prepareItem(raw, opts);
    if (!c) { skipped += 1; continue; }
    if (seen.has(c.dedupe_key)) { duplicates += 1; continue; }
    seen.add(c.dedupe_key);
    prepared.push(c);
  }
  const out = { added: [], restored: 0, duplicates, skipped };
  if (!prepared.length) return out;

  const ids = await tx(async (conn) => {
    const [rows] = await conn.query(
      'SELECT id, active, dedupe_key FROM cards WHERE user_id = ? AND dedupe_key IN (?)',
      [userId, prepared.map((c) => c.dedupe_key)],
    );
    const byKey = new Map(rows.map((r) => [r.dedupe_key, r]));
    const newIds = [];
    for (const c of prepared) {
      const hit = byKey.get(c.dedupe_key);
      if (hit && hit.active) { out.duplicates += 1; continue; }
      if (hit) {
        await conn.query(
          `UPDATE cards SET ${COLS.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
          [...COLS.map((k) => c[k]), hit.id, userId],
        );
        out.restored += 1;
        newIds.push(hit.id);
        continue;
      }
      const [ins] = await conn.query(
        `INSERT INTO cards (user_id, ${COLS.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${COLS.map(() => '?').join(', ')})`,
        [userId, ...COLS.map((k) => c[k])],
      );
      newIds.push(ins.insertId);
    }
    if (!newIds.length) return [];
    const [cards] = await conn.query('SELECT * FROM cards WHERE user_id = ? AND id IN (?) ORDER BY id', [userId, newIds]);
    out.added = cards;
    return newIds;
  });

  if (ids.length && out.added.some((c) => !c.enriched)) scheduleEnrich(userId);
  return out;
}

const pending = new Map();
/** Фоновое обогащение с объединением частых вызовов (debounce 2 с на пользователя). */
export function scheduleEnrich(userId, limit = 25) {
  if (!Number.isInteger(userId) || pending.has(userId)) return;
  const t = setTimeout(() => {
    pending.delete(userId);
    enrichCards(limit, userId).catch(() => {});
  }, 2000);
  t.unref?.();
  pending.set(userId, t);
}

