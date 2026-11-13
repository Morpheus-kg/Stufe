// /api/admin: управление пользователями и использование ИИ (CONTRACT v3, A6)
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../errors.js';
import { query, tx } from '../db.js';
import {
  requireAdmin,
  hashPassword,
  generateTempPassword,
  validateUsername,
  validatePassword,
  invalidateUserCache,
} from '../auth.js';

export const mountPath = '/api/admin';
const router = Router();
export default router;

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32),
  role: z.enum(['admin', 'user']).default('user'),
  password: z.string().min(8).max(200).optional(),
});

const updateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  disabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  ai_mode: z.enum(['shared', 'own', 'off']).optional(),
  reset_password: z.boolean().optional(),
});

const deleteUserSchema = z.object({
  confirm_username: z.string().trim().min(1),
});

// ---------- GET /api/admin/users ----------
// Список пользователей со статистикой (только счётчики, никогда контент)
router.get(
  '/users',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const userList = await query(
      'SELECT id, username, role, disabled, ai_mode, created_at, last_login_at FROM users ORDER BY id /* admin-scope */',
    );
    const items = await Promise.all(
      (userList || []).map(async (u) => {
        const [cardsRes, reviewsRes, aiRes, activeDayRes] = await Promise.all([
          query('SELECT COUNT(*) AS c FROM cards WHERE user_id = ? AND active = 1', [u.id]),
          query(
            'SELECT COUNT(*) AS c FROM review_log WHERE user_id = ? AND answered_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)',
            [u.id],
          ),
          query(
            'SELECT COALESCE(SUM(calls), 0) AS c FROM ai_usage WHERE user_id = ? AND day = UTC_DATE()',
            [u.id],
          ),
          query('SELECT MAX(day) AS d FROM daily_stats WHERE user_id = ?', [u.id]),
        ]);
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          disabled: Number(u.disabled) || 0,
          ai_mode: u.ai_mode,
          created_at: u.created_at,
          last_login_at: u.last_login_at || null,
          last_active_day: activeDayRes?.[0]?.d || null,
          cards: Number(cardsRes?.[0]?.c) || 0,
          reviews_7d: Number(reviewsRes?.[0]?.c) || 0,
          ai_calls_today: Number(aiRes?.[0]?.c) || 0,
        };
      }),
    );
    res.json({ users: items, items });
  }),
);

// ---------- POST /api/admin/users ----------
// Создать пользователя с временным паролем
router.post(
  '/users',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'BAD_REQUEST', 'Некорректные параметры пользователя.');
    }
    const data = parsed.data;
    if (!validateUsername(data.username)) {
      throw new ApiError(400, 'INVALID_USERNAME', 'Имя пользователя должно быть от 3 до 32 символов (буквы, цифры, _, -).');
    }

    let tempPassword = null;
    let pwdToHash = data.password;
    if (!pwdToHash) {
      tempPassword = generateTempPassword();
      pwdToHash = tempPassword;
    } else if (!validatePassword(pwdToHash)) {
      throw new ApiError(400, 'INVALID_PASSWORD', 'Пароль должен быть не менее 8 символов.');
    }

    const hash = await hashPassword(pwdToHash);
    try {
      const result = await query(
        'INSERT INTO users (username, role, password_hash, must_change_password, created_at) ' +
          'VALUES (?, ?, ?, 1, UTC_TIMESTAMP()) /* admin-scope */',
        [data.username, data.role, hash],
      );
      res.status(201).json({
        user: {
          id: result.insertId,
          username: data.username,
          role: data.role,
          disabled: 0,
          ai_mode: 'shared',
          must_change_password: 1,
        },
        temp_password: tempPassword,
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        throw new ApiError(409, 'CONFLICT', 'Пользователь с таким именем уже существует.');
      }
      throw e;
    }
  }),
);

