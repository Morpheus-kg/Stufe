// Профиль типичных грамматических ошибок пользователя (M8c, Satzbau / Translate integration)
import { query } from './db.js';
import { ERROR_CATEGORIES } from '../shared/constants.js';

const ALIASES = {
  rektion: 'praeposition',
  preposition: 'praeposition',
  case: 'kasus',
  word_order: 'wortstellung',
  artikel: 'artikel',
  article: 'artikel',
  article_gender: 'artikel',
  article_declension: 'artikel',
  conjugation: 'konjugation',
  verb_form: 'konjugation',
  verb_tense: 'konjugation',
  spelling: 'rechtschreibung',
  vocabulary: 'wortschatz',
};

/**
 * Записывает ошибки пользователя в user_error_profile.
 * @param {number} userId
 * @param {Array<{category?: string, original?: string, fix?: string, explanation_ru?: string}>} errors
 * @param {Function} [db]
 */
export async function recordUserErrors(userId, errors, db = query) {
  if (!userId || !Array.isArray(errors) || !errors.length) return;
  for (const err of errors) {
    if (!err || typeof err !== 'object') continue;
    const rawCat = String(err.category || '').trim().toLowerCase();
    const mapped = ALIASES[rawCat] || rawCat;
    const category = ERROR_CATEGORIES.includes(mapped) ? mapped : 'sonstiges';
    const original = String(err.original || '').trim();
    const fix = String(err.fix || '').trim();
    const example = original && fix
      ? `${original} -> ${fix}`.slice(0, 500)
      : (fix || original || String(err.explanation_ru || '')).slice(0, 500) || null;

    try {
      await db(
        `INSERT INTO user_error_profile (user_id, category, hits, last_example)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE hits = hits + 1, last_example = COALESCE(VALUES(last_example), last_example)`,
        [userId, category, example],
      );
    } catch {
      // Игнорируем ошибки при отсутствии таблицы в изолированных тестах
    }
  }
}

/**
 * Возвращает топ грамматических категорий с наибольшим числом ошибок у пользователя.
 * @param {number} userId
 * @param {number} limit
 * @param {Function} [db]
 * @returns {Promise<Array<{category: string, hits: number, last_example: string|null}>>}
 */
export async function getUserTopErrors(userId, limit = 4, db = query) {
  if (!userId) return [];
  try {
    const rows = await db(
      'SELECT category, hits, last_example FROM user_error_profile WHERE user_id = ? ORDER BY hits DESC, updated_at DESC LIMIT ?',
      [userId, limit],
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
