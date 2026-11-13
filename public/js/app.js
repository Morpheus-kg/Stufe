// Оболочка: хеш-роутер, тема, нижняя панель вкладок, общие помощники UI (h, toast, navigate, ...)
import { me, getSettings } from './api.js';
import { speak, setPreferredVoice } from './tts.js';
import { ICON_TODAY, ICON_CARDS, ICON_PRACTICE, ICON_STATS, ICON_MORE } from './ui/icons.js';

export const POS_RU = {
  noun: 'сущ.', verb: 'глагол', adj: 'прил.', adv: 'нареч.',
  phrase: 'фраза', idiom: 'идиома', collocation: 'коллокация',
};

const DEFAULT_SETTINGS = {
  new_per_day: 10, max_reviews_per_day: 150, max_session_items: 40, request_retention: 0.9,
  tts_rate: 0.9, tts_voice: '', theme: 'auto', daily_goal_minutes: 15, ai_enabled: true,
  difficulty: 'medium', learn_auto_seconds: 6, auto_next_ms: 900, ai_provider_generate: 'auto',
  stt_engine: 'browser', listening_plays: 2, plan_minutes: 20,
  weight_hoeren: 35, weight_sprechen: 25, weight_lesen: 25, weight_schreiben: 5, weight_vocab: 10,
  exam_date: '', numbers_level: 2,
};

/** Общее состояние клиента */
export const state = { settings: { ...DEFAULT_SETTINGS } };

// ---------- DOM-помощники (без innerHTML: весь текст через textContent) ----------
const DOM_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden']);

function appendChildren(el, children) {
  for (const ch of children) {
    if (ch === null || ch === undefined || ch === false) continue;
    if (Array.isArray(ch)) appendChildren(el, ch);
    else el.append(ch instanceof Node ? ch : document.createTextNode(String(ch)));
  }
}

/** h('div', {class:'x', text:'..', onclick: fn}, ...children) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (DOM_PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/** Слово в показываемом виде: артикль + term */
export function displayTerm(card) {
  if (!card) return '';
  return card.article ? `${card.article} ${card.term ?? ''}` : String(card.term ?? '');
}

export function toast(msg, ms = 3200) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: 'toast', text: String(msg) });
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** Озвучка с учётом настроек */
export function speakText(text) {
  return speak(text, { rate: state.settings.tts_rate, voice: state.settings.tts_voice });
}

// Модуль offline.js (M6) подключаем лениво: без него приложение не падает
let offlinePromise = null;
export function offline() {
  if (!offlinePromise) offlinePromise = import('./offline.js').catch(() => ({}));
  return offlinePromise;
}

// ---------- тема и настройки ----------
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
  // Сохраняем в localStorage, чтобы no-flash скрипт применил до первой отрисовки
  try { localStorage.setItem('gt-theme', theme || 'auto'); } catch { /* квота */ }
}

function applySettings(s) {
  state.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  applyTheme(state.settings.theme);
  setPreferredVoice(state.settings.tts_voice);
}

/** Загрузить настройки с сервера (при ошибке остаются кешированные) */
export async function loadSettings() {
  try {
    const s = await getSettings();
    if (s && typeof s === 'object') {
      applySettings(s);
      try { localStorage.setItem('gt_settings', JSON.stringify(state.settings)); } catch { /* квота */ }
    }
  } catch { /* офлайн или 401 — оставляем текущие */ }
  return state.settings;
}

// ---------- маршруты ----------
const ROUTES = new Set([
  'login', 'change-password', 'profile', 'today', 'review', 'cards', 'stats', 'settings',
  'plan', 'texts', 'text', 'listen', 'lab', 'translate', 'retell', 'numbers', 'speak', 'write', 'skills',
  'practice', 'admin', 'styleguide',
]);
// Имя маршрута -> файл вида (по умолчанию совпадает)
const VIEW_FILE = { text: 'reader' };

