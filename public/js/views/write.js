// Свободное письмо в стиле Goethe (форум, письма, мнение). Один вызов ИИ на оценку.
import { h, navigate as nav } from '../app.js';
import { writingTask, writingEvaluate } from '../api2.js';
import { gradeSentence } from '/shared/grading.js';
import { renderErrors } from '../ui/error_list.js';

const LS_TASK = 'write_current';
const draftKey = (id) => `write_draft_${id}`;
const TYPES = [
  ['forum', 'Пост на форуме (мнение)'], ['letter_formal', 'Официальное письмо'],
  ['letter_informal', 'Неформальное письмо'], ['opinion', 'Высказывание мнения'],
];
const AI_OPTIONS = [
  ['auto', 'Авто (Gemini по умолчанию)'],
  ['gemini:strong', 'Gemini Strong (Pro)'],
  ['gemini:fast', 'Gemini Fast (Flash)'],
  ['groq:strong', 'Groq Strong (Llama 70B)'],
  ['groq:fast', 'Groq Fast (Llama 8B)'],
  ['openrouter', 'OpenRouter'],
];
const CRIT_RU = { task: 'Задание', coherence: 'Связность', vocabulary: 'Лексика', grammar: 'Грамматика' };

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
    if (t && typeof t === 'object' && Number.isInteger(t.id) && typeof t.prompt_de === 'string') return t;
  } catch { /* битый кеш */ }
  return null;
}

