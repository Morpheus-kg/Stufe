// Экран профиля пользователя (CONTRACT v3, A7)
import { h, navigate } from '../app.js';
import { me, changePassword, getKeys, putKey, deleteKey, starterDeck } from '../api3.js';
import { logout } from '../api.js';

export async function mount(container) {
  const root = h('div', { class: 'stack' });
  root.append(h('h1', { text: 'Профиль' }));

  const content = h('div', { class: 'stack' });
  root.append(content);
  container.replaceChildren(root);

  content.append(h('p', { class: 'muted center', text: 'Загрузка профиля…' }));

  let user = null;
  let keyStatus = { groq: false, gemini: false, openrouter: false };

  try {
    user = await me();
    try {
      keyStatus = (await getKeys()) || keyStatus;
    } catch {
      // Ключи не поддерживаются (нет KEYS_SECRET) или сбой
    }
  } catch (ex) {
    content.replaceChildren(
      h('p', { class: 'error center', role: 'alert', text: (ex && ex.message) || 'Не удалось загрузить данные профиля' }),
    );
    return;
  }

  content.replaceChildren();

  // 1. Информация о пользователе
  const userBox = h(
    'div',
    { class: 'card-box stack' },
    h('h2', { text: `Пользователь: ${user.username}` }),
    h('p', { class: 'muted', text: `Роль: ${user.role === 'admin' ? 'Администратор' : 'Пользователь'} • Режим ИИ: ${user.ai_mode}` }),
  );
  content.append(userBox);

  // 2. Смена пароля
  const curPassId = 'prof-cur-pass';
  const newPassId = 'prof-new-pass';

  const pwdCur = h('input', {
    id: curPassId,
    type: 'password',
    class: 'input',
    autocomplete: 'current-password',
    placeholder: 'Текущий пароль',
    required: true,
  });
  const pwdNew = h('input', {
    id: newPassId,
    type: 'password',
    class: 'input',
    autocomplete: 'new-password',
    placeholder: 'Новый пароль (от 8 символов)',
    required: true,
  });
  const pwdMsg = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', hidden: true });
  const pwdBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Сменить пароль' });

  const pwdForm = h(
    'form',
    {
      class: 'card-box stack',
      onsubmit: async (e) => {
        e.preventDefault();
        pwdMsg.hidden = true;
        if (pwdNew.value.length < 8) {
          pwdMsg.textContent = 'Новый пароль должен быть не менее 8 символов.';
          pwdMsg.className = 'error';
          pwdMsg.hidden = false;
          pwdNew.focus();
          return;
        }
        pwdBtn.disabled = true;
        try {
          await changePassword(pwdCur.value, pwdNew.value);
          pwdMsg.textContent = 'Пароль успешно изменён.';
          pwdMsg.className = 'muted';
          pwdMsg.hidden = false;
          pwdCur.value = '';
          pwdNew.value = '';
        } catch (err) {
          pwdMsg.textContent = (err && err.message) || 'Ошибка смены пароля';
          pwdMsg.className = 'error';
          pwdMsg.hidden = false;
        } finally {
          pwdBtn.disabled = false;
        }
      },
    },
    h('h2', { text: 'Смена пароля' }),
    h('div', { class: 'field' },
      h('label', { for: curPassId, class: 'field-label', text: 'Текущий пароль' }),
      pwdCur,
    ),
    h('div', { class: 'field' },
      h('label', { for: newPassId, class: 'field-label', text: 'Новый пароль' }),
      pwdNew,
    ),
    pwdMsg,
    h('div', {}, pwdBtn),
  );
  content.append(pwdForm);

  // 3. Персональные ключи ИИ
  const keysBox = h('div', { class: 'card-box stack' },
    h('h2', { text: 'Персональные ключи ИИ' }),
    h('p', { class: 'muted', text: 'Ключи шифруются и не передаются никому. Необязательно при общем режиме ИИ.' }),
  );
  const providers = [
    { id: 'groq', name: 'Groq' },
    { id: 'gemini', name: 'Google Gemini' },
    { id: 'openrouter', name: 'OpenRouter' },
  ];

  for (const prov of providers) {
    const isSet = Boolean(keyStatus[prov.id]);
    const inputId = `prof-key-${prov.id}`;
    const badge = h('span', { class: isSet ? 'badge success' : 'badge', text: isSet ? 'Сохранён' : 'Не задан' });
    const headerRow = h('div', { class: 'row', style: 'justify-content: space-between;' },
      h('label', { for: inputId, class: 'field-label', text: prov.name }),
      badge,
    );
    const keyInput = h('input', {
      id: inputId,
      type: 'password',
      class: 'input',
      autocomplete: 'off',
      placeholder: isSet ? '••••••••••••••••••••' : 'Введите API-ключ',
    });
    const keyMsg = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', hidden: true });
    const btnSave = h('button', { class: 'btn sm', type: 'button', text: 'Сохранить ключ' });
    const btnDel = h('button', {
      class: 'btn sm danger',
      type: 'button',
      text: 'Удалить',
      hidden: !isSet,
    });

    btnSave.onclick = async () => {
      const val = keyInput.value.trim();
      if (!val) {
        keyInput.focus();
        return;
      }
      keyMsg.hidden = true;
      btnSave.disabled = true;
      try {
        await putKey(prov.id, val);
        keyStatus[prov.id] = true;
        keyInput.value = '';
        keyInput.placeholder = '••••••••••••••••••••';
        badge.textContent = 'Сохранён';
        badge.className = 'badge success';
        btnDel.hidden = false;
        keyMsg.textContent = 'Ключ сохранён';
        keyMsg.className = 'muted';
        keyMsg.hidden = false;
      } catch (err) {
        keyMsg.textContent = (err && err.message) || 'Ошибка сохранения ключа';
        keyMsg.className = 'error';
        keyMsg.hidden = false;
      } finally {
        btnSave.disabled = false;
      }
    };

    btnDel.onclick = async () => {
      if (!confirm(`Удалить ключ для ${prov.name}?`)) return;
      btnDel.disabled = true;
      keyMsg.hidden = true;
      try {
        await deleteKey(prov.id);
        keyStatus[prov.id] = false;
        keyInput.value = '';
        keyInput.placeholder = 'Введите API-ключ';
        badge.textContent = 'Не задан';
        badge.className = 'badge';
        btnDel.hidden = true;
        keyMsg.textContent = 'Ключ удалён';
        keyMsg.className = 'muted';
        keyMsg.hidden = false;
      } catch (err) {
        keyMsg.textContent = (err && err.message) || 'Ошибка удаления ключа';
        keyMsg.className = 'error';
        keyMsg.hidden = false;
      } finally {
        btnDel.disabled = false;
      }
    };

    const actions = h('div', { class: 'row' }, btnSave, btnDel);
    const row = h('div', { class: 'field stack', style: 'padding: var(--s2) 0; border-bottom: 1px solid var(--border);' },
      headerRow,
      keyInput,
      actions,
      keyMsg,
    );
    keysBox.append(row);
  }
  content.append(keysBox);

  // 4. Стартовый набор карточек
  const starterMsg = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite', hidden: true });
  const starterBtn = h('button', { class: 'btn', type: 'button', text: 'Взять стартовый набор карточек' });
  starterBtn.onclick = async () => {
    if (!confirm('Скопировать стартовый набор карточек в вашу колоду?')) return;
    starterBtn.disabled = true;
    starterMsg.hidden = true;
    try {
      const res = await starterDeck();
      starterMsg.textContent = `Готово! Добавлено карточек: ${res.copied}, пропущено (уже были): ${res.skipped}.`;
      starterMsg.className = 'muted';
      starterMsg.hidden = false;
    } catch (err) {
      starterMsg.textContent = (err && err.message) || 'Ошибка загрузки стартового набора';
      starterMsg.className = 'error';
      starterMsg.hidden = false;
    } finally {
      starterBtn.disabled = false;
    }
  };

  const starterBox = h(
    'div',
    { class: 'card-box stack' },
    h('h2', { text: 'Стартовый набор' }),
    h('p', { class: 'muted', text: 'Позволяет скопировать базовую колоду карточек для быстрого старта.' }),
    h('div', {}, starterBtn),
    starterMsg,
  );
  content.append(starterBox);

  // 5. Выход из аккаунта
  const logoutBtn = h('button', { class: 'btn danger block', type: 'button', text: 'Выйти из системы' });
  logoutBtn.onclick = async () => {
    try {
      await logout();
    } finally {
      navigate('#/login');
    }
  };
  content.append(h('div', { style: 'margin-top: var(--s4);' }, logoutBtn));
}

export default mount;