// Вкладка нижней панели для каждого маршрута
const TAB_OF = {
  today: 'today', plan: 'today', review: 'today',
  cards: 'cards',
  practice: 'practice',
  texts: 'practice', text: 'practice', listen: 'practice', lab: 'practice', translate: 'practice',
  retell: 'practice', numbers: 'practice', speak: 'practice', write: 'practice',
  stats: 'stats', skills: 'stats',
  settings: 'more', admin: 'more', profile: 'more', styleguide: 'more',
};

const TABS = [
  { key: 'today', label: 'Сегодня', iconSvg: ICON_TODAY, href: '#/today' },
  { key: 'cards', label: 'Слова', iconSvg: ICON_CARDS, href: '#/cards' },
  { key: 'practice', label: 'Практика', iconSvg: ICON_PRACTICE, href: '#/practice' },
  { key: 'stats', label: 'Статистика', iconSvg: ICON_STATS, href: '#/skills' },
  { key: 'more', label: 'Ещё', iconSvg: ICON_MORE, menu: 'more' },
];

const MENUS = {
  more: [
    ['Профиль', '#/profile'],
    ['План дня', '#/plan'], ['Общая статистика', '#/stats'],
    ['Настройки', '#/settings'],
    ['Администратор', '#/admin'],
    ['Гид по стилям', '#/styleguide'],
  ],
};

const SHELL_CSS = `
#tabbar button[data-route]{background:none;border:0;font:inherit;color:inherit;cursor:pointer;min-height:44px;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
#tabbar [aria-current]{font-weight:700}
#tabbar .tab-icon{display:flex;align-items:center;justify-content:center;width:24px;height:24px}
#tabbar .tab-icon svg{width:20px;height:20px}
.gt-menu{position:fixed;left:8px;right:8px;max-width:420px;margin:0 auto;z-index:50;background:var(--surface,Canvas);color:var(--text,CanvasText);border:1px solid var(--border,rgba(128,128,128,.4));border-radius:12px;padding:6px;box-shadow:0 6px 24px rgba(0,0,0,.25)}
.gt-menu a{display:flex;align-items:center;min-height:44px;padding:0 12px;border-radius:8px;color:inherit;text-decoration:none}
.gt-menu a:hover,.gt-menu a:focus-visible{background:rgba(128,128,128,.18)}
`;

function ensureShellStyle() {
  if (document.getElementById('gt-shell-style')) return;
  const s = document.createElement('style');
  s.id = 'gt-shell-style';
  s.textContent = SHELL_CSS;
  document.head.append(s);
}

let menuEl = null;
let menuKey = null;

function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  menuKey = null;
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onMenuKey);
  document.querySelectorAll('#tabbar [aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function onDocDown(e) {
  if (!menuEl) return;
  const t = e.target;
  if (menuEl.contains(t) || (t.closest && t.closest('#tabbar button[aria-haspopup]'))) return;
  closeMenu();
}

function onMenuKey(e) {
  if (e.key === 'Escape') closeMenu();
}

function toggleMenu(key, btn) {
  if (menuKey === key) { closeMenu(); return; }
  closeMenu();
  const bar = document.getElementById('tabbar');
  const items = MENUS[key] || [];
  menuEl = h('div', { class: 'gt-menu', role: 'menu' },
    items.map(([label, href]) => h('a', {
      href, role: 'menuitem', text: label,
      onclick: (e) => { e.preventDefault(); closeMenu(); navigate(href); },
    })));
  menuEl.style.bottom = `${(bar ? bar.offsetHeight : 56) + 8}px`;
  document.body.append(menuEl);
  menuKey = key;
  btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onMenuKey);
}

/** Нижняя панель строится здесь: index.html (M4) менять не нужно */
function buildTabbar() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  ensureShellStyle();
  bar.replaceChildren(...TABS.map((t) => {
    const iconSpan = document.createElement('span');
    iconSpan.className = 'tab-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = t.iconSvg;
    const labelSpan = h('span', { text: t.label });
    const inner = [iconSpan, labelSpan];
    if (t.href) return h('a', { href: t.href, 'data-route': t.key }, ...inner);
    const btn = h('button', {
      type: 'button', 'data-route': t.key, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    }, ...inner);
    btn.addEventListener('click', () => toggleMenu(t.menu, btn));
    return btn;
  }));
}