export function mount(container, ctx = {}) {
  let alive = true;
  let timer = null;
  const root = h('div', { class: 'write-view stack' });
  container.replaceChildren(root);
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  function renderSetup(note) {
    stopTimer();
    const typeSel = h('select', { id: 'wr-type', class: 'input' },
      TYPES.map(([v, l]) => h('option', { value: v, text: l })));
    const topic = h('input', { id: 'wr-topic', class: 'input', type: 'text', maxlength: 80, placeholder: 'Тема (необязательно)' });
    const provSel = h('select', { id: 'wr-prov', class: 'input' },
      AI_OPTIONS.map(([v, l]) => h('option', { value: v, text: l })));
    const status = h('p', { class: 'muted', role: 'status', text: note || '' });
    const go = h('button', { class: 'btn primary', type: 'button', text: 'Получить задание' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      status.textContent = 'Готовлю задание…';
      try {
        const body = { type: typeSel.value };
        const tp = topic.value.trim();
        if (tp) body.topic = tp.slice(0, 80);
        if (provSel.value !== 'auto') body.provider = provSel.value;
        const t = await writingTask(body);
        if (!alive) return;
        if (!t || !Number.isInteger(t.id) || typeof t.prompt_de !== 'string') throw new Error('Некорректный ответ сервера');
        const cur = {
          id: t.id, type: t.type, prompt_de: t.prompt_de,
          bullets_de: Array.isArray(t.bullets_de) ? t.bullets_de.filter((x) => typeof x === 'string') : [],
          min_words: num(t.min_words, 0, 1000), provider: provSel.value, startedAt: Date.now()
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
      h('h2', { text: 'Письмо' }),
      h('p', { class: 'muted', text: 'Задания похожи на Goethe B2. Актуальный формат экзамена проверяйте на сайте Goethe-Institut.' }),
      h('label', { for: 'wr-type', text: 'Тип задания' }), typeSel, topic,
      h('label', { for: 'wr-prov', text: 'Модель ИИ' }), provSel,
      status, go,
    );
  }

  function renderWrite(task) {
    const key = draftKey(task.id);
    const ta = h('textarea', {
      class: 'input', id: 'wr-text', rows: 12, maxlength: 3000, lang: 'de',
      spellcheck: 'false', autocapitalize: 'sentences', 'aria-label': 'Ваш текст по-немецки'
    });
    ta.value = lsGet(key) || '';
    const counter = h('span', { class: 'muted' });
    const clock = h('span', { class: 'muted' });
    const status = h('p', { class: 'muted', role: 'status' });
    const submit = h('button', { class: 'btn primary', type: 'button', text: 'Завершить и проверить' });
    const upd = () => {
      counter.textContent = `Слов: ${countWords(ta.value)}${task.min_words ? ' из ' + task.min_words : ''}`;
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
        const res = await writingEvaluate(evalBody);
        if (!alive) return;
        stopTimer();
        lsDel(key); lsDel(LS_TASK);
        renderResult(res, text);
      } catch (e) {
        if (!alive) return;
        if (e && e.status === 409) {
          stopTimer(); lsDel(key); lsDel(LS_TASK);
          renderSetup('Это задание уже было проверено. Возьмите новое.');
          return;
        }
        status.textContent = errMsg(e);
        submit.disabled = false; ta.disabled = false;
      }
    });

    root.replaceChildren(
      h('h2', { text: 'Письмо' }),
      h('div', { class: 'card-box stack' },
        h('p', { text: task.prompt_de, style: 'white-space:pre-wrap' }),
        task.bullets_de.length ? h('ul', {}, task.bullets_de.map((b) => h('li', { text: b }))) : null),
      ta,
      h('div', { class: 'row' }, counter, ' · ', clock),
      status,
      h('div', { class: 'row' }, submit,
        h('button', {
          class: 'btn', type: 'button', text: 'Отменить', onclick: () => {
            if (!confirm('Выбросить это задание и черновик?')) return;
            stopTimer(); lsDel(key); lsDel(LS_TASK); renderSetup();
          }
        })),
    );
    try { ta.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  function renderDiff(userText, corrected) {
    const box = h('p', { style: 'white-space:pre-wrap;line-height:1.7' });
    let diff = null;
    try { diff = gradeSentence(userText, corrected).diff; } catch { diff = null; }
    if (!Array.isArray(diff)) { box.textContent = corrected; return box; }
    for (const d of diff) {
      if (!d || typeof d.w !== 'string') continue;
      if (d.t === 'del') box.append(h('del', { text: `[−${d.w}]` }), ' ');
      else if (d.t === 'ins') box.append(h('ins', { text: `[+${d.w}]` }), ' ');
      else box.append(d.w + ' ');
    }
    return box;
  }

  function renderResult(r, userText) {
    const res = r && typeof r === 'object' ? r : {};
    const crit = res.criteria && typeof res.criteria === 'object' ? res.criteria : {};
    const imps = Array.isArray(res.improvements_ru) ? res.improvements_ru : [];
    const errBox = h('div');
    renderErrors(errBox, res.errors);
    root.replaceChildren(
      h('div', { class: 'card-box stack' },
        h('div', { class: 'score-big', text: `${num(res.score, 0, 100)}` }),
        h('div', { class: 'stat-label', text: 'из 100 баллов' }),
        h('p', { class: 'muted', text: 'Оценка внутренняя, не по шкале Goethe. Слов в тексте: ' + countWords(userText) }),
      ),
      h('div', { class: 'stack', style: 'margin-top: var(--s3);' }, Object.keys(CRIT_RU).map((k) => {
        const v = num(crit[k], 0, 5);
        const pct = Math.round((v / 5) * 100);
        return h('div', { class: 'row', style: 'gap: var(--s3);' },
          h('span', { text: `${CRIT_RU[k]}: ${v}/5`, style: 'min-width:9rem; font-size:var(--fs-sm);' }),
          h('div', { class: 'progress', style: 'flex:1;' },
            h('div', { class: 'progress-fill', style: `width:${pct}%` })));
      })),
      h('h3', { text: 'Ваш текст с правками' }),
      res.corrected_text ? renderDiff(userText, String(res.corrected_text)) : h('p', { class: 'muted', text: 'Правок нет.' }),
      h('h3', { text: 'Ошибки' }),
      errBox,
      imps.length ? h('h3', { text: 'Над чем поработать' }) : null,
      imps.length ? h('ul', {}, imps.slice(0, 3).map((t) => h('li', { text: String(t) }))) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', text: 'Новое задание', onclick: () => renderSetup() }),
        h('button', { class: 'btn', type: 'button', text: 'На главную', onclick: () => (ctx.navigate || nav)('#/today') })),
    );
  }

  const saved = loadTask();
  if (saved) renderWrite(saved); else renderSetup();

  return () => { alive = false; stopTimer(); };
}

export default mount;