// #/texts: список текстов для чтения, генерация и вставка своего текста.
// Экспортирует общие помощники для listen.js, reader.js, lab.js.
import { h, toast, navigate } from '../app.js';
import { listTexts, generateText, createText, deleteText, getAiProviders } from '../api2.js';
import { TOPICS } from '/shared/constants.js';

const PAGE = 20;
const KIND_RU = { reading: 'Чтение', listening: 'Монолог', dialogue: 'Диалог' };

/** Русское сообщение об ошибке API */
export function describeError(e) {
  const code = e && e.code;
  const st = e && e.status;
  if (code === 'AI_CAP') return 'Дневной лимит запросов к ИИ исчерпан. Попробуйте завтра.';
  if (code === 'AI_UNAVAILABLE' || st === 503) return 'ИИ сейчас недоступен. Попробуйте позже.';
  if (code === 'RATE_LIMITED' || st === 429) return 'Слишком много запросов. Подождите минуту.';
  if (code === 'AI_BAD_OUTPUT' || st === 502) return 'ИИ вернул неудачный ответ. Попробуйте ещё раз.';
  if (st === 404) return 'Не найдено.';
  return (e && typeof e.message === 'string' && e.message) || 'Что-то пошло не так.';
}

/** id из маршрута: ?id= или #/<name>/<id> */
export function routeId(ctx, name) {
  const p = ctx && ctx.params;
  const q = p && typeof p.get === 'function' ? p.get('id') : null;
  const m = /^#\/?([a-z]+)\/(\d+)/i.exec(location.hash || '');
  const raw = q || (m && m[1] === name ? m[2] : null);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU');
}

function tall(el) {
  el.style.minHeight = '44px';
  return el;
}

function field(label, control) {
  return h('label', { class: 'stack' }, h('span', { class: 'muted', text: label }), tall(control));
}

function opts(pairs, def) {
  return pairs.map(([v, t]) => h('option', { value: v, text: t, selected: v === def }));
}

export const AI_MODEL_OPTIONS = [
  ['auto', 'Авто (Gemini по умолчанию)'],
  ['gemini:strong', 'Gemini Strong (Pro)'],
  ['gemini:fast', 'Gemini Fast (Flash)'],
  ['groq:strong', 'Groq Strong (Llama 70B)'],
  ['groq:fast', 'Groq Fast (Llama 8B)'],
  ['openrouter', 'OpenRouter'],
];

/**
 * Форма генерации текста (feature text).
 * @param {{audio?: boolean, onCreated: (item:object)=>void}} cfg audio=true: выбор монолог/диалог
 */
export function buildGenerateForm({ audio = false, onCreated }) {
  const kind = audio ? h('select', null, opts([['listening', 'Монолог'], ['dialogue', 'Диалог']], 'listening')) : null;
  const topic = h('input', { type: 'text', value: 'Alltag', maxlength: '60', list: 'm9-topics' });
  const level = h('select', null, opts([['B1', 'B1'], ['B2', 'B2'], ['C1', 'C1']], 'B2'));
  const len = h('select', null, opts([['short', 'Короткий (~120 слов)'], ['medium', 'Средний (~220 слов)'], ['long', 'Длинный (~350 слов)']], 'medium'));
  const qc = h('select', null, opts([3, 4, 5, 6, 7, 8].map((n) => [String(n), String(n)]), '5'));
  const due = h('input', { type: 'checkbox', checked: true });
  const prov = h('select', null, opts(AI_MODEL_OPTIONS, 'auto'));
  const err = h('p', { class: 'error' });
  let busy = false;

  const btn = h('button', { class: 'btn primary', type: 'button', text: 'Сгенерировать', onclick: submit });
  topic.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  async function submit() {
    if (busy) return;
    const t = topic.value.trim();
    if (!t || t.length > 60) { err.textContent = 'Укажите тему (до 60 символов).'; return; }
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Генерация… до минуты';
    err.textContent = '';
    try {
      const body = {
        kind: kind ? kind.value : 'reading', topic: t, level: level.value, length: len.value,
        question_count: Number(qc.value) || 5, use_due_words: due.checked,
      };
      if (prov.value !== 'auto') body.provider = prov.value;
      const item = await generateText(body);
      if (!item || !item.id) throw new Error('Пустой ответ сервера');
      if (typeof onCreated === 'function') onCreated(item);
    } catch (e) {
      err.textContent = describeError(e);   // введённые поля сохраняются
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Сгенерировать';
    }
  }

  return h('div', { class: 'card-box stack' },
    h('datalist', { id: 'm9-topics' }, TOPICS.map((t) => h('option', { value: t }))),
    kind ? field('Тип', kind) : null,
    field('Тема', topic), field('Уровень', level), field('Длина', len),
    field('Число вопросов', qc), field('Провайдер ИИ', prov),
    h('label', null, due, ' Использовать мои слова к повторению'),
    btn, err);
}