let renderToken = 0;
let cleanupFn = null;
let authOk = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/');
  const name = parts[0] || 'today';
  if (!ROUTES.has(name)) {
    history.replaceState(null, '', '#/today');
    return { name: 'today', params: new URLSearchParams(), id: null };
  }
  const params = new URLSearchParams(query);
  let id = null;
  if (parts[1]) {
    try { id = decodeURIComponent(parts[1]); } catch { id = parts[1]; }
    params.set('id', id);
  }
  return { name, params, id };
}

function stopCurrent() {
  if (cleanupFn) {
    try { cleanupFn(); } catch { /* ignore */ }
    cleanupFn = null;
  }
}

function setChrome(name) {
  document.body.dataset.route = name;
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  bar.hidden = name === 'login' || name === 'change-password';
  const tab = TAB_OF[name];
  bar.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

async function ensureAuth() {
  if (authOk) return true;
  try {
    const user = await me();
    authOk = true;
    if (user?.must_change_password) {
      if (location.hash !== '#/change-password') location.hash = '#/change-password';
      return true;
    }
    offline().then((o) => o.flush && o.flush()).catch(() => {});
    return true;
  } catch (e) {
    if (e && e.code === 'PASSWORD_CHANGE_REQUIRED') {
      if (location.hash !== '#/change-password') location.hash = '#/change-password';
      return true;
    }
    if (e && e.status === 401) return false;
    authOk = true; // нет сети: работаем с кешем
    return true;
  }
}

function showViewError(container) {
  container.replaceChildren(
    h('div', { class: 'card-box stack center' },
      h('p', { class: 'error', text: 'Не удалось открыть раздел.' }),
      h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: () => render() })
    )
  );
}

async function render() {
  const token = ++renderToken;
  const route = parseHash();
  stopCurrent();
  closeMenu();
  setChrome(route.name);
  const root = document.getElementById('view');
  // Новый контейнер на каждый рендер: «опоздавшие» async-вьюхи пишут в отсоединённый узел
  const container = h('div', { class: 'view-inner' });
  root.replaceChildren(container);
  window.scrollTo(0, 0);

  if (route.name === 'login') {
    authOk = false;
  } else if (route.name === 'change-password') {
    // Экран обязательной смены пароля
  } else {
    container.append(h('p', { class: 'muted center', text: 'Загрузка…' }));
    const ok = await ensureAuth();
    if (token !== renderToken) return;
    if (!ok) {
      if (location.hash !== '#/login') location.hash = '#/login';
      return;
    }
    await loadSettings();
    if (token !== renderToken) return;
    container.replaceChildren();
  }

  try {
    const file = VIEW_FILE[route.name] || route.name;
    const mod = await import(`./views/${file}.js`);
    if (token !== renderToken) return;
    const fn = mod.mount || mod.render || mod.default;
    if (typeof fn !== 'function') throw new Error('view entry');
    const res = await fn(container, { params: route.params, id: route.id, settings: state.settings, navigate });
    if (token !== renderToken) {
      if (typeof res === 'function') { try { res(); } catch { /* ignore */ } }
      return;
    }
    if (typeof res === 'function') cleanupFn = res;
  } catch {
    if (token !== renderToken) return;
    showViewError(container);
  }
}

function boot() {
  try {
    const raw = localStorage.getItem('gt_settings');
    if (raw) applySettings(JSON.parse(raw));
  } catch { /* битый кеш игнорируем */ }

  buildTabbar();
  window.addEventListener('hashchange', render);
  window.addEventListener('online', () => {
    offline().then((o) => o.flush && o.flush()).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    toast('Что-то пошло не так');
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'SW_UPDATED') toast('Вышла новая версия. Перезагрузите страницу.', 6000);
    });
  }
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/today');
  render();
}

boot();