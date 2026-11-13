// Перевод пакетами: настройка -> ответы без обратной связи -> одна проверка -> результат; история
import { h, toast, displayTerm } from '../app.js';
import { translateSet, translateSetCheck, translateSets, translateSetGet } from '../api2.js';
import { renderBatchResult } from '../ui/batch_result.js';
import { openLookup } from '../ui/lookup.js';

const KIND_RU = { ru_de: 'Русский → немецкий', de_ru: 'Немецкий → русский', transform: 'Satzbau (трансформация)' };
const FOCUS_RU = {
  '': 'Микс', nebensatz: 'Придаточные', passiv: 'Passiv', konjunktiv2: 'Konjunktiv II',
  relativsatz: 'Relativsatz', nominalisierung: 'Nominalisierung', indirekte_rede: 'Indirekte Rede', konnektoren: 'Konnektoren',
};
const st = (el, o) => { Object.assign(el.style, o); return el; };

function errText(e) {
  const c = e && e.code;
  if (c === 'AI_CAP') return 'Дневной лимит ИИ исчерпан. Ответы сохранены, проверьте завтра.';
  if (c === 'AI_UNAVAILABLE') return 'ИИ сейчас недоступен. Ответы сохранены, попробуйте позже.';
  if (c === 'RATE_LIMITED') return 'Слишком много запросов. Подождите немного.';
  if (c === 'NETWORK') return 'Нет соединения. Ответы сохранены.';
  return (e && e.message) || 'Что-то пошло не так.';
}

// ---------- черновики ----------
const draftKey = (id) => `translate_draft_${id}`;
function loadDraft(id) {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
    if (d && typeof d === 'object') return { answers: d.answers && typeof d.answers === 'object' ? d.answers : {}, pos: Number(d.pos) || 0, t0: Number(d.t0) || Date.now() };
  } catch { /* битый черновик */ }
  return { answers: {}, pos: 0, t0: Date.now() };
}
function saveDraft(id, d) { try { localStorage.setItem(draftKey(id), JSON.stringify(d)); } catch { /* квота */ } }
function clearDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch { /* ignore */ } }