/**
 * Список сохранённых текстов нескольких видов с пагинацией и удалением.
 * @param {{kinds: string[], href: string, emptyText?: string}} cfg
 */
export function buildTextList({ kinds, href, emptyText = 'Пока нет сохранённых текстов.' }) {
  const listEl = h('div', { class: 'stack' });
  const err = h('p', { class: 'error' });
  const moreBtn = h('button', { class: 'btn', type: 'button', text: 'Показать ещё', hidden: true, onclick: () => load() });
  const el = h('div', { class: 'stack' }, err, listEl, moreBtn);
  const st = kinds.map((k) => ({ kind: k, offset: 0, total: null }));
  let items = [];
  let loading = false;

  function draw() {
    if (!items.length) { listEl.replaceChildren(h('p', { class: 'muted center', text: emptyText })); return; }
    listEl.replaceChildren(...items.map((it) => {
      const meta = [KIND_RU[it.kind] || it.kind, it.level, it.topic, it.word_count ? `${it.word_count} слов` : '', fmtDate(it.created_at)]
        .filter(Boolean).join(' · ');
      return h('div', { class: 'card-box stack' },
        h('a', { href: `${href}${it.id}`, class: 'stack' },
          h('strong', { text: String(it.title || 'Без названия') }),
          h('span', { class: 'muted', text: meta })),
        h('button', {
          class: 'btn sm danger', type: 'button', text: 'Удалить', 'aria-label': `Удалить: ${String(it.title || '')}`,
          onclick: () => remove(it),
        }));
    }));
  }

  async function remove(it) {
    if (!confirm(`Удалить текст «${String(it.title || '')}»?`)) return;
    try {
      await deleteText(it.id);
      items = items.filter((x) => x.id !== it.id);
      draw();
    } catch (e) {
      toast(describeError(e));
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    moreBtn.disabled = true;
    err.textContent = '';
    try {
      await Promise.all(st.filter((s) => s.total === null || s.offset < s.total).map(async (s) => {
        const r = await listTexts({ kind: s.kind, limit: PAGE, offset: s.offset });
        const arr = r && Array.isArray(r.items) ? r.items.filter((x) => x && x.id) : [];
        s.offset += arr.length;
        s.total = Number.isFinite(r && r.total) ? r.total : s.offset;
        if (!arr.length) s.total = s.offset;   // защита от зацикливания
        for (const x of arr) if (!items.some((y) => y.id === x.id)) items.push(x);
      }));
      items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    } catch (e) {
      err.textContent = describeError(e);
    } finally {
      loading = false;
      moreBtn.disabled = false;
      moreBtn.hidden = !st.some((s) => s.total !== null && s.offset < s.total);
      draw();
    }
  }

  load();
  return { el, reload: () => { st.forEach((s) => { s.offset = 0; s.total = null; }); items = []; return load(); } };
}

/** Форма «вставить свой текст» (kind = reading) */
function buildPasteForm() {
  const title = h('input', { type: 'text', maxlength: '200', placeholder: 'Название (необязательно)' });
  const level = h('select', null, opts([['B1', 'B1'], ['B2', 'B2'], ['C1', 'C1']], 'B2'));
  const body = h('textarea', { rows: '8', placeholder: 'Вставьте немецкий текст (от 50 до 20000 символов)' });
  const err = h('p', { class: 'error' });
  let busy = false;
  const btn = h('button', {
    class: 'btn primary', type: 'button', text: 'Сохранить текст',
    onclick: async () => {
      if (busy) return;
      const text = body.value.trim();
      if (text.length < 50 || text.length > 20000) { err.textContent = 'Длина текста должна быть от 50 до 20000 символов.'; return; }
      busy = true;
      btn.disabled = true;
      err.textContent = '';
      try {
        const t = title.value.trim() || `${text.slice(0, 40)}…`;
        const item = await createText({ kind: 'reading', title: t.slice(0, 200), body: text, level: level.value });
        if (!item || !item.id) throw new Error('Пустой ответ сервера');
        navigate(`#/text/${item.id}`);
      } catch (e) {
        err.textContent = describeError(e);
      } finally {
        busy = false;
        btn.disabled = false;
      }
    },
  });
  body.style.minHeight = '160px';
  return h('div', { class: 'card-box stack' }, field('Название', title), field('Уровень', level), field('Текст', body), btn, err);
}

export async function mount(container, ctx) {
  const wantNew = !!(ctx && ctx.params && ctx.params.get('new') === '1');
  const list = buildTextList({ kinds: ['reading'], href: '#/text/' });
  container.append(
    h('h2', { text: 'Тексты для чтения' }),
    h('details', { open: wantNew },
      h('summary', { text: 'Сгенерировать текст' }),
      buildGenerateForm({ onCreated: (item) => navigate(`#/text/${item.id}`) })),
    h('details', null,
      h('summary', { text: 'Вставить свой текст' }),
      buildPasteForm()),
    h('h3', { text: 'Сохранённые тексты' }),
    list.el);
  return () => { /* таймеров и слушателей нет */ };
}