// ---------- PUT /api/admin/users/:id ----------
// Обновление роли, статуса, ai_mode, сброс пароля
router.put(
  '/users/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      throw new ApiError(400, 'BAD_REQUEST', 'Неверный идентификатор пользователя.');
    }
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'BAD_REQUEST', 'Некорректные параметры запроса.');
    }
    const data = parsed.data;

    const rows = await query('SELECT id, username, role, disabled, ai_mode FROM users WHERE id = ? /* admin-scope */', [id]);
    const target = rows?.[0];
    if (!target) {
      throw new ApiError(404, 'NOT_FOUND', 'Пользователь не найден.');
    }

    // Защита: нельзя отключить или разжаловать самого себя
    const isSelf = req.user.id === target.id;
    if (isSelf) {
      if (data.disabled) {
        throw new ApiError(400, 'FORBIDDEN', 'Администратор не может отключить сам себя.');
      }
      if (data.role && data.role !== 'admin') {
        throw new ApiError(400, 'FORBIDDEN', 'Администратор не может разжаловать сам себя.');
      }
    }

    // Защита: нельзя отключить или разжаловать последнего активного администратора
    const isDemotingOrDisablingAdmin =
      target.role === 'admin' &&
      target.disabled === 0 &&
      ((data.role && data.role !== 'admin') || (data.disabled !== undefined && Boolean(data.disabled)));

    if (isDemotingOrDisablingAdmin) {
      const adminCountRes = await query(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 /* admin-scope */",
      );
      if (Number(adminCountRes?.[0]?.c) <= 1) {
        throw new ApiError(409, 'CONFLICT', 'Нельзя отключить или разжаловать последнего активного администратора.');
      }
    }

    const sets = [];
    const params = [];
    let tempPassword = null;
    let bumpToken = false;

    if (data.role !== undefined) {
      sets.push('role = ?');
      params.push(data.role);
      bumpToken = true;
    }
    if (data.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(data.disabled ? 1 : 0);
      bumpToken = true;
    }
    if (data.ai_mode !== undefined) {
      sets.push('ai_mode = ?');
      params.push(data.ai_mode);
    }
    if (data.reset_password === true) {
      tempPassword = generateTempPassword();
      const hash = await hashPassword(tempPassword);
      sets.push('password_hash = ?', 'must_change_password = 1');
      params.push(hash);
      bumpToken = true;
    }

    if (!sets.length) {
      throw new ApiError(400, 'BAD_REQUEST', 'Нет полей для обновления.');
    }

    if (bumpToken) {
      sets.push('token_version = token_version + 1');
    }
    params.push(id);

    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? /* admin-scope */`, params);
    invalidateUserCache(id);

    const updatedRows = await query(
      'SELECT id, username, role, disabled, ai_mode, must_change_password FROM users WHERE id = ? /* admin-scope */',
      [id],
    );
    const updated = updatedRows?.[0] || {};
    res.json({
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        disabled: Number(updated.disabled) || 0,
        ai_mode: updated.ai_mode,
        must_change_password: updated.must_change_password,
      },
      temp_password: tempPassword,
    });
  }),
);

// ---------- DELETE /api/admin/users/:id ----------
// Удаление пользователя и всех связанных данных в транзакции
router.delete(
  '/users/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      throw new ApiError(400, 'BAD_REQUEST', 'Неверный идентификатор пользователя.');
    }

    const parsed = deleteUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'BAD_REQUEST', 'Требуется подтверждение именем пользователя (confirm_username).');
    }
    const { confirm_username } = parsed.data;

    const rows = await query('SELECT id, username, role, disabled FROM users WHERE id = ? /* admin-scope */', [id]);
    const target = rows?.[0];
    if (!target) {
      throw new ApiError(404, 'NOT_FOUND', 'Пользователь не найден.');
    }

    if (confirm_username !== target.username) {
      throw new ApiError(400, 'CONFIRMATION_MISMATCH', 'Введённое имя пользователя не совпадает с удаляемым.');
    }

    // Защита: нельзя удалить самого себя
    if (req.user.id === target.id) {
      throw new ApiError(400, 'FORBIDDEN', 'Администратор не может удалить сам себя.');
    }

    // Защита: нельзя удалить последнего активного администратора
    if (target.role === 'admin' && target.disabled === 0) {
      const adminCountRes = await query(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 /* admin-scope */",
      );
      if (Number(adminCountRes?.[0]?.c) <= 1) {
        throw new ApiError(409, 'CONFLICT', 'Нельзя удалить последнего активного администратора.');
      }
    }

    const deleted = {};
    const tables = [
      'card_state',
      'review_log',
      'sentences',
      'staging_cards',
      'settings',
      'daily_stats',
      'import_runs',
      'texts',
      'text_attempts',
      'translation_sets',
      'writing_tasks',
      'writing_attempts',
      'speaking_attempts',
      'number_attempts',
      'exam_log',
      'activities',
      'ai_usage',
      'user_keys',
      'cards',
    ];

    await tx(async (conn) => {
      for (const tbl of tables) {
        const [r] = await conn.query(`DELETE FROM ${tbl} WHERE user_id = ?`, [id]);
        deleted[tbl] = r.affectedRows;
      }
      const [uRes] = await conn.query('DELETE FROM users WHERE id = ? /* admin-scope */', [id]);
      deleted.users = uRes.affectedRows;
    });

    invalidateUserCache(id);
    res.json({ deleted });
  }),
);

// ---------- GET /api/admin/usage ----------
// Использование ИИ сегодня и за последние 7 дней с разбивкой по пользователям
router.get(
  '/usage',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await query(
      'SELECT u.id AS user_id, u.username, a.day, a.feature, a.calls, a.failures ' +
        'FROM ai_usage a JOIN users u ON u.id = a.user_id ' +
        'WHERE a.day >= (UTC_DATE() - INTERVAL 7 DAY) ' +
        'ORDER BY a.day DESC, u.username, a.feature /* admin-scope */',
    );
    const todayRows = await query(
      'SELECT feature, SUM(calls) AS calls, SUM(failures) AS failures ' +
        'FROM ai_usage WHERE day = UTC_DATE() ' +
        'GROUP BY feature /* admin-scope */',
    );
    const { capFor, globalCapFor } = await import('../ai/llm.js');
    const totals = {};
    const caps = {};
    const global_caps = {};
    for (const f of ['correct', 'generate', 'enrich', 'text', 'translate', 'speak', 'write', 'lookup']) {
      totals[f] = { calls: 0, failures: 0 };
      caps[f] = capFor(f);
      global_caps[f] = globalCapFor(f);
    }
    for (const r of todayRows || []) {
      if (totals[r.feature]) {
        totals[r.feature] = { calls: Number(r.calls) || 0, failures: Number(r.failures) || 0 };
      }
    }
    res.json({
      usage_7d: rows || [],
      today_totals: totals,
      caps,
      global_caps,
    });
  }),
);