/** Немецкий текст со словами, по тапу открывающими словарь */
function tappable(text, context) {
  const box = h('p', {});
  st(box, { fontSize: '1.1em', lineHeight: '1.7' });
  for (const part of String(text ?? '').split(/([\p{L}][\p{L}'’-]*)/u)) {
    if (!part) continue;
    if (/^[\p{L}]/u.test(part)) {
      const s = h('span', { text: part, role: 'button', tabindex: '0' });
      st(s, { cursor: 'pointer', borderBottom: '1px dotted currentColor' });
      const open = () => openLookup(part, context);
      s.addEventListener('click', open);
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      box.append(s);
    } else box.append(document.createTextNode(part));
  }
  return box;
}

function normalizeAnswers(a) {
  const map = {};
  if (Array.isArray(a)) for (const x of a) { if (x && Number.isInteger(x.idx)) map[x.idx] = String(x.answer ?? ''); }
  else if (a && typeof a === 'object') for (const [k, v] of Object.entries(a)) map[k] = String(v ?? '');
  return map;
}

export async function mount(container) {
  let alive = true;

  const clear = () => container.replaceChildren();
  const loading = (msg) => { clear(); container.append(h('p', { class: 'muted center', text: msg })); };

  // ---------- результат ----------
  function showResult(result, items, answers) {
    const out = h('div', {});
    const sources = items.map((it) => ({ idx: it.idx, source: it.source_text, answer: answers[it.idx] || '' }));
    renderBatchResult(out, result, { sources });
    clear();
    container.append(
      h('h2', { text: 'Результат' }), out,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', text: 'Новый набор', onclick: showSetup }))
    );
    window.scrollTo(0, 0);
  }

  // ---------- ответы ----------
  function showQuestions(set) {
    const items = Array.isArray(set.items) ? set.items : [];
    if (!items.length) { toast('Набор пуст'); showSetup(); return; }
    const draft = loadDraft(set.id);
    draft.pos = Math.min(Math.max(0, draft.pos), items.length - 1);
    let checking = false;

    function step() {
      const i = draft.pos;
      const it = items[i];
      const last = i === items.length - 1;
      const answered = items.filter((x) => (draft.answers[x.idx] || '').trim()).length;

      const bar = st(h('div', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(items.length), 'aria-valuenow': String(i + 1) }),
        { height: '6px', background: 'rgba(128,128,128,.3)', borderRadius: '3px', overflow: 'hidden' });
      bar.append(st(h('div', {}), { height: '100%', width: `${((i + 1) / items.length) * 100}%`, background: 'var(--accent, #3b82f6)' }));

      const ta = h('textarea', { rows: '4', maxlength: '600', 'aria-label': 'Ваш перевод', placeholder: set.kind === 'de_ru' ? 'Перевод на русский' : 'Ответ на немецком' });
      ta.value = draft.answers[it.idx] || '';
      st(ta, { width: '100%', boxSizing: 'border-box', fontSize: '1.05em', padding: '10px', minHeight: '96px' });
      if (set.kind !== 'de_ru') { ta.setAttribute('lang', 'de'); ta.setAttribute('autocapitalize', 'sentences'); ta.setAttribute('spellcheck', 'false'); }
      ta.addEventListener('input', () => { draft.answers[it.idx] = ta.value; draft.pos = i; saveDraft(set.id, draft); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!last) go(1); }
      });

      const hints = Array.isArray(it.hint_words) ? it.hint_words.filter((x) => x && typeof x === 'object') : [];
      const prev = h('button', { class: 'btn', type: 'button', text: '← Назад', disabled: i === 0, onclick: () => go(-1) });
      const next = last ? null : h('button', { class: 'btn primary', type: 'button', text: 'Далее →', onclick: () => go(1) });
      const finish = h('button', { class: last ? 'btn primary' : 'btn', type: 'button', text: `Проверить всё (${answered}/${items.length})`, onclick: doCheck });
      for (const b of [prev, next, finish]) if (b) st(b, { minHeight: '44px' });

      clear();
      container.append(
        h('div', { class: 'stack' },
          h('div', { class: 'muted', text: `${KIND_RU[set.kind] || ''} · ${i + 1} из ${items.length}` }),
          bar,
          it.instruction_ru ? h('p', {}, h('strong', { text: it.instruction_ru })) : null,
          set.kind === 'ru_de' ? st(h('p', { text: String(it.source_text ?? '') }), { fontSize: '1.1em', lineHeight: '1.6' })
            : tappable(it.source_text, String(it.source_text ?? '').slice(0, 200)),
          hints.length ? h('div', {}, h('span', { class: 'muted', text: 'Слова: ' }),
            hints.map((x) => st(h('span', { class: 'chip', text: String(x.display ?? '') }), { marginRight: '4px' }))) : null,
          ta,
          h('div', { class: 'actions' }, prev, next, finish)
        )
      );
      if (set.kind !== 'de_ru' || true) ta.focus();
    }

    function go(d) {
      draft.pos = Math.min(items.length - 1, Math.max(0, draft.pos + d));
      saveDraft(set.id, draft);
      step();
    }

    async function doCheck() {
      if (checking) return;
      const answers = items.map((x) => ({ idx: x.idx, answer: String(draft.answers[x.idx] || '').trim().slice(0, 600) }));
      if (!answers.some((a) => a.answer)) { toast('Введите хотя бы один ответ'); return; }
      checking = true;
      loading('Проверяю все предложения… (один запрос ИИ на 6 предложений)');
      const seconds = Math.min(3600, Math.max(0, Math.round((Date.now() - draft.t0) / 1000)));
      try {
        const result = await translateSetCheck(set.id, answers, seconds, set.provider);
        if (!alive) return;
        clearDraft(set.id);
        const map = {};
        for (const a of answers) map[a.idx] = a.answer;
        showResult(result, items, map);
      } catch (e) {
        if (!alive) return;
        checking = false;
        if (e && e.status === 409) {
          // уже проверен: показываем сохранённый результат
          try {
            const full = await translateSetGet(set.id);
            if (full && full.result) { clearDraft(set.id); showResult(full.result, Array.isArray(full.items) ? full.items : items, normalizeAnswers(full.answers)); return; }
          } catch { /* падаем в сообщение */ }
        }
        step();
        container.prepend(h('p', { class: 'error', text: errText(e) }));
      }
    }

    step();
  }

  // ---------- история ----------
  async function openHistory(id) {
    loading('Загрузка…');
    try {
      const full = await translateSetGet(id);
      if (!alive) return;
      const items = Array.isArray(full && full.items) ? full.items : [];
      if (full && full.result) showResult(full.result, items, normalizeAnswers(full.answers));
      else showQuestions({ id: full.id ?? id, kind: full.kind, items });
    } catch (e) {
      if (!alive) return;
      showSetup();
      toast(errText(e));
    }
  }

  // ---------- настройка ----------
  async function showSetup() {
    const kind = h('select', { 'aria-label': 'Тип' }, Object.entries(KIND_RU).map(([v, t]) => h('option', { value: v, text: t })));
    const count = h('select', { 'aria-label': 'Количество' }, [3, 5, 7, 10].map((n) => h('option', { value: n, text: `${n} предл.`, selected: n === 5 })));
    const level = h('select', { 'aria-label': 'Уровень' }, ['B1', 'B2', 'C1'].map((l) => h('option', { value: l, text: l, selected: l === 'B2' })));
    const focus = h('select', { 'aria-label': 'Тема Satzbau' }, Object.entries(FOCUS_RU).map(([v, t]) => h('option', { value: v, text: t })));
    const provider = h('select', { 'aria-label': 'Модель ИИ' }, [
      ['auto', 'ИИ: Авто (Gemini)'],
      ['gemini:strong', 'Gemini Strong (Pro)'],
      ['gemini:fast', 'Gemini Fast (Flash)'],
      ['groq:strong', 'Groq Strong (Llama 70B)'],
      ['groq:fast', 'Groq Fast (Llama 8B)'],
      ['openrouter', 'OpenRouter'],
    ].map(([p, label]) => h('option', { value: p, text: label })));
    const topic = h('input', { type: 'text', maxlength: '50', placeholder: 'Тема (необязательно)', 'aria-label': 'Тема' });
    const focusRow = h('label', {}, 'Конструкция ', focus);
    focusRow.hidden = true;
    kind.addEventListener('change', () => { focusRow.hidden = kind.value !== 'transform'; });
    for (const el of [kind, count, level, focus, provider, topic]) st(el, { minHeight: '44px', width: '100%', boxSizing: 'border-box' });

    const err = h('p', { class: 'error' });
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Создать набор' });
    st(go, { minHeight: '44px' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      err.textContent = '';
      go.textContent = 'Создаю…';
      const body = { kind: kind.value, count: Number(count.value), level: level.value };
      if (topic.value.trim()) body.topic = topic.value.trim();
      if (kind.value === 'transform' && focus.value) body.focus = focus.value;
      if (provider.value !== 'auto') body.provider = provider.value;
      try {
        const set = await translateSet(body);
        if (!alive) return;
        if (!set || !Array.isArray(set.items) || !set.items.length) throw new Error('Пустой набор');
        saveDraft(set.id, { answers: {}, pos: 0, t0: Date.now() });
        showQuestions({ ...set, provider: provider.value });
      } catch (e) {
        if (!alive) return;
        go.disabled = false;
        go.textContent = 'Создать набор';
        err.textContent = errText(e);
      }
    });

    const histBox = h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'История загружается…' }));
    clear();
    container.append(
      h('h2', { text: 'Перевод' }),
      h('p', { class: 'muted', text: 'Ответьте на все предложения, обратная связь придёт одной проверкой в конце.' }),
      h('div', { class: 'card-box stack' }, kind, focusRow, count, level, topic, provider, go, err),
      h('h3', { text: 'История' }), histBox
    );

    try {
      const res = await translateSets(20);
      if (!alive) return;
      const list = Array.isArray(res && res.items) ? res.items : [];
      if (!list.length) { histBox.replaceChildren(h('p', { class: 'muted', text: 'Пока пусто.' })); return; }
      histBox.replaceChildren(...list.map((s) => {
        const d = s.checked_at || s.created_at;
        const date = d ? new Date(d).toLocaleDateString('ru-RU') : '';
        const status = s.checked_at ? `${Number.isFinite(Number(s.score)) ? Math.round(Number(s.score)) : '—'}/100` : 'не проверен';
        const b = h('button', { class: 'btn', type: 'button', text: `${KIND_RU[s.kind] || s.kind} · ${s.n ?? '?'} предл. · ${status} · ${date}`, onclick: () => openHistory(s.id) });
        return st(b, { minHeight: '44px', textAlign: 'left', width: '100%' });
      }));
    } catch (e) {
      if (alive) histBox.replaceChildren(h('p', { class: 'muted', text: 'История недоступна: ' + errText(e) }));
    }
  }

  showSetup();
  return () => { alive = false; };
}