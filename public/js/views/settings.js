// Экран «Настройки»: параметры (включая v2), импорт, резервные копии, обогащение, расход ИИ
import {
  getSettings, putSettings, importCards, exportAll, exportDeck, restoreAll,
  enrichRun, enrichStatus, getAiUsage, logout,
} from '../api.js';
import { getAiProviders } from '../api2.js';
import { flush, pendingCount } from '../offline.js';

const STYLE_ID = 'gt-settings-style';
const CSS = `
.gt-se{max-width:640px;margin:0 auto;padding:var(--s3) 0 var(--s6)}
.gt-se h1{font-size:var(--fs-xl);margin:var(--s2) 0 var(--s4);font-weight:700}
.gt-se h2{font-size:var(--fs-lg);margin:0 0 var(--s2);font-weight:600}
.gt-se h3{font-size:var(--fs-sm);margin:var(--s4) 0 var(--s2);color:var(--text-2);font-weight:600}
.gt-se-card{border:1px solid var(--border);border-radius:var(--radius);padding:var(--s4);margin:0 0 var(--s4);background:var(--surface);color:var(--text)}
.gt-se-field{margin:0 0 var(--s3)}
.gt-se-field label{display:block;margin:0 0 var(--s1);font-weight:500;font-size:var(--fs-sm);color:var(--text-2)}
.gt-se input[type=number],.gt-se input[type=date],.gt-se select{width:100%;box-sizing:border-box;min-height:var(--tap);font-size:var(--fs-md);padding:var(--s2) var(--s3);border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text)}
.gt-se input[type=file]{display:block;width:100%;min-height:var(--tap);margin:0 0 var(--s2);font-size:var(--fs-sm);color:var(--text-2)}
.gt-se button{min-height:var(--tap);font-size:var(--fs-md);padding:var(--s2) var(--s4);margin:var(--s1) var(--s2) var(--s1) 0;cursor:pointer;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font:inherit;transition:background var(--dur),border-color var(--dur)}
.gt-se button:hover{background:var(--surface-2)}
.gt-se button:disabled{opacity:.4;cursor:default}
.gt-se-check,.gt-se-radio{display:flex;align-items:center;gap:var(--s2);min-height:var(--tap);font-size:var(--fs-md)}
.gt-se-check input,.gt-se-radio input{width:20px;height:20px;flex:0 0 auto;accent-color:var(--accent)}
.gt-se-muted{color:var(--text-3);font-size:var(--fs-sm)}
.gt-se-msg{margin:var(--s2) 0;min-height:1.2em;font-size:var(--fs-sm)}
.gt-se-err{color:var(--danger);font-weight:600}
.gt-se-list{margin:var(--s2) 0;padding-left:var(--s5);font-size:var(--fs-sm)}
.gt-se progress{width:100%;height:6px;margin:var(--s2) 0;accent-color:var(--accent)}
`;

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_RESTORE_BYTES = 5 * 1024 * 1024; // лимит тела запроса на сервере
const IMPORT_CHUNK = 1000;
const ENRICH_LIMIT = 25;
const ENRICH_MAX_LOOPS = 200;

const DEFAULTS = {
  new_per_day: 10,
  max_reviews_per_day: 150,
  max_session_items: 40,
  request_retention: 0.9,
  tts_rate: 0.9,
  tts_voice: '',
  theme: 'auto',
  daily_goal_minutes: 15,
  ai_enabled: true,
  difficulty: 'medium',
  learn_auto_seconds: 6,
  auto_next_ms: 900,
  ai_provider_generate: 'auto',
  stt_engine: 'browser',
  listening_plays: 2,
  exam_date: '',
  timezone: '',
  numbers_level: 2,
};

const COMMON_TIMEZONES = [
  ['', 'По умолчанию сервера (Europe/Berlin)'],
  ['Europe/Berlin', 'Europe/Berlin (Берлин, Вена, Цюрих)'],
  ['Europe/Moscow', 'Europe/Moscow (Москва)'],
  ['Europe/Kyiv', 'Europe/Kyiv (Киев)'],
  ['Europe/Minsk', 'Europe/Minsk (Минск)'],
  ['Asia/Almaty', 'Asia/Almaty (Алматы, Астана)'],
  ['Asia/Tashkent', 'Asia/Tashkent (Ташкент)'],
  ['Asia/Tbilisi', 'Asia/Tbilisi (Тбилиси, Ереван, Баку)'],
  ['Europe/London', 'Europe/London (Лондон)'],
  ['America/New_York', 'America/New_York (Нью-Йорк)'],
];

