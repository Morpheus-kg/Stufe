// Аутентификация: HMAC cookie `sid` v2 + мультипользователи через таблицу users
// A1: токен v2, кэш 30 сек, requireAdmin по свежей роли, scrypt async
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'sid';
export const SESSION_MS = 30 * 24 * 3600 * 1000;

const scryptAsync = promisify(crypto.scrypt);

// --- Хеширование паролей (scrypt async) ---

/** Хешировать пароль: возвращает '<salt_hex>:<hash_hex>' */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

/** Проверить пароль против хранимого хеша. Всегда async, timing-safe. */
export async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) {
    // Нет хеша: выполняем dummy scrypt чтобы время было одинаковым
    await scryptAsync(password, crypto.randomBytes(16).toString('hex'), 64);
    return false;
  }
  try {
    const derived = await scryptAsync(password, salt, 64);
    const a = Buffer.from(derived.toString('hex'));
    const b = Buffer.from(hash);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Dummy-хеш для защиты от timing-атак при неизвестном username
const DUMMY_HASH = await hashPassword('dummy_password_for_timing');

/** Выполнить dummy verify (одинаковое время при unknown user) */
export async function dummyVerify() {
  await verifyPassword('wrong_password', DUMMY_HASH);
}

// --- HMAC подпись ---

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

// --- Токен v2: v2.<expMs>.<nonce>.<userId>.<tokenVersion>.<hmac> ---

export function issueToken(nowOrUser = Date.now(), userIdOrVersion = null, tokenVersion = 0) {
  let now = Date.now();
  let uid = null;
  let ver = 0;
  if (typeof nowOrUser === 'object' && nowOrUser !== null) {
    uid = nowOrUser.id;
    ver = typeof userIdOrVersion === 'number' ? userIdOrVersion : (nowOrUser.token_version || 0);
  } else if (typeof nowOrUser === 'number') {
    if (nowOrUser > 1e11) {
      now = nowOrUser;
      uid = userIdOrVersion;
      ver = tokenVersion || 0;
    } else {
      uid = nowOrUser;
      ver = typeof userIdOrVersion === 'number' ? userIdOrVersion : (tokenVersion || 0);
    }
  }
  const payload = `v2.${now + SESSION_MS}.${crypto.randomBytes(8).toString('base64url')}.${uid || 0}.${ver}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const parts = payload.split('.');
  // v2.<expMs>.<nonce>.<userId>.<tokenVersion>
  if (parts[0] !== 'v2') return false;
  return Number.isFinite(Number(parts[1])) && Number(parts[1]) > now;
}

/** Извлечь userId и tokenVersion из токена v2 */
export function tokenClaims(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const parts = token.slice(0, i).split('.');
  // v2.<exp>.<nonce>.<userId>.<tokenVersion>
  if (parts[0] !== 'v2' || parts.length < 5) return null;
  const userId = Number(parts[3]);
  const tokenVersion = Number(parts[4]);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return { userId, tokenVersion };
}

export function setSessionCookie(res, userId, tokenVersion = 0) {
  res.cookie(SESSION_COOKIE, issueToken(Date.now(), userId, tokenVersion), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: SESSION_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' });
}

// --- Кэш пользователей (30 секунд, in-process) ---

const userCache = new Map(); // userId -> { user, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

export function invalidateUserCache(userId) {
  if (userId) userCache.delete(userId);
}

export function invalidateAllUserCache() {
  userCache.clear();
}

let testUserGetter = null;
export function __setUserGetter(fn) {
  testUserGetter = fn;
}

async function loadUser(userId) {
  if (testUserGetter) return testUserGetter(userId);
  const now = Date.now();
  const cached = userCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.user;

  // Ленивый импорт db чтобы не было циклических зависимостей
  const { query } = await import('./db.js');
  const rows = await query(
    'SELECT id, username, role, must_change_password, token_version, disabled, ai_mode FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  const user = rows.length ? rows[0] : null;
  if (user) {
    userCache.set(userId, { user, expiresAt: now + CACHE_TTL_MS });
  } else {
    userCache.delete(userId);
  }
  return user;
}

// Rate limiters (в памяти, сбрасываются при перезапуске)
const ipMap = new Map();   // ip  -> { count, resetAt }
const usrMap = new Map();  // username -> { count, resetAt }

export const ipLimiter = {
  check: (ip) => !checkRateLimit(ipMap, ip, IP_MAX),
  reset: () => ipMap.clear(),
};

export const userLimiter = {
  check: (username) => !checkRateLimit(usrMap, (username || '').toLowerCase(), USR_MAX),
  reset: () => usrMap.clear(),
};

const IP_MAX = 20;
const USR_MAX = 8;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(limiters, key, max) {
  const now = Date.now();
  let entry = limiters.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    limiters.set(key, entry);
  }
  entry.count += 1;
  return entry.count > max;
}

/** Проверить лимиты для IP и username. Бросает ApiError при превышении. */
export function checkLoginRateLimits(ip, username) {
  const ipBlocked = checkRateLimit(ipMap, ip, IP_MAX);
  const usrBlocked = username ? checkRateLimit(usrMap, username.toLowerCase(), USR_MAX) : false;
  if (ipBlocked || usrBlocked) {
    throw new ApiError(429, 'RATE_LIMITED', 'Слишком много попыток входа. Попробуйте через 15 минут.');
  }
}

/** Сбросить счётчики для IP и username после успешного входа */
export function resetLoginRateLimits(ip, username) {
  ipMap.delete(ip);
  if (username) usrMap.delete(username.toLowerCase());
}

export function extractToken(req) {
  if (!req) return null;
  if (req.cookies?.[SESSION_COOKIE]) return req.cookies[SESSION_COOKIE];
  if (req.cookies?.gt_session) return req.cookies.gt_session;
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

// --- Middleware ---

/** Middleware: нет валидного токена v2 -> 401 */
export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!verifyToken(token)) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Необходима авторизация'));
    }
    const claims = tokenClaims(token);
    if (!claims) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Необходима авторизация'));
    }
    const user = await loadUser(claims.userId);
    if (!user) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Пользователь не найден'));
    }
    if (user.disabled) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Аккаунт отключён'));
    }
    if (Number(user.token_version) !== claims.tokenVersion) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Сессия устарела, войдите снова'));
    }
    req.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password,
      ai_mode: user.ai_mode,
    };
    // Обновляем last_active_day раз в день (без ожидания)
    updateLastActive(user.id).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
}

async function updateLastActive(userId) {
  try {
    const { query } = await import('./db.js');
    const { localDay } = await import('./time.js');
    const today = localDay(new Date());
    await query(
      'UPDATE users SET last_active_day = ? WHERE id = ? AND (last_active_day IS NULL OR last_active_day < ?)',
      [today, userId, today],
    );
  } catch { /* не критично */ }
}

/** Middleware: только admin (по свежей роли из БД) */
/** Middleware: только администратор (проверяет свежую роль из БД) */
export async function requireAdmin(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'UNAUTHORIZED', 'Необходима авторизация'));
  try {
    const { query } = await import('./db.js');
    const rows = await query('SELECT role, disabled FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const u = rows?.[0];
    if (!u || u.disabled || u.role !== 'admin') {
      if (req.user.id) invalidateUserCache(req.user.id);
      return next(new ApiError(403, 'FORBIDDEN', 'Только для администратора'));
    }
    req.user.role = u.role;
    next();
  } catch (err) {
    next(err);
  }
}

/** Middleware: блокировать все /api/* кроме /api/auth/* и /api/me при must_change_password */
export function requirePasswordChanged(req, res, next) {
  if (!req.user) return next();
  if (req.user.must_change_password) {
    const url = req.path || '';
    // Разрешаем: /api/auth/* и /api/me (GET) и /api/me/password (PUT)
    if (url.startsWith('/auth/') || url === '/me' || url === '/me/password') return next();
    return next(new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Смените пароль перед продолжением'));
  }
  next();
}

/** Валидация username: ^[a-z0-9][a-z0-9_.-]{2,31}$ (ввод в нижнем регистре) */
export function validateUsername(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.toLowerCase().trim();
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(u) ? u : null;
}

/** Валидация пароля: 8..128 символов */
export function validatePassword(raw) {
  if (typeof raw !== 'string') return false;
  return raw.length >= 8 && raw.length <= 128;
}

/** Генерировать временный пароль: 12 символов из неоднозначного алфавита */
export function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
