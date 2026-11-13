// Клиент API контракта v3 (CONTRACT v3, A7)
// Никогда не повторяет упавший запрос в бесконечном цикле

import { ApiError } from './api.js';

async function req(method, path, body = undefined) {
  const url = '/api' + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Нет соединения с сервером');
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = data?.error || {};
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      if (location.hash !== '#/login') location.hash = '#/login';
    } else if (res.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') {
      if (location.hash !== '#/change-password') location.hash = '#/change-password';
    }
    throw new ApiError(
      res.status,
      err.code || (res.status === 401 ? 'UNAUTHORIZED' : 'ERROR'),
      err.message || 'Ошибка сервера',
      data,
    );
  }
  return data;
}

// ---------- Профиль и личные ключи ----------
export const me = () => req('GET', '/me');

export const changePassword = (current_password, new_password) =>
  req('PUT', '/me/password', { current_password, new_password });

export const getKeys = () => req('GET', '/me/keys');

export const putKey = (provider, key) => req('PUT', '/me/keys', { provider, key });

export const deleteKey = (provider) => req('DELETE', `/me/keys/${encodeURIComponent(provider)}`);

export const starterDeck = () => req('POST', '/me/starter-deck');

// ---------- Администратор ----------
export const adminUsers = () => req('GET', '/admin/users');

export const adminCreateUser = ({ username, role, password }) =>
  req('POST', '/admin/users', { username, role, password });

export const adminUpdateUser = (id, updates) => req('PUT', `/admin/users/${id}`, updates);

export const adminDeleteUser = (id, confirm_username) =>
  req('DELETE', `/admin/users/${id}`, { confirm_username });

export const adminUsage = () => req('GET', '/admin/usage');

