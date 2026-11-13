// /api/admin: панель администратора (CONTRACT v3, A7)
import { adminUsers, adminCreateUser, adminUpdateUser, adminDeleteUser, adminUsage } from '../api3.js';

const STYLE_ID = 'gt-admin-style';
const CSS = `
.gt-adm { padding: 4px 0 32px; display: flex; flex-direction: column; gap: 16px; }
.gt-adm h1 { font-size: 1.5rem; margin: 0 0 16px; }
.gt-adm-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; display: flex; flex-direction: column; gap: 12px;
}
.gt-adm-card h2 { font-size: 1.15rem; margin: 0; }
.gt-adm-user-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.gt-adm-user {
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border);
  border-radius: 8px; background: var(--surface-2, var(--surface));
}
.gt-adm-user-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.gt-adm-user-name { font-weight: 600; font-size: 1rem; }
.gt-adm-stats { font-size: 0.85rem; color: var(--text-2, var(--muted)); display: flex; flex-wrap: wrap; gap: 12px; }
.gt-adm-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 4px; }
.gt-adm-field { display: flex; flex-direction: column; gap: 4px; }
.gt-adm-field label { font-size: 0.85rem; color: var(--text-2, var(--muted)); }
.gt-adm-field input, .gt-adm-field select {
  min-height: var(--tap);
  padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--surface); color: inherit; font: inherit;
}
.gt-adm-btn {
  min-height: var(--tap);
  padding: 8px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong);
  background: var(--surface); color: inherit; cursor: pointer; font: inherit; font-size: var(--fs-sm);
  display: inline-flex; align-items: center; justify-content: center;
}
.gt-adm-btn.primary { background: var(--primary); color: var(--on-primary, #fff); border-color: var(--primary); font-weight: 600; }
.gt-adm-btn.danger { color: var(--danger); border-color: var(--danger); }
.gt-adm-btn.small { min-height: 36px; padding: 4px 10px; font-size: var(--fs-xs); }
.gt-adm-badge {
  font-size: var(--fs-xs); padding: 2px 6px; border-radius: var(--radius-pill);
  background: var(--surface-2); border: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.05em;
}
.gt-adm-badge.admin { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.gt-adm-badge.disabled { background: var(--danger-soft); color: var(--danger); border-color: transparent; }
.gt-adm-msg { font-size: var(--fs-sm); margin-top: 4px; }
.gt-adm-msg.ok { color: var(--success); }
.gt-adm-msg.err { color: var(--danger); font-weight: 600; }
.gt-adm-temp-pwd {
  padding: 10px; background: var(--warn-soft); border: 1px dashed var(--warn);
  border-radius: var(--radius-sm); display: flex; justify-content: space-between; align-items: center; font-family: monospace;
}
.gt-adm-usage-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); margin-top: 8px; }
.gt-adm-usage-table th, .gt-adm-usage-table td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; }
.gt-adm-usage-table th { background: var(--surface-2); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export async function mount(container) {
  ensureStyle();
  let disposed = false;

  const root = el('div', 'gt-adm');
  const h1 = el('h1', null, 'Панель администратора');
  root.append(h1);
  container.replaceChildren(root);

  let users = [];
  try {
    const data = await adminUsers();
    users = data.items || data.users || [];
  } catch (e) {
    if (disposed) return;
    if (e.status === 403 || e.message === 'forbidden') {
      const noAccess = el('div', 'gt-adm-card');
      noAccess.append(el('p', null, 'Только администратор может просматривать эту страницу.'));
      root.replaceChildren(h1, noAccess);
      return;
    }
    root.append(el('p', 'gt-adm-msg err', 'Ошибка загрузки: ' + e.message));
    return;
  }

  if (disposed) return;

  // ---------- Карточка создания пользователя ----------
  const createCard = el('div', 'gt-adm-card');
  createCard.append(el('h2', null, 'Добавить пользователя'));

  const fLogin = el('div', 'gt-adm-field');
  fLogin.append(el('label', null, 'Имя пользователя (3-32 симв.)'));
  const inLogin = document.createElement('input');
  inLogin.type = 'text';
  inLogin.placeholder = 'например: anna';
  fLogin.append(inLogin);

  const fPwd = el('div', 'gt-adm-field');
  fPwd.append(el('label', null, 'Пароль (оставьте пустым для генерации временного)'));
  const inPwd = document.createElement('input');
  inPwd.type = 'password';
  inPwd.placeholder = 'автоматический 12-значный пароль';
  fPwd.append(inPwd);

  const fRole = el('div', 'gt-adm-field');
  fRole.append(el('label', null, 'Роль'));
  const selRole = document.createElement('select');
  selRole.append(
    Object.assign(document.createElement('option'), { value: 'user', textContent: 'Пользователь' }),
    Object.assign(document.createElement('option'), { value: 'admin', textContent: 'Администратор' }),
  );
  fRole.append(selRole);

  const createMsg = el('div', 'gt-adm-msg');
  const tempPwdBox = el('div', 'gt-adm-temp-pwd');
  tempPwdBox.hidden = true;

  const btnCreate = el('button', 'gt-adm-btn primary', '+ Создать');
  btnCreate.type = 'button';

  btnCreate.onclick = async () => {
    const username = inLogin.value.trim();
    const password = inPwd.value.trim() || undefined;
    const role = selRole.value;
    if (!username) {
      createMsg.className = 'gt-adm-msg err';
      createMsg.textContent = 'Введите имя пользователя';
      return;
    }
    btnCreate.disabled = true;
    createMsg.className = 'gt-adm-msg';
    createMsg.textContent = 'Создание…';
    tempPwdBox.hidden = true;
    try {
      const res = await adminCreateUser({ username, role, password });
      users.push(res.user);
      renderUsers(users);
      inLogin.value = '';
      inPwd.value = '';
      createMsg.className = 'gt-adm-msg ok';
      createMsg.textContent = `Пользователь «${username}» успешно создан!`;

      if (res.temp_password) {
        tempPwdBox.replaceChildren(
          el('span', null, `Временный пароль: ${res.temp_password}`),
          Object.assign(el('button', 'gt-adm-btn small', 'Скопировать'), {
            type: 'button',
            onclick: () => {
              navigator.clipboard?.writeText(res.temp_password);
              alert('Пароль скопирован в буфер обмена!');
            },
          }),
        );
        tempPwdBox.hidden = false;
      }
    } catch (e) {
      createMsg.className = 'gt-adm-msg err';
      createMsg.textContent = 'Ошибка: ' + (e.message || 'не удалось создать');
    } finally {
      btnCreate.disabled = false;
    }
  };

  createCard.append(fLogin, fPwd, fRole, btnCreate, createMsg, tempPwdBox);
  root.append(createCard);

  // ---------- Список пользователей ----------
  const listCard = el('div', 'gt-adm-card');
  listCard.append(el('h2', null, 'Список пользователей'));
  const userList = el('ul', 'gt-adm-user-list');
  const listMsg = el('div', 'gt-adm-msg');
  listCard.append(userList, listMsg);
  root.append(listCard);

  function renderUsers(list) {
    userList.replaceChildren();
    if (!list.length) {
      userList.append(el('p', 'gt-adm-msg', 'Нет пользователей'));
      return;
    }

    for (const u of list) {
      const li = el('li', 'gt-adm-user');

      const header = el('div', 'gt-adm-user-header');
      const name = el('span', 'gt-adm-user-name', u.username);
      const badges = el('div', null);
      if (u.role === 'admin') badges.append(el('span', 'gt-adm-badge admin', 'admin '));
      if (u.disabled) badges.append(el('span', 'gt-adm-badge disabled', 'отключён'));
      header.append(name, badges);

      const stats = el('div', 'gt-adm-stats');
      stats.append(
        el('span', null, `Карточек: ${u.cards ?? 0}`),
        el('span', null, `Повторений (7д): ${u.reviews_7d ?? 0}`),
        el('span', null, `ИИ сегодня: ${u.ai_calls_today ?? 0}`),
        el('span', null, `Вход: ${u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('ru-RU') : '—'}`),
        el('span', null, `Активность: ${u.last_active_day || '—'}`),
      );

      const controls = el('div', 'gt-adm-controls');

      // Режим ИИ
      const selAi = document.createElement('select');
      selAi.className = 'gt-adm-btn small';
      selAi.append(
        Object.assign(document.createElement('option'), { value: 'shared', textContent: 'ИИ: общий', selected: u.ai_mode === 'shared' }),
        Object.assign(document.createElement('option'), { value: 'own', textContent: 'ИИ: личные ключи', selected: u.ai_mode === 'own' }),
        Object.assign(document.createElement('option'), { value: 'off', textContent: 'ИИ: отключён', selected: u.ai_mode === 'off' }),
      );
      selAi.onchange = async () => {
        try {
          await adminUpdateUser(u.id, { ai_mode: selAi.value });
          u.ai_mode = selAi.value;
          listMsg.className = 'gt-adm-msg ok';
          listMsg.textContent = `Режим ИИ для ${u.username} обновлён.`;
        } catch (e) {
          listMsg.className = 'gt-adm-msg err';
          listMsg.textContent = 'Ошибка: ' + e.message;
        }
      };

      // Кнопка включить / отключить
      const btnToggleDisable = el(
        'button',
        'gt-adm-btn small',
        u.disabled ? 'Включить' : 'Отключить',
      );
      btnToggleDisable.type = 'button';
      btnToggleDisable.onclick = async () => {
        const nextDisabled = u.disabled ? 0 : 1;
        if (!confirm(`${nextDisabled ? 'Отключить' : 'Включить'} пользователя «${u.username}»?`)) return;
        try {
          await adminUpdateUser(u.id, { disabled: nextDisabled });
          u.disabled = nextDisabled;
          renderUsers(users);
        } catch (e) {
          listMsg.className = 'gt-adm-msg err';
          listMsg.textContent = 'Ошибка: ' + e.message;
        }
      };

      // Сброс пароля
      const btnResetPwd = el('button', 'gt-adm-btn small', 'Сбросить пароль');
      btnResetPwd.type = 'button';
      btnResetPwd.onclick = async () => {
        if (!confirm(`Сбросить пароль пользователя «${u.username}» и выдать временный?`)) return;
        try {
          const res = await adminUpdateUser(u.id, { reset_password: true });
          if (res.temp_password) {
            prompt(`Новый временный пароль для «${u.username}» (скопируйте):`, res.temp_password);
          }
          listMsg.className = 'gt-adm-msg ok';
          listMsg.textContent = `Пароль пользователя «${u.username}» сброшен.`;
        } catch (e) {
          listMsg.className = 'gt-adm-msg err';
          listMsg.textContent = 'Ошибка: ' + e.message;
        }
      };

      // Удаление пользователя
      const btnDel = el('button', 'gt-adm-btn danger small', 'Удалить');
      btnDel.type = 'button';
      btnDel.onclick = async () => {
        const conf = prompt(`Внимание! Будут безвозвратно удалены ВСЕ данные пользователя ${u.username} (карточки, история, статистика).\n\nДля подтверждения введите имя пользователя (${u.username}):`);
        if (!conf) return;
        try {
          await adminDeleteUser(u.id, conf);
          users = users.filter((x) => x.id !== u.id);
          renderUsers(users);
          listMsg.className = 'gt-adm-msg ok';
          listMsg.textContent = `Пользователь «${u.username}» и все его данные удалены.`;
        } catch (e) {
          listMsg.className = 'gt-adm-msg err';
          listMsg.textContent = 'Ошибка: ' + e.message;
        }
      };

      controls.append(selAi, btnToggleDisable, btnResetPwd, btnDel);
      li.append(header, stats, controls);
      userList.append(li);
    }
  }

  renderUsers(users);

  // ---------- Панель расхода ИИ ----------
  const usageCard = el('div', 'gt-adm-card');
  usageCard.append(el('h2', null, 'Использование ИИ (за 7 дней)'));
  const usageContent = el('div', null, 'Загрузка статистики ИИ…');
  usageCard.append(usageContent);
  root.append(usageCard);

  try {
    const uData = await adminUsage();
    const table = el('table', 'gt-adm-usage-table');
    const thead = el('thead', null);
    thead.innerHTML = '<tr><th>Пользователь</th><th>Дата</th><th>Фича</th><th>Запросы</th><th>Сбои</th></tr>';
    table.append(thead);

    const tbody = el('tbody', null);
    for (const r of uData.usage_7d || []) {
      const tr = el('tr', null);
      tr.innerHTML = `<td>${r.username}</td><td>${r.day?.slice(0, 10) || r.day}</td><td>${r.feature}</td><td>${r.calls}</td><td>${r.failures}</td>`;
      tbody.append(tr);
    }
    if (!(uData.usage_7d || []).length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">За последние 7 дней запросов к ИИ не было.</td></tr>';
    }
    table.append(tbody);
    usageContent.replaceChildren(table);
  } catch (e) {
    usageContent.replaceChildren(el('p', 'gt-adm-msg err', 'Ошибка загрузки статистики ИИ: ' + e.message));
  }

  return () => {
    disposed = true;
  };
}

export default mount;
