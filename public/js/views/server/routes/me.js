// /api/me: профиль, смена пароля, персональные ключи ИИ, стартовый набор (CONTRACT v3, A1, A5, A6)
import { Router } from 'express';
import { z } from 'zod';
import { query, tx, pool } from '../db.js';
import { ApiError, asyncHandler, validate } from '../errors.js';
import {
  requireAuth,
  hashPassword,
  verifyPassword,
  validatePassword,
  invalidateUserCache,
  setSessionCookie,
} from '../auth.js';
import { hasValidKeysSecret, encryptKey } from '../crypto_keys.js';

export const mountPath = '/api';
const router = Router();
export default router;

const PROVIDERS = ['groq', 'gemini', 'openrouter'];

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(128),
});

const putKeySchema = z.object({
  provider: z.enum(['groq', 'gemini', 'openrouter']),
  key: z.string().min(8).max(200),
});

function assertKeysSecret() {
  if (!hasValidKeysSecret()) {
    throw new ApiError(501, 'NOT_IMPLEMENTED', 'Шифрование персональных ключей не настроено на сервере (отсутствует KEYS_SECRET).');
  }
}

// GET /api/me -> {id, username, role, must_change_password, ai_mode, keys:{groq,gemini,openrouter}, created_at}
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const [userRows, keyRows] = await Promise.all([
    query('SELECT id, username, role, must_change_password, ai_mode, created_at FROM users WHERE id = ? LIMIT 1', [userId]),
    query('SELECT provider FROM user_keys WHERE user_id = ?', [userId]),
  ]);
  const user = userRows[0];
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'Пользователь не найден');

  const keys = { groq: false, gemini: false, openrouter: false };
  for (const r of keyRows) {
    if (r.provider in keys) keys[r.provider] = true;
  }

  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    must_change_password: !!user.must_change_password,
    ai_mode: user.ai_mode,
    keys,
    created_at: user.created_at ?? null,
  });
}));

// PUT / POST /api/me/password {current_password, new_password} -> 204
const changePasswordHandler = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { current_password, new_password } = validate(changePasswordSchema, req.body, 'Неверный формат');

  if (!validatePassword(new_password)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Пароль должен быть от 8 до 128 символов');
  }

  const rows = await query('SELECT id, password_hash, token_version FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', 'Пользователь не найден');
  const user = rows[0];

  const ok = await verifyPassword(current_password, user.password_hash);
  if (!ok) {
    throw new ApiError(400, 'BAD_REQUEST', 'Неверный текущий пароль');
  }

  const newHash = await hashPassword(new_password);
  const newVersion = (Number(user.token_version) + 1) % 2147483647;

  await query(
    'UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ? WHERE id = ?',
    [newHash, newVersion, userId],
  );
  invalidateUserCache(userId);

  setSessionCookie(res, userId, newVersion);
  res.status(204).end();
});

router.put('/me/password', requireAuth, changePasswordHandler);
router.post('/me/password', requireAuth, changePasswordHandler);

// GET /api/me/keys -> {groq:bool, gemini:bool, openrouter:bool}
router.get('/me/keys', requireAuth, asyncHandler(async (req, res) => {
  assertKeysSecret();
  const rows = await query('SELECT provider FROM user_keys WHERE user_id = ?', [req.user.id]);
  const keys = { groq: false, gemini: false, openrouter: false };
  for (const r of rows) {
    if (r.provider in keys) keys[r.provider] = true;
  }
  res.json(keys);
}));

// PUT /api/me/keys {provider:'groq'|'gemini'|'openrouter', key(8..200)} -> 204
router.put('/me/keys', requireAuth, asyncHandler(async (req, res) => {
  assertKeysSecret();
  const userId = req.user.id;
  const { provider, key } = validate(putKeySchema, req.body, 'Некорректный ключ или провайдер');

  const { ciphertext, iv, tag } = encryptKey(key);

  await query(
    'INSERT INTO user_keys (user_id, provider, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP()) '
    + 'ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), iv = VALUES(iv), tag = VALUES(tag), updated_at = UTC_TIMESTAMP()',
    [userId, provider, ciphertext, iv, tag],
  );

  res.status(204).end();
}));

// DELETE /api/me/keys/:provider -> 204
router.delete('/me/keys/:provider', requireAuth, asyncHandler(async (req, res) => {
  assertKeysSecret();
  const userId = req.user.id;
  const provider = String(req.params.provider).toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Неизвестный провайдер');
  }

  await query('DELETE FROM user_keys WHERE user_id = ? AND provider = ?', [userId, provider]);
  res.status(204).end();
}));

// POST /api/me/starter-deck -> {copied, skipped}
router.post('/me/starter-deck', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Найти starter user: env STARTER_USER или первый админ
  let starterUserId = null;
  const starterEnv = (process.env.STARTER_USER || '').trim().toLowerCase();
  if (starterEnv) {
    const sRows = await query('SELECT id FROM users WHERE username = ? LIMIT 1', [starterEnv]);
    if (sRows.length) starterUserId = sRows[0].id;
  }
  if (!starterUserId) {
    const aRows = await query("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
    if (aRows.length) starterUserId = aRows[0].id;
  }

  if (!starterUserId || starterUserId === userId) {
    return res.json({ copied: 0, skipped: 0 });
  }

  // Загрузить активные карточки starter user
  const sourceCards = await query(
    'SELECT term, article, plural, pos, translation, grammar, example, example_translation, '
    + 'example_cloze, cloze_answer, level, topic, source, check_flag, enriched, dedupe_key '
    + 'FROM cards WHERE user_id = ? AND active = 1',
    [starterUserId],
  );

  if (!sourceCards.length) {
    return res.json({ copied: 0, skipped: 0 });
  }

  // Найти существующие dedupe_key у текущего пользователя
  const existingRows = await query('SELECT dedupe_key FROM cards WHERE user_id = ?', [userId]);
  const existingKeys = new Set(existingRows.map((r) => r.dedupe_key));

  const fresh = [];
  let skipped = 0;
  for (const c of sourceCards) {
    if (existingKeys.has(c.dedupe_key)) {
      skipped += 1;
    } else {
      existingKeys.add(c.dedupe_key);
      fresh.push(c);
    }
  }

  const COLS = ['term', 'article', 'plural', 'pos', 'translation', 'grammar', 'example', 'example_translation',
    'example_cloze', 'cloze_answer', 'level', 'topic', 'source', 'check_flag', 'enriched', 'dedupe_key'];

  if (fresh.length) {
    for (let i = 0; i < fresh.length; i += 500) {
      const chunk = fresh.slice(i, i + 500).map((c) => [userId, ...COLS.map((k) => c[k])]);
      await pool.query(
        `INSERT INTO cards (user_id, ${COLS.join(', ')}) VALUES ?`,
        [chunk],
      );
    }
  }

  res.json({ copied: fresh.length, skipped });
}));