// Числовые поля v1
const NUM_BASE = [
  { key: 'new_per_day', label: 'Новых карточек в день', type: 'int', min: 0, max: 100, step: 1 },
  { key: 'max_reviews_per_day', label: 'Максимум повторений в день', type: 'int', min: 0, max: 1000, step: 10 },
  { key: 'max_session_items', label: 'Максимум заданий в сессии', type: 'int', min: 1, max: 200, step: 1 },
  {
    key: 'request_retention', label: 'Целевое удержание', type: 'float', min: 0.7, max: 0.97, step: 0.01,
    hint: 'От 0.70 до 0.97. Чем выше, тем чаще повторы.',
  },
  { key: 'tts_rate', label: 'Скорость озвучки', type: 'float', min: 0.5, max: 1.5, step: 0.1, hint: 'От 0.5 до 1.5.' },
  { key: 'daily_goal_minutes', label: 'Цель на день, минут', type: 'int', min: 1, max: 240, step: 5 },
];
// Числовые поля v2: обучение
const NUM_LEARN = [
  {
    key: 'learn_auto_seconds', label: 'Автопереход с экрана нового слова, сек', type: 'int', min: 0, max: 30, step: 1,
    hint: '0 — только вручную.',
  },
  {
    key: 'auto_next_ms', label: 'Пауза после верного ответа, мс', type: 'int', min: 0, max: 5000, step: 100,
    hint: '0 — только вручную.',
  },
];
// Числовые поля v2: тренажёры
const NUM_PLAN = [
  { key: 'numbers_level', label: 'Уровень тренажёра чисел (1–4)', type: 'int', min: 1, max: 4, step: 1 },
];
const NUM_FIELDS = [...NUM_BASE, ...NUM_LEARN, ...NUM_PLAN];

const FEATURE_LABELS = {
  correct: 'Проверка предложений',
  generate: 'Генерация слов',
  enrich: 'Обогащение карточек',
  gender: 'Проверка рода',
  text: 'Генерация текстов',
  translate: 'Переводы',
  speak: 'Говорение',
  write: 'Письмо и пересказ',
  lookup: 'Словарь и анализ текста',
};
const RESTORE_LABELS = {
  cards: 'Карточки',
  card_state: 'Состояния повторения',
  review_log: 'Журнал ответов',
  sentences: 'Предложения',
  settings: 'Настройки',
  daily_stats: 'Дневная статистика',
};

