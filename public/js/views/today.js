// Экран «Сегодня»: план дня, счётчики и кнопка старта; загрузка сессии (с офлайн-кешем)
import { h, navigate, offline } from '../app.js';
import { getToday, ApiError } from '../api.js';
import { getPlan } from '../api2.js';
import { renderPlan } from './plan.js';

let current = null;

/** Последняя загруженная сессия: {session, offline} или null */
export function getCurrent() {
  return current;
}

export function clearCurrent() {
  current = null;
}

/**
 * Загрузить сессию. Сеть недоступна — берём кеш из offline.js.
 * @returns {Promise<{session: object, offline: boolean}>}
 */
export async function fetchSession() {
  const o = await offline();
  try {
    try { if (o.flush) await o.flush(); } catch { /* отправка не критична */ }
    const session = await getToday();
    if (!session || !Array.isArray(session.queue)) throw new ApiError(500, 'INTERNAL', 'Некорректный ответ сервера');
    current = { session, offline: false };
    try { if (o.cacheSession) await o.cacheSession(session); } catch { /* кеш не критичен */ }
    return current;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    let cached = null;
    try { cached = o.loadSession ? await o.loadSession() : null; } catch { cached = null; }
    if (cached && Array.isArray(cached.queue)) {
      current = { session: cached, offline: true };
      return current;
    }
    throw e;
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function formatDate(date) {
  try {
    const d = new Date(`${date}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(date || '');
    return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return String(date || '');
  }
}

export async function mount(container) {
  let disposed = false;

  async function load() {
    container.replaceChildren(h('p', { class: 'muted center', text: 'Загрузка…' }));
    let info;
    try {
      info = await fetchSession();
    } catch (e) {
      if (disposed) return;
      container.replaceChildren(
        h('h1', { text: 'Сегодня' }),
        h('div', { class: 'card-box stack center' },
          h('p', { class: 'error', role: 'alert', text: (e && e.message) || 'Не удалось загрузить сессию' }),
          h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: load })
        )
      );
      return;
    }
    if (disposed) return;
    const s = info.session;
    const counts = s.counts || {};
    const done = s.done_today || {};
    const queueLen = Array.isArray(s.queue) ? s.queue.length : 0;
    const planBox = h('div'); // заполняется асинхронно, сессию не задерживает

    const streakCount = num(s.streak || done.streak || 0);
    const minutesDone = num(done.minutes || 0);

    const statsSmall = h('div', { class: 'row', style: 'gap: var(--s4); margin-bottom: var(--s4); font-size: var(--fs-sm);' },
      h('span', { class: 'muted' }, 'Серия дней: ', h('strong', { class: 'stat-num', style: 'font-size: var(--fs-md);', text: String(streakCount) })),
      h('span', { class: 'muted' }, 'Минут сегодня: ', h('strong', { class: 'stat-num', style: 'font-size: var(--fs-md);', text: String(minutesDone) })),
    );

    const startBtn = queueLen > 0
      ? h('button', {
          class: 'btn primary block lg',
          type: 'button',
          style: 'margin-top: var(--s4);',
          text: `Начать карточки (${queueLen})`,
          onclick: () => navigate('#/review'),
        })
      : h('div', { class: 'card-box center stack', style: 'margin-top: var(--s4);' },
          h('p', { text: 'Карточки на сегодня выполнены.' }),
          h('button', { class: 'btn sm', type: 'button', text: 'Добавить слово', onclick: () => navigate('#/cards') }),
        );

    container.replaceChildren(
      h('h1', { text: 'Сегодня' }),
      h('p', { class: 'muted', style: 'margin-bottom: var(--s3);', text: formatDate(s.date) }),
      info.offline ? h('div', { class: 'banner', text: 'Нет связи: показана сохранённая сессия. Ответы отправятся позже.' }) : null,
      statsSmall,
      planBox,
      h('div', { class: 'stat-grid', style: 'margin-top: var(--s4);' },
        h('div', { class: 'stat' }, h('b', { text: String(num(counts.due)) }), h('span', { text: 'К повторению' })),
        h('div', { class: 'stat' }, h('b', { text: String(num(counts.new)) }), h('span', { text: 'Новых' })),
        h('div', { class: 'stat' }, h('b', { text: String(num(counts.total)) }), h('span', { text: 'Всего в очереди' })),
        h('div', { class: 'stat' }, h('b', { text: String(num(done.reviews)) }), h('span', { text: 'Сделано сегодня' }))
      ),
      startBtn
    );

    // План не критичен: при ошибке или офлайне блок просто не показываем
    if (!info.offline) {
      getPlan()
        .then((plan) => { if (!disposed) renderPlan(planBox, plan); })
        .catch(() => { if (!disposed) planBox.replaceChildren(); });
    }
  }

  await load();
  return () => { disposed = true; };
}

export default mount;
