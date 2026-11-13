// /api/auth: вход, выход, /api/me, /api/me/password
// A1: только username+password, одинаковое время/сообщение при ошибке
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../errors.js';
import { ApiError } from '../errors.js';
import {
  clearSessionCookie,
  setSessionCookie,
  requireAuth,
  requirePasswordChanged,
  hashPassword,
  verifyPassword,
  dummyVerify,
  checkLoginRateLimits,
  resetLoginRateLimits,
  validateUsername,
  validatePassword,
  invalidateUserCache,
} from '../auth.js';
import { query } from '../db.js';

export const mountPath = '/api/auth';
const router = Router();
export default router;

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(128),
});

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { username: rawUsername, password } = validate(loginSchema, req.body, 'Неверный формат');
  const ip = req.ip || 'unknown';
  const username = validateUsername(rawUsername);

  // Проверяем rate limit ДО запроса в БД
  checkLoginRateLimits(ip, username || rawUsername);

  if (!username) {
    // Неверный формат username — делаем dummy verify для одинакового времени
    await dummyVerify();
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
  }

  const rows = await query(
    'SELECT id, username, role, password_hash, must_change_password, token_version, disabled, ai_mode FROM users WHERE username = ? LIMIT 1',
    [username],
  );

  if (!rows.length) {
    await dummyVerify();
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
  }

  const user = rows[0];
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
  }

  if (user.disabled) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Аккаунт отключён');
  }

  // Сброс лимита после успешного входа
  resetLoginRateLimits(ip, username);

  // Обновить last_login_at
  await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  invalidateUserCache(user.id);

  setSessionCookie(res, user.id, Number(user.token_version));
  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    must_change_password: !!user.must_change_password,
    ai_mode: user.ai_mode,
  });
}));

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

// GET /api/me — профиль текущего пользователя
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = req.user;
  // Ключи AI
  const keyRows = await query('SELECT provider FROM user_keys WHERE user_id = ?', [user.id]);
  const keys = { groq: false, gemini: false, openrouter: false };
  for (const r of keyRows) {
    if (r.provider in keys) keys[r.provider] = true;
  }
  const rows = await query('SELECT created_at FROM users WHERE id = ? LIMIT 1', [user.id]);
  res.json({
    id: user.id,
    username: user.username,
    role: user.role,
    must_change_password: user.must_change_password,
    ai_mode: user.ai_mode,
    keys,
    created_at: rows[0]?.created_at ?? null,
  });
}));

// PUT /api/me/password — смена пароля
router.put('/me/password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password } = validate(changePasswordSchema, req.body, 'Неверный формат');

  if (!validatePassword(new_password)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Пароль должен быть от 8 до 128 символов');
  }

  const rows = await query('SELECT id, password_hash, token_version FROM users WHERE id = ? LIMIT 1', [req.user.id]);
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
    [newHash, newVersion, user.id],
  );
  invalidateUserCache(user.id);

  // Выдать новый cookie для текущей сессии
  setSessionCookie(res, user.id, newVersion);
  res.status(204).end();
}));

// Экспортируем requirePasswordChanged для использования в index.js
export { requirePasswordChanged };