const PROVIDER_LABELS = { auto: 'Авто', groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter' };

// ---------- Утилиты ----------

class UserError extends Error {
  constructor(message) {
    super(message);
    this.isUser = true;
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

// Создание DOM только через textContent / createTextNode (никакого innerHTML)
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function section(title, ...kids) {
  return h('section', { class: 'gt-se-card' }, h('h2', { text: title }), ...kids);
}

function statusEl() {
  return h('p', { class: 'gt-se-msg', role: 'status', 'aria-live': 'polite' });
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.classList.toggle('gt-se-err', kind === 'error');
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function errText(e) {
  if (e && (e.isUser || e.code) && e.message) return e.message;
  if (e instanceof TypeError) return 'Нет связи с сервером.';
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

function field(label, control, hint) {
  return h('div', { class: 'gt-se-field' },
    h('label', { for: control.id, text: label }),
    control,
    hint ? h('small', { class: 'gt-se-muted', text: hint }) : null);
}

function option(value, text) {
  return h('option', { value, text });
}

// Тема: data-theme на <html> (auto — убираем атрибут, работает prefers-color-scheme)
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  try { localStorage.setItem('gt-theme', theme || 'auto'); } catch { /* квота */ }
}

async function readJsonFile(file, maxBytes) {
  if (!file) throw new UserError('Сначала выберите файл.');
  if (file.size > maxBytes) {
    throw new UserError(`Файл слишком большой (максимум ${Math.round(maxBytes / 1048576)} МБ).`);
  }
  const text = await file.text();
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new UserError('Файл не является корректным JSON.');
  }
}

// ---------- Параметры ----------

async function fillVoices(select, current, hint) {
  async function load() {
    let names = [];
    try {
      const mod = await import('../tts.js');
      const list = await Promise.resolve(mod.listGermanVoices ? mod.listGermanVoices() : []);
      names = (Array.isArray(list) ? list : [])
        .map((v) => (typeof v === 'string' ? v : v && v.name))
        .filter((x) => typeof x === 'string' && x);
    } catch { /* озвучки может не быть */ }
    return [...new Set(names)];
  }

  function fill(names) {
    select.replaceChildren(option('', 'Авто (лучший немецкий голос)'));
    for (const name of names) select.append(option(name, name));
    if (current && !names.includes(current)) select.append(option(current, `${current} (нет на этом устройстве)`));
    select.value = current || '';
    hint.textContent = names.length
      ? 'Выбранный голос применится после сохранения.'
      : 'Немецкий голос не найден. Установите его в настройках устройства (синтез речи).';
  }

  const names = await load();
  fill(names);
  if (!names.length && 'speechSynthesis' in window) {
    // голоса в браузере иногда подгружаются с задержкой
    window.speechSynthesis.addEventListener('voiceschanged', async () => {
      const again = await load();
      if (again.length) fill(again);
    }, { once: true });
  }
}

function settingsSection(initial, retry) {
  const sec = section('Параметры');
  if (!initial) {
    sec.append(
      h('p', { class: 'gt-se-err', role: 'alert', text: 'Не удалось загрузить настройки.' }),
      h('button', { type: 'button', text: 'Повторить', onclick: retry }));
    return sec;
  }
  const s = { ...DEFAULTS, ...initial };
  const inputs = {};
  const selects = {}; // key -> {el, num}
  const form = h('form', { novalidate: true });

  function addNum(f) {
    const input = h('input', {
      id: `gt-se-${f.key}`,
      type: 'number',
      inputmode: f.type === 'int' ? 'numeric' : 'decimal',
      min: f.min,
      max: f.max,
      step: f.step,
      value: s[f.key],
    });
    input.value = s[f.key];
    inputs[f.key] = input;
    form.append(field(f.label, input, f.hint));
  }

  function addSelect(key, label, opts, isNum, hint) {
    const el = h('select', { id: `gt-se-${key}` }, opts.map(([v, t]) => option(String(v), t)));
    const cur = String(s[key]);
    el.value = opts.some(([v]) => String(v) === cur) ? cur : String(opts[0][0]);
    selects[key] = { el, num: !!isNum };
    form.append(field(label, el, hint));
    return el;
  }

  for (const f of NUM_BASE) addNum(f);

  const voiceSel = h('select', { id: 'gt-se-tts_voice' });
  const voiceHint = h('small', { class: 'gt-se-muted', text: 'Загрузка списка голосов…' });
  form.append(h('div', { class: 'gt-se-field' },
    h('label', { for: 'gt-se-tts_voice', text: 'Голос озвучки' }), voiceSel, voiceHint));
  fillVoices(voiceSel, String(s.tts_voice || ''), voiceHint);

  const testBtn = h('button', { type: 'button', text: 'Проверить звук' });
  testBtn.addEventListener('click', async () => {
    try {
      const mod = await import('../tts.js');
      const rate = Number(String(inputs.tts_rate.value).replace(',', '.')) || 0.9;
      await mod.speak('Guten Tag! Wie geht es dir?', { rate });
    } catch { /* звук необязателен */ }
  });
  form.append(testBtn);

  const themeSel = h('select', { id: 'gt-se-theme' },
    option('auto', 'Как в системе'), option('light', 'Светлая'), option('dark', 'Тёмная'));
  themeSel.value = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
  form.append(field('Тема', themeSel));

  const aiChk = h('input', { type: 'checkbox', id: 'gt-se-ai_enabled' });
  aiChk.checked = !!s.ai_enabled;
  form.append(h('label', { class: 'gt-se-check' }, aiChk,
    'Включить функции ИИ (проверка предложений, генерация, обогащение)'));

  // --- v2: обучение ---
  form.append(h('h3', { text: 'Обучение' }));
  addSelect('difficulty', 'Сложность', [['easy', 'Лёгкая (варианты ответа)'], ['medium', 'Средняя'], ['hard', 'Сложная']], false);
  for (const f of NUM_LEARN) addNum(f);

  // --- v2: аудирование и речь ---
  form.append(h('h3', { text: 'Аудирование и речь' }));
  addSelect('listening_plays', 'Прослушиваний текста в аудировании', [[1, '1'], [2, '2']], true);
  addSelect('stt_engine', 'Распознавание речи', [['browser', 'В браузере'], ['whisper', 'Whisper (сервер)']], false,
    'Если выбранный способ не поддерживается устройством, предложим другой.');

  // --- v2: план и экзамен ---
  form.append(h('h3', { text: 'План дня, часовой пояс и экзамен' }));
  for (const f of NUM_PLAN) addNum(f);
  const tzOpts = [...COMMON_TIMEZONES];
  if (s.timezone && !tzOpts.some(([v]) => v === s.timezone)) {
    tzOpts.push([s.timezone, s.timezone]);
  }
  const tzSel = addSelect('timezone', 'Часовой пояс (смена суток в 04:00)', tzOpts, false);
  const detectTzBtn = h('button', {
    type: 'button',
    text: 'Определить автоматически',
    onclick: () => {
      try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        if (!detected) return;
        if (!Array.from(tzSel.options).some((o) => o.value === detected)) {
          tzSel.append(option(detected, detected));
        }
        tzSel.value = detected;
      } catch { /* ignore */ }
    },
  });
  form.append(detectTzBtn);
  const examInp = h('input', { type: 'date', id: 'gt-se-exam_date' });
  examInp.value = typeof s.exam_date === 'string' ? s.exam_date : '';
  form.append(field('Дата экзамена', examInp, 'Пусто — без обратного отсчёта.'));

  // --- v2: ИИ ---
  form.append(h('h3', { text: 'ИИ' }));
  const provSel = addSelect('ai_provider_generate', 'Провайдер для генерации слов',
    Object.entries(PROVIDER_LABELS), false);
  getAiProviders().then((r) => {
    const chain = r && Array.isArray(r.chain) ? r.chain : [];
    for (const o of provSel.options) {
      const p = chain.find((c) => c && c.name === o.value);
      if (p && p.available === false) o.textContent = `${PROVIDER_LABELS[o.value] || o.value} (нет ключа)`;
    }
  }).catch(() => { /* список провайдеров необязателен */ });

  const msg = statusEl();
  const saveBtn = h('button', { type: 'submit', text: 'Сохранить' });
  form.append(saveBtn, msg);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {};
    const problems = [];
    for (const f of NUM_FIELDS) {
      const raw = String(inputs[f.key].value).trim().replace(',', '.');
      const v = Number(raw);
      const bad = raw === '' || !Number.isFinite(v) || v < f.min || v > f.max
        || (f.type === 'int' && !Number.isInteger(v));
      if (bad) problems.push(`«${f.label}»: допустимо от ${f.min} до ${f.max}`);
      else payload[f.key] = v;
    }
    const examVal = examInp.value;
    if (examVal !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(examVal)) problems.push('«Дата экзамена»: неверный формат');
    if (problems.length) {
      setMsg(msg, problems.join('. ') + '.', 'error');
      return;
    }
    payload.tts_voice = voiceSel.value;
    payload.theme = themeSel.value;
    payload.ai_enabled = aiChk.checked;
    payload.exam_date = examVal;
    for (const [key, sel] of Object.entries(selects)) {
      payload[key] = sel.num ? Number(sel.el.value) : sel.el.value;
    }

    saveBtn.disabled = true;
    try {
      const saved = await putSettings(payload);
      const merged = { ...payload, ...(saved && typeof saved === 'object' ? saved : {}) };
      applyTheme(merged.theme);
      for (const f of NUM_FIELDS) inputs[f.key].value = merged[f.key];
      for (const [key, sel] of Object.entries(selects)) sel.el.value = String(merged[key]);
      examInp.value = typeof merged.exam_date === 'string' ? merged.exam_date : '';
      setMsg(msg, 'Сохранено.');
    } catch (e) {
      setMsg(msg, errText(e), 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  sec.append(form);
  return sec;
}

// ---------- Очередь ответов ----------

function pendingSection() {
  const info = h('p', { class: 'gt-se-muted', text: 'Проверка очереди…' });
  const msg = statusEl();
  const btn = h('button', { type: 'button', text: 'Отправить сейчас' });

  async function refresh() {
    try {
      const cnt = await pendingCount();
      info.textContent = cnt
        ? `Не отправлено на сервер: ${cnt}.`
        : 'Все ответы синхронизированы.';
    } catch {
      info.textContent = 'Состояние очереди недоступно.';
    }
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setMsg(msg, '');
    try {
      const r = await flush();
      if (r.offline) setMsg(msg, 'Нет сети: ответы отправятся позже.', 'error');
      else if (r.pending > 0) setMsg(msg, `Часть ответов не ушла (осталось ${r.pending}). Попробуйте позже.`, 'error');
      else setMsg(msg, 'Готово.');
    } finally {
      btn.disabled = false;
      await refresh();
    }
  });

  refresh();
  return section('Синхронизация', info, btn, msg);
}

// ---------- Импорт ----------

function importSection() {
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Файл с карточками (JSON)' });
  const btn = h('button', { type: 'button', text: 'Импортировать' });
  const msg = statusEl();
  const result = h('ul', { class: 'gt-se-list' });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    result.replaceChildren();
    setMsg(msg, '');
    try {
      const f = file.files && file.files[0];
      const data = await readJsonFile(f, MAX_IMPORT_BYTES);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : null);
      if (!list) throw new UserError('Ожидается JSON-массив карточек.');
      const items = list.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      const unreadable = list.length - items.length;
      if (!items.length) throw new UserError('В файле нет карточек.');

      const sum = { total: 0, added: 0, merged: 0, flagged: 0 };
      for (let i = 0; i < items.length; i += IMPORT_CHUNK) {
        setMsg(msg, `Отправлено ${Math.min(i, items.length)} из ${items.length}…`);
        const r = await importCards({
          filename: f.name.slice(0, 255),
          cards: items.slice(i, i + IMPORT_CHUNK),
        });
        sum.total += n(r?.total);
        sum.added += n(r?.added);
        sum.merged += n(r?.merged);
        sum.flagged += n(r?.flagged);
      }
      setMsg(msg, 'Импорт завершён.');
      result.append(
        h('li', { text: `Всего строк: ${sum.total}` }),
        h('li', { text: `Добавлено: ${sum.added}` }),
        h('li', { text: `Объединено с существующими: ${sum.merged}` }),
        h('li', { text: `Пропущено (пустые или слишком короткие): ${sum.flagged}` }));
      if (unreadable > 0) result.append(h('li', { text: `Нечитаемых элементов в файле: ${unreadable}` }));
    } catch (e) {
      setMsg(msg, errText(e), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  return section('Импорт карточек',
    h('p', { class: 'gt-se-muted', text: 'Файл JSON с массивом карточек (старый или новый формат). Дубликаты объединяются.' }),
    file, btn, msg, result);
}

// ---------- Резервная копия ----------

function backupSection() {
  // Экспорт
  const exportBtn = h('button', { type: 'button', text: 'Скачать полную резервную копию' });
  const exportDeckBtn = h('button', { type: 'button', text: 'Экспорт колоды карточек (JSON v2)' });
  const exportMsg = statusEl();
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    setMsg(exportMsg, '');
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const a = h('a', { href: url, download: `german-trainer-${ymd}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const cnt = Array.isArray(data?.cards) ? data.cards.length : 0;
      setMsg(exportMsg, `Файл сохранён. Карточек: ${cnt}.`);
    } catch (e) {
      setMsg(exportMsg, errText(e), 'error');
    } finally {
      exportBtn.disabled = false;
    }
  });
  exportDeckBtn.addEventListener('click', async () => {
    exportDeckBtn.disabled = true;
    setMsg(exportMsg, '');
    try {
      const data = await exportDeck(true);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const a = h('a', { href: url, download: `german-trainer-deck-${ymd}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const cnt = Array.isArray(data?.cards) ? data.cards.length : 0;
      setMsg(exportMsg, `Колода сохранена. Карточек: ${cnt}.`);
    } catch (e) {
      setMsg(exportMsg, errText(e), 'error');
    } finally {
      exportDeckBtn.disabled = false;
    }
  });

  // Восстановление (безопасное слияние)
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Файл резервной копии' });
  const restoreBtn = h('button', { type: 'button', text: 'Восстановить (объединить с текущими данными)' });
  const restoreMsg = statusEl();
  const result = h('ul', { class: 'gt-se-list' });

  restoreBtn.addEventListener('click', async () => {
    restoreBtn.disabled = true;
    result.replaceChildren();
    setMsg(restoreMsg, '');
    try {
      const data = await readJsonFile(file.files && file.files[0], MAX_RESTORE_BYTES);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.cards)) {
        throw new UserError('Это не похоже на файл резервной копии.');
      }
      const r = await restoreAll(data);
      setMsg(restoreMsg, 'Восстановление завершено.');
      const restored = r && typeof r.restored === 'object' && r.restored ? r.restored : {};
      for (const [k, v] of Object.entries(restored)) {
        result.append(h('li', { text: `${Object.hasOwn(RESTORE_LABELS, k) ? RESTORE_LABELS[k] : k}: ${n(v)}` }));
      }
    } catch (e) {
      setMsg(restoreMsg, errText(e), 'error');
    } finally {
      restoreBtn.disabled = false;
    }
  });

  return section('Резервная копия',
    h('p', { class: 'gt-se-muted', text: 'Делайте копию раз в неделю и храните файл вне телефона.' }),
    exportBtn, exportDeckBtn, exportMsg,
    h('hr'),
    h('p', { text: 'Безопасное восстановление из файла (объединение без удаления текущих карточек):' }),
    file,
    restoreBtn, restoreMsg, result);
}

// ---------- Обогащение ----------

function enrichSection() {
  const sec = section('Обогащение карточек');
  const info = h('p', { class: 'gt-se-muted', text: 'Загрузка статуса…' });
  const bar = h('progress', { max: 1, value: 0, hidden: true, 'aria-label': 'Прогресс обогащения' });
  const msg = statusEl();
  const runBtn = h('button', { type: 'button', text: 'Обогатить новые карточки' });
  const stopBtn = h('button', { type: 'button', text: 'Остановить', hidden: true });
  let cancel = false;
  let running = false;

  async function refresh() {
    try {
      const st = await enrichStatus();
      const aiOk = !st || st.ai_available !== false;
      const pending = n(st?.pending);
      info.textContent = `Без обогащения: ${pending}. На проверку: ${n(st?.flagged)}.`
        + (aiOk ? '' : ' ИИ сейчас недоступен.');
      if (!running) runBtn.disabled = !aiOk || pending === 0;
      return st;
    } catch {
      info.textContent = 'Статус недоступен.';
      if (!running) runBtn.disabled = false;
      return null;
    }
  }

  stopBtn.addEventListener('click', () => { cancel = true; });

  runBtn.addEventListener('click', async () => {
    running = true;
    cancel = false;
    runBtn.disabled = true;
    stopBtn.hidden = false;
    setMsg(msg, '');
    let finished = false;
    try {
      const st0 = await refresh();
      const total = Math.max(n(st0?.pending), 1);
      bar.max = total;
      bar.value = 0;
      bar.hidden = false;
      let done = 0;

      for (let i = 0; i < ENRICH_MAX_LOOPS && !cancel && sec.isConnected; i += 1) {
        const r = await enrichRun({ limit: ENRICH_LIMIT });
        const processed = n(r?.processed);
        const remaining = Number(r?.remaining);
        done += processed;
        const st = await refresh();
        const left = st ? n(st.pending) : (Number.isFinite(remaining) ? remaining : 0);
        bar.value = Math.min(Math.max(total - left, 0), total);
        setMsg(msg, `Обработано: ${done}. Осталось: ${left}.`);

        if (!Number.isFinite(remaining)) {
          setMsg(msg, 'Неожиданный ответ сервера.', 'error');
          break;
        }
        if (remaining <= 0) {
          finished = true;
          break;
        }
        if (processed === 0) {
          setMsg(msg, 'Прогресс остановился. Повторите позже.', 'error');
          break;
        }
      }
      if (finished) setMsg(msg, `Готово. Обработано карточек: ${done}.`);
      else if (cancel) setMsg(msg, `Остановлено. Обработано карточек: ${done}.`);
    } catch (e) {
      setMsg(msg, errText(e), 'error');
    } finally {
      running = false;
      stopBtn.hidden = true;
      await refresh();
    }
  });

  sec.append(info, runBtn, stopBtn, bar, msg);
  refresh();
  return sec;
}

// ---------- Расход ИИ ----------

function usageNumber(v, key) {
  if (typeof v === 'number') return key === 'calls' ? v : 0;
  if (!v || typeof v !== 'object') return 0;
  if (Number.isFinite(Number(v[key]))) return Number(v[key]);
  // вложенность по провайдерам: суммируем
  let sum = 0;
  for (const x of Object.values(v)) {
    if (x && typeof x === 'object' && Number.isFinite(Number(x[key]))) sum += Number(x[key]);
  }
  return sum;
}

function renderUsage(box, data) {
  box.replaceChildren();
  const by = data && typeof data.by_feature === 'object' && data.by_feature ? data.by_feature : {};
  const caps = data && typeof data.caps === 'object' && data.caps ? data.caps : {};
  const keys = [...new Set([...Object.keys(by), ...Object.keys(caps)])];
  if (!keys.length) {
    box.append(h('p', { class: 'gt-se-muted', text: 'Запросов к ИИ сегодня не было.' }));
    return;
  }
  box.append(h('p', { class: 'gt-se-muted', text: `Дата: ${data && data.day ? String(data.day) : '—'}` }));
  const ul = h('ul', { class: 'gt-se-list' });
  for (const k of keys) {
    const used = usageNumber(by[k], 'calls');
    const fails = usageNumber(by[k], 'failures');
    const capN = Number(caps[k]);
    let line = `${Object.hasOwn(FEATURE_LABELS, k) ? FEATURE_LABELS[k] : k}: ${used}`;
    if (Number.isFinite(capN)) line += ` из ${capN}`;
    if (fails > 0) line += ` (сбоев: ${fails})`;
    ul.append(h('li', { text: line }));
  }
  box.append(ul);
}

function usageSection() {
  const box = h('div');
  const msg = statusEl();
  const btn = h('button', { type: 'button', text: 'Обновить' });

  async function load() {
    btn.disabled = true;
    setMsg(msg, '');
    try {
      renderUsage(box, await getAiUsage());
    } catch (e) {
      setMsg(msg, errText(e), 'error');
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', load);
  load();
  return section('Расход ИИ за сегодня', box, btn, msg);
}

// ---------- Аккаунт ----------

function accountSection() {
  const btn = h('button', { class: 'btn danger', type: 'button', text: 'Выйти из системы' });
  btn.addEventListener('click', async () => {
    if (!confirm('Вы действительно хотите выйти из системы?')) return;
    btn.disabled = true;
    try {
      await logout();
    } catch { /* всё равно уходим на экран входа */ }
    location.hash = '#/login';
  });
  return section('Аккаунт', btn);
}

// ---------- Точка входа ----------

export async function mount(container) {
  ensureStyle();
  const root = h('section', { class: 'gt-se' }, h('h1', { text: 'Настройки' }));
  container.replaceChildren(root);

  let settings = null;
  try {
    settings = await getSettings();
  } catch (e) {
    if (e && e.status === 401) return; // редирект на логин делает api.js/app.js
  }
  if (settings && typeof settings === 'object') applyTheme(settings.theme);

  const retry = () => mount(container);
  root.append(
    settingsSection(settings && typeof settings === 'object' ? settings : null, retry),
    pendingSection(),
    importSection(),
    backupSection(),
    enrichSection(),
    usageSection(),
    accountSection(),
  );
}

export default mount;