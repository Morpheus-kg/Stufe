// План дня: дискретный чек-лист задач на сегодня (#/plan и блок на экране «Сегодня»)
import { h, navigate } from '../app.js';
import { getPlan } from '../api2.js';

const STYLE_ID = 'gt-plan-style';
const CSS = `
.gt-plan {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--s4);
  margin: 0 0 var(--s4);
  background: var(--surface);
  color: var(--text);
}
.gt-plan h2 { font-size: var(--fs-md); margin: 0 0 var(--s2); font-weight: 600; }
.gt-plan progress { width: 100%; height: 6px; margin: var(--s2) 0 var(--s3); accent-color: var(--accent); }
.gt-plan ul { list-style: none; margin: 0; padding: 0; }
.gt-plan li a {
  display: flex;
  gap: var(--s3);
  align-items: center;
  min-height: var(--tap);
  padding: var(--s2) 0;
  color: inherit;
  text-decoration: none;
  border-top: 1px solid var(--border);
}
.gt-plan li:first-child a { border-top: 0; }
.gt-plan .mark {
  flex: 0 0 24px;
  text-align: center;
  font-size: var(--fs-md);
  color: var(--accent);
  font-weight: 700;
}
.gt-plan .body { flex: 1; }
.gt-plan .ttl { font-weight: 600; font-size: var(--fs-sm); }
.gt-plan .done .ttl { text-decoration: line-through; color: var(--text-3); }
.gt-plan .sub { font-size: var(--fs-xs); color: var(--text-2); }
.gt-plan .min { flex: 0 0 auto; font-size: var(--fs-xs); color: var(--text-3); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function safeRoute(r) {
  return typeof r === 'string' && r.startsWith('#/') ? r : '#/today';
}

/** Нарисовать чек-лист задач в box (box очищается) */
export function renderPlan(box, plan) {
  ensureStyle();
  box.replaceChildren();
  const items = Array.isArray(plan && plan.items) ? plan.items : [];
  const total = num(plan && plan.total_tasks) || items.length;
  const done = num(plan && plan.done_tasks) || items.filter((i) => i && i.done).length;
  const wrap = h('section', { class: 'gt-plan', 'aria-label': 'Чек-лист на сегодня' },
    h('h2', { text: 'Задачи на сегодня' }));
  if (!items.length) {
    wrap.append(h('p', { class: 'muted', text: 'Список задач пока пуст.' }));
    box.append(wrap);
    return;
  }
  wrap.append(
    h('div', { class: 'sub', text: `Выполнено задач: ${done} из ${total}` }),
    h('progress', { max: Math.max(total, 1), value: Math.min(done, Math.max(total, 1)), 'aria-label': 'Выполнение чек-листа' })
  );
  const ul = h('ul');
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const route = safeRoute(it.route);
    const badge = it.target_label ? String(it.target_label) : (it.done ? 'Готово' : 'Открыть →');
    ul.append(h('li', { class: it.done ? 'done' : '' },
      h('a', {
        href: route,
        onclick: (e) => { e.preventDefault(); navigate(route); },
      },
      h('span', { class: 'mark', 'aria-label': it.done ? 'сделано' : 'не сделано', text: it.done ? '✓' : '☐' }),
      h('span', { class: 'body' },
        h('div', { class: 'ttl', text: String(it.title || it.kind || 'Задание') }),
        it.reason_ru ? h('div', { class: 'sub', text: String(it.reason_ru) }) : null),
      h('span', { class: 'min', text: badge }))));
  }
  wrap.append(ul);
  box.append(wrap);
}

export async function mount(container) {
  let disposed = false;
  async function load() {
    container.replaceChildren(h('p', { class: 'muted center', text: 'Загрузка…' }));
    let plan;
    try {
      plan = await getPlan();
    } catch (e) {
      if (disposed) return;
      container.replaceChildren(
        h('h1', { text: 'План дня' }),
        h('div', { class: 'card-box stack center' },
          h('p', { class: 'error', role: 'alert', text: (e && e.message) || 'Не удалось загрузить чек-лист' }),
          h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: load })));
      return;
    }
    if (disposed) return;
    const box = h('div');
    container.replaceChildren(h('h1', { text: 'План дня' }), box,
      h('button', { class: 'btn primary block lg', type: 'button', text: 'К карточкам', onclick: () => navigate('#/review') }));
    renderPlan(box, plan);
  }
  await load();
  return () => { disposed = true; };
}

export default mount;
