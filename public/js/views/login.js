// Экран входа (CONTRACT v3, A7)
import { h, navigate, loadSettings } from '../app.js';
import { login } from '../api.js';

export async function mount(container) {
  const userId = 'login-username';
  const passId = 'login-password';

  const userInput = h('input', {
    type: 'text',
    id: userId,
    class: 'input',
    autocomplete: 'username',
    placeholder: 'Имя пользователя',
    required: true,
  });
  const passInput = h('input', {
    type: 'password',
    id: passId,
    class: 'input',
    autocomplete: 'current-password',
    placeholder: 'Пароль',
    required: true,
  });
  const err = h('p', { class: 'error', role: 'alert', 'aria-live': 'assertive', hidden: true });
  const btn = h('button', { class: 'btn primary block lg', type: 'submit', text: 'Войти' });

  async function onSubmit(e) {
    e.preventDefault();
    const username = userInput.value.trim();
    const pw = passInput.value;
    if (!username) { userInput.focus(); return; }
    if (!pw)       { passInput.focus(); return; }
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await login({ username, password: pw });
      userInput.value = '';
      passInput.value = '';
      if (res?.must_change_password) { navigate('#/change-password'); return; }
      await loadSettings();
      navigate('#/today');
    } catch (ex) {
      if (ex && ex.code === 'PASSWORD_CHANGE_REQUIRED') { navigate('#/change-password'); return; }
      err.textContent =
        ex && ex.status === 401
          ? 'Неверное имя пользователя или пароль'
          : (ex && ex.message) || 'Не удалось войти';
      err.hidden = false;
      passInput.select();
    } finally {
      btn.disabled = false;
    }
  }

  container.append(
    h('div', { class: 'login-wrap' },
      h('h1', { text: 'German Trainer' }),
      h('form', { class: 'stack', onsubmit: onSubmit },
        h('div', { class: 'field' },
          h('label', { for: userId, class: 'field-label', text: 'Имя пользователя' }),
          userInput,
        ),
        h('div', { class: 'field' },
          h('label', { for: passId, class: 'field-label', text: 'Пароль' }),
          passInput,
        ),
        err,
        btn,
      ),
    ),
  );
  userInput.focus();
}
