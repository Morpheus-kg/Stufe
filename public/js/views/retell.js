// Пересказ: русский текст -> немецкий текст (Schreiben). Один вызов ИИ на оценку.
import { h, toast, navigate as nav } from '../app.js';
import { retellTask, retellEvaluate } from '../api2.js';
import { gradeSentence } from '/shared/grading.js';
import { renderErrors } from '../ui/error_list.js';

const LS_TASK = 'retell_current';
const draftKey = (id) => `retell_draft_${id}`;
const TOPICS = [
  'Arbeit und Bewerbung', 'Wohnen', 'Umwelt', 'Medien und Social Media', 'Gesundheit', 'Bildung', 'Reisen',
  'Konsum und Werbung', 'Integration und Gesellschaft', 'Technik', 'Freizeit', 'Familie', 'Stadt und Land',
];
const CRIT_RU = { content: 'Содержание', coherence: 'Связность', vocabulary: 'Лексика', grammar: 'Грамматика' };
const AI_OPTIONS = [
  ['auto', 'Авто (Gemini по умолчанию)'],
  ['gemini:strong', 'Gemini Strong (Pro)'],
  ['gemini:fast', 'Gemini Fast (Flash)'],
  ['groq:strong', 'Groq Strong (Llama 70B)'],
  ['groq:fast', 'Groq Fast (Llama 8B)'],
  ['openrouter', 'OpenRouter'],
];

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* квота */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

const countWords = (t) => (String(t || '').match(/\S+/g) || []).length;
const num = (v, a, b) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : 0; };

function errMsg(e) {
  if (!e) return 'Ошибка';
  if (e.code === 'AI_CAP') return 'Дневной лимит ИИ исчерпан. Попробуйте завтра. Ваш текст сохранён.';
  if (e.status === 429) return 'Слишком много запросов. Подождите минуту. Ваш текст сохранён.';
  if (e.status === 503 || e.code === 'AI_UNAVAILABLE') return 'ИИ сейчас недоступен. Ваш текст сохранён, попробуйте позже.';
  if (e.status === 502) return 'ИИ вернул некорректный ответ. Попробуйте ещё раз.';
  return e.message || 'Не удалось выполнить запрос';
}

function loadTask() {
  try {
    const t = JSON.parse(lsGet(LS_TASK) || 'null');
    if (t && typeof t === 'object' && Number.isInteger(t.id) && typeof t.prompt_ru === 'string') return t;
  } catch { /* битый кеш */ }
  return null;
}

function hintList(words) {
  if (!Array.isArray(words) || !words.length) return null;
  const items = words.map((w) => (w && typeof w.display === 'string' ? w.display : '')).filter(Boolean);
  return items.length ? h('p', { class: 'muted', text: 'Полезные слова: ' + items.join(', ') }) : null;
}

