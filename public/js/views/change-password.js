// Экран обязательной смены пароля (CONTRACT v3, A7)
import { h, navigate } from '../app.js';
import { changePassword } from '../api3.js';

export async function mount(container) {
  const curId  = 'cp-current';
  const newId  = 'cp-new';
  const confId = 'cp-confirm';

  const curPass = h('input', {
    type: 'password', id: curId, class: 'input',
    autocomplete: 'current-password', required: true,
  });
  const newPass = h('input', {
    type: 'password', id: newId, class: 'input',
    autocomplete: 'new-password', required: true,
  });
  const confPass = h('input', {
    type: 'password', id: confId, class: 'input',
    autocomplete: 'new-password', required: true,
  });
  const err = h('p', { class: 'error', role: 'alert', 'aria-live': 'assertive', hidden: true });
  const btn = h('button', { class: 'btn primary block lg', type: 'submit', text: 'Установить новый пароль' });

  async function onSubmit(e) {
    e.preventDefault();
    err.hidden = true;
    if (newPass.value.length < 8) {
      err.textContent = 'Новый пароль должен содержать не менее 8 символов.';
      err.hidden = false;
      newPass.focus();
      return;
    }
    if (newPass.value !== confPass.value) {
      err.textContent = 'Новые пароли не совпадают.';
      err.hidden = false;
      confPass.focus();
      return;
    }
    btn.disabled = true;
    try {
      await changePassword(curPass.value, newPass.value);
      navigate('#/today');
    } catch (ex) {
      err.textContent = (ex && ex.message) || 'Не удалось сменить пароль';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  container.append(
    h('div', { class: 'login-wrap' },
      h('h1', { text: 'Смена пароля' }),
      h('p', { class: 'muted', text: 'Перед продолжением работы необходимо установить постоянный пароль.' }),
      h('form', { class: 'stack', onsubmit: onSubmit },
        h('div', { class: 'field' },
          h('label', { for: curId,  class: 'field-label', text: 'Текущий пароль' }), curPass),
        h('div', { class: 'field' },
          h('label', { for: newId,  class: 'field-label', text: 'Новый пароль (от 8 символов)' }), newPass),
        h('div', { class: 'field' },
          h('label', { for: confId, class: 'field-label', text: 'Повторите новый пароль' }), confPass),
        err,
        btn,
      ),
    ),
  );
  curPass.focus();
}