export function mount(container, ctx = {}) {
  const settings = ctx.settings || {};
  let alive = true;
  let timer = null;
  const root = h('div', { class: 'retell-view stack' });
  container.replaceChildren(root);

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  // ---------- настройка ----------
  function renderSetup(note) {
    stopTimer();
    const topicSel = h('select', { id: 'rt-topic', class: 'input' },
      h('option', { value: 'random', text: 'Случайная тема' }),
      TOPICS.map((t) => h('option', { value: t, text: t })));
    const levelSel = h('select', { id: 'rt-level', class: 'input' },
      ['B1', 'B2', 'C1'].map((l) => h('option', { value: l, text: l, selected: l === 'B2' })));
    const sentSel = h('select', { id: 'rt-sent', class: 'input' },
      [5, 6, 7, 8, 9, 10].map((n) => h('option', { value: n, text: `${n} предложений`, selected: n === 7 })));
    const provSel = h('select', { id: 'rt-prov', class: 'input' },
      AI_OPTIONS.map(([v, l]) => h('option', { value: v, text: l })));
    const hintChk = h('input', { type: 'checkbox', id: 'rt-hint' });
    const status = h('p', { class: 'muted', role: 'status', text: note || '' });
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Получить текст' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      status.textContent = 'Готовлю текст…';
      try {
        const reqBody = {
          topic: topicSel.value, level: levelSel.value,
          sentences: Number(sentSel.value), use_due_words: hintChk.checked,
        };
        if (provSel.value !== 'auto') reqBody.provider = provSel.value;
        const task = await retellTask(reqBody);
        if (!alive) return;
        if (!task || !Number.isInteger(task.id) || typeof task.prompt_ru !== 'string') throw new Error('Некорректный ответ сервера');
        const cur = {
          id: task.id, topic: task.topic, level: task.level, prompt_ru: task.prompt_ru,
          hint_words: Array.isArray(task.hint_words) ? task.hint_words : [], min_words: num(task.min_words, 0, 1000),
          provider: provSel.value, startedAt: Date.now()
        };
        lsSet(LS_TASK, JSON.stringify(cur));
        renderWrite(cur);
      } catch (e) {
        if (!alive) return;
        status.textContent = errMsg(e);
        go.disabled = false;
      }
    });
    root.replaceChildren(
      h('h2', { text: 'Пересказ' }),
      h('p', { class: 'muted', text: 'Прочитайте русский текст и перескажите его по-немецки своими словами. Не нужно переводить дословно: важно передать смысл.' }),
      h('label', { for: 'rt-topic', text: 'Тема' }), topicSel,
      h('label', { for: 'rt-level', text: 'Уровень' }), levelSel,
      h('label', { for: 'rt-sent', text: 'Длина' }), sentSel,
      h('label', { for: 'rt-prov', text: 'Модель ИИ' }), provSel,
      h('label', {}, hintChk, ' Показать полезные слова из моих карточек'),
      status, go,
    );
  }

  // ---------- письмо ----------
  function renderWrite(task) {
    const key = draftKey(task.id);
    const ta = h('textarea', {
      class: 'input', id: 'rt-text', rows: 10, maxlength: 3000, lang: 'de',
      spellcheck: 'false', autocapitalize: 'sentences', 'aria-label': 'Ваш текст по-немецки'
    });
    ta.value = lsGet(key) || '';
    const counter = h('span', { class: 'muted' });
    const clock = h('span', { class: 'muted' });
    const status = h('p', { class: 'muted', role: 'status' });
    const submit = h('button', { class: 'btn primary', type: 'button', text: 'Завершить и проверить' });

    const upd = () => {
      const w = countWords(ta.value);
      counter.textContent = `Слов: ${w}${task.min_words ? ' из ' + task.min_words : ''}`;
    };
    let saveT = null;
    ta.addEventListener('input', () => {
      upd();
      clearTimeout(saveT);
      saveT = setTimeout(() => lsSet(key, ta.value), 400);
    });
    const tick = () => {
      const s = Math.max(0, Math.round((Date.now() - (task.startedAt || Date.now())) / 1000));
      clock.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick(); upd();
    timer = setInterval(tick, 1000);

    submit.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text.length < 30) { status.textContent = 'Напишите хотя бы 30 символов.'; return; }
      lsSet(key, ta.value);
      submit.disabled = true; ta.disabled = true;
      status.textContent = 'Проверяю (это может занять до минуты)…';
      const seconds = Math.max(0, Math.round((Date.now() - (task.startedAt || Date.now())) / 1000));
      try {
        const evalBody = { task_id: task.id, text: text.slice(0, 3000), seconds };
        if (task.provider && task.provider !== 'auto') evalBody.provider = task.provider;
        const res = await retellEvaluate(evalBody);
        if (!alive) return;
        stopTimer();
        lsDel(key); lsDel(LS_TASK);
        renderResult(res, text, task);
      } catch (e) {
        if (!alive) return;
        if (e && e.status === 409) {
          stopTimer(); lsDel(key); lsDel(LS_TASK);
          renderSetup('Этот текст уже был проверен. Возьмите новый.');
          return;
        }
        status.textContent = errMsg(e);
        submit.disabled = false; ta.disabled = false;
      }
    });

    root.replaceChildren(
      h('h2', { text: 'Пересказ' }),
      h('div', { class: 'card-box' }, h('p', { text: task.prompt_ru, style: 'white-space:pre-wrap' })),
      hintList(task.hint_words),
      ta,
      h('div', { class: 'row' }, counter, ' · ', clock),
      status,
      h('div', { class: 'row' }, submit,
        h('button', {
          class: 'btn', type: 'button', text: 'Отменить', onclick: () => {
            if (!confirm('Выбросить этот текст и черновик?')) return;
            stopTimer(); lsDel(key); lsDel(LS_TASK); renderSetup();
          }
        })),
    );
    try { ta.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ---------- результат ----------
  function bar(label, value) {
    const v = num(value, 0, 5);
    const pct = Math.round((v / 5) * 100);
    return h('div', { class: 'row', style: 'gap: var(--s3);' },
      h('span', { text: `${label}: ${v}/5`, style: 'min-width:9rem; font-size:var(--fs-sm);' }),
      h('div', { class: 'progress', style: 'flex:1;' },
        h('div', { class: 'progress-fill', style: `width:${pct}%` })));
  }

  function renderDiff(userText, corrected) {
    const box = h('p', { style: 'white-space:pre-wrap;line-height:var(--lh-read)' });
    let diff = null;
    try { diff = gradeSentence(userText, corrected).diff; } catch { diff = null; }
    if (!Array.isArray(diff)) { box.textContent = corrected; return box; }
    for (const d of diff) {
      if (!d || typeof d.w !== 'string') continue;
      if (d.t === 'del') box.append(h('del', { class: 'd-del', text: `[−${d.w}]` }), ' ');
      else if (d.t === 'ins') box.append(h('ins', { class: 'd-ins', text: `[+${d.w}]` }), ' ');
      else box.append(d.w + ' ');
    }
    return box;
  }

  function renderResult(r, userText, task) {
    const res = r && typeof r === 'object' ? r : {};
    const crit = res.criteria && typeof res.criteria === 'object' ? res.criteria : {};
    const kps = Array.isArray(res.key_points) ? res.key_points : [];
    const imps = Array.isArray(res.improvements_ru) ? res.improvements_ru : [];
    const modelBox = h('div', { hidden: true }, h('p', { text: String(res.model_text || ''), style: 'white-space:pre-wrap' }));
    const modelBtn = h('button', { class: 'btn sm', type: 'button', text: 'Показать образец' });
    modelBtn.addEventListener('click', () => {
      modelBox.hidden = !modelBox.hidden;
      modelBtn.textContent = modelBox.hidden ? 'Показать образец' : 'Скрыть образец';
    });
    const errBox = h('div');
    renderErrors(errBox, res.errors, { sentence: undefined });

    root.replaceChildren(
      h('div', { class: 'card-box stack' },
        h('div', { class: 'score-big', text: `${num(res.score, 0, 100)}` }),
        h('div', { class: 'stat-label', text: 'из 100 баллов' }),
        h('p', { class: 'muted', text: 'Оценка внутренняя, не по шкале Goethe. Слов в тексте: ' + countWords(userText) }),
      ),
      h('div', { class: 'stack', style: 'margin-top: var(--s3);' }, Object.keys(CRIT_RU).map((k) => bar(CRIT_RU[k], crit[k]))),
      h('h3', { text: 'Ключевые мысли' }),
      kps.length ? h('ul', {}, kps.map((k) => h('li', {},
        (k && k.conveyed ? '✓ ' : '✗ '), String((k && k.text_ru) || ''),
        k && k.comment_ru ? h('span', { class: 'muted', text: ' — ' + String(k.comment_ru) }) : null)))
        : h('p', { class: 'muted', text: 'Нет данных.' }),
      h('h3', { text: 'Ваш текст с правками' }),
      res.corrected_text ? renderDiff(userText, String(res.corrected_text)) : h('p', { class: 'muted', text: 'Правок нет.' }),
      h('h3', { text: 'Ошибки' }),
      errBox,
      imps.length ? h('h3', { text: 'Над чем поработать' }) : null,
      imps.length ? h('ul', {}, imps.slice(0, 3).map((t) => h('li', { text: String(t) }))) : null,
      res.model_text ? modelBtn : null, modelBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', text: 'Новый текст', onclick: () => renderSetup() }),
        h('button', { class: 'btn', type: 'button', text: 'На главную', onclick: () => (ctx.navigate || nav)('#/today') })),
    );
  }

  const saved = loadTask();
  if (saved) renderWrite(saved); else renderSetup();

  return () => { alive = false; stopTimer(); };
}

export default mount;