// #/text/:id: чтение с нажимаемыми словами, вопросами и сохранением попытки.
// Экспортирует renderTappableText для listen.js и lab.js.
import { h, navigate } from '../app.js';
import { getText, postTextAttempt, generateTextGaps } from '../api2.js';
import { mountQuiz } from '../ui/quiz.js';
import { openLookup } from '../ui/lookup.js';
import { describeError, routeId } from './texts.js';

const TOKEN_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*|[^\p{L}\p{M}]+/gu;
const WORD_START = /^[\p{L}\p{M}]/u;

export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Предложение из строки, содержащее слово (контекст для словаря, до 200 символов) */
function sentenceAround(line, word) {
  const parts = String(line).match(/[^.!?…]+[.!?…]*/g) || [String(line)];
  const hit = parts.find((p) => p.includes(word)) || parts[0] || '';
  return hit.trim().slice(0, 200);
}

/**
 * Вывести текст с нажимаемыми словами (нажатие открывает словарь).
 * @param {HTMLElement} host
 * @param {string} text
 * @param {{dialogue?: boolean}} [opts] dialogue: строки «Имя: реплика», имя не нажимается
 */
export function renderTappableText(host, text, opts = {}) {
  const paras = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let speaker = null;
    let rest = line;
    if (opts.dialogue) {
      const m = /^([^:]{1,40}):\s*(.*)$/.exec(line);
      if (m) { speaker = m[1].trim(); rest = m[2]; }
    }
    const p = h('p', { class: 'reader-line' });
    if (speaker) p.append(h('strong', { text: `${speaker}: ` }));
    for (const tok of rest.match(TOKEN_RE) || []) {
      if (WORD_START.test(tok)) {
        const s = h('span', { class: 'word', role: 'button', tabindex: '0', 'data-w': tok, text: tok });
        s.style.cursor = 'pointer';
        s.style.textDecoration = 'underline dotted';
        s.style.textUnderlineOffset = '3px';
        p.append(s);
      } else {
        p.append(document.createTextNode(tok));
      }
    }
    p._line = rest;
    paras.push(p);
  }
  host.replaceChildren(...paras);
  const open = (target) => {
    const el = target && target.closest ? target.closest('[data-w]') : null;
    if (!el) return;
    const word = (el.getAttribute('data-w') || '').replace(/^['’-]+|['’-]+$/g, '').slice(0, 60);
    if (!word) return;
    const line = el.closest('p');
    try { openLookup(word, sentenceAround(line && line._line ? line._line : '', word), opts.glossary); } catch { /* словарь недоступен */ }
  };
  host.onclick = (e) => open(e.target);
  host.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e.target); }
  };
}

function errorBox(msg, retry) {
  return h('div', { class: 'card-box stack center' },
    h('p', { class: 'error', text: msg }),
    retry ? h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: retry }) : null,
    h('a', { class: 'btn', href: '#/texts', text: 'К списку текстов' }));
}

export async function mount(container, ctx) {
  let timerId = null;
  const cleanup = () => { if (timerId) clearInterval(timerId); timerId = null; };
  const id = routeId(ctx, 'text');
  if (!id) { container.append(errorBox('Текст не найден.')); return cleanup; }

  container.append(h('p', { class: 'muted center', text: 'Загрузка…' }));
  let item;
  try {
    item = await getText(id);
  } catch (e) {
    container.replaceChildren(errorBox(describeError(e), () => navigate(location.hash)));
    return cleanup;
  }
  if (!item || typeof item.body !== 'string') {
    container.replaceChildren(errorBox('Не удалось открыть текст.'));
    return cleanup;
  }

  const questions = Array.isArray(item.questions) ? item.questions : [];
  let secs = 0;
  let finished = false;
  let showTimer = false;
  const timerEl = h('span', { class: 'chip', text: '00:00', hidden: true });
  const timerToggle = h('input', {
    type: 'checkbox',
    onchange: () => { showTimer = timerToggle.checked; timerEl.hidden = !showTimer; },
  });
  // Считаем активные секунды: только пока вкладка видима
  timerId = setInterval(() => {
    if (document.hidden || finished) return;
    secs++;
    if (showTimer) timerEl.textContent = fmtClock(secs);
  }, 1000);

  const textHost = h('div', { class: 'card-box stack' });
  const gapHost = h('div', { class: 'stack' });
  const quizHost = h('div', { class: 'stack' });
  const resultHost = h('div', { class: 'stack' });
  renderTappableText(textHost, item.body, { glossary: item.glossary });

  function renderGapExercise(data) {
    const options = Array.isArray(data?.options) ? data.options : [];
    const gaps = Array.isArray(data?.gaps) ? data.gaps : [];
    const letters = options.map((_, i) => String.fromCharCode(65 + i));
    const selects = new Map();
    const feedbackEls = new Map();

    const gappedBox = h('div', { class: 'card-box stack' },
      h('h3', { text: 'Текст с пропусками (Lesen Teil 2 — Коннекторы и логика текста)' }),
      h('p', { class: 'muted', text: 'Подберите пропущенные предложения (A–G), обращая внимание на союзы и коннекторы (deshalb, trotzdem, dennoch, allerdings).' }),
      h('div', { lang: 'de', style: 'white-space: pre-wrap; line-height: 1.65;' }, String(data?.gapped_body || ''))
    );

    const optList = h('div', { class: 'card-box stack' },
      h('strong', { text: 'Варианты предложений (2 лишних):' }),
      ...options.map((opt, idx) => h('div', { lang: 'de', style: 'padding: 4px 0;' },
        h('strong', { text: `${letters[idx]}) ` }),
        opt
      ))
    );

    const rowsBox = h('div', { class: 'card-box stack' });
    for (const g of gaps) {
      const sel = h('select', { class: 'input', style: 'max-width: 140px;' },
        h('option', { value: '', text: '— выбор —' }),
        ...letters.map((L, idx) => h('option', { value: String(idx), text: `Вариант ${L}` }))
      );
      const fb = h('div', { class: 'muted', hidden: true });
      selects.set(g.num, sel);
      feedbackEls.set(g.num, fb);
      rowsBox.append(
        h('div', { class: 'stack', style: 'border-bottom: 1px solid var(--border); padding-bottom: 8px;' },
          h('div', { class: 'row', style: 'align-items: center; gap: 10px;' },
            h('strong', { text: `Пропуск [${g.num}]:` }),
            sel
          ),
          fb
        )
      );
    }

    const scoreMsg = h('p', { role: 'status' });
    const checkBtn = h('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Проверить вставку предложений',
      onclick: () => {
        let okCount = 0;
        for (const g of gaps) {
          const sel = selects.get(g.num);
          const fb = feedbackEls.get(g.num);
          const picked = sel && sel.value !== '' ? Number(sel.value) : -1;
          const correct = picked === g.answer_index;
          if (correct) okCount += 1;
          const corrLetter = letters[g.answer_index] || '?';
          fb.hidden = false;
          fb.textContent = (correct ? `✓ Верно (${corrLetter}). ` : `✗ Неверно. Правильный ответ: ${corrLetter}. `)
            + (g.connector ? `[Коннектор: ${g.connector}] ` : '')
            + (g.explanation_ru || '');
        }
        scoreMsg.textContent = `Результат вставки предложений: ${okCount} из ${gaps.length}`;
      },
    });
    const backReadBtn = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Показать полный текст',
      onclick: () => { textHost.hidden = false; },
    });

    textHost.hidden = true;
    gapHost.replaceChildren(gappedBox, optList, rowsBox, h('div', { class: 'actions' }, checkBtn, backReadBtn), scoreMsg);
  }

  const gapBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: '🧩 Упражнение: Вставка предложений и коннекторов (Lesen B2)',
    onclick: async () => {
      gapBtn.disabled = true;
      gapBtn.textContent = 'Готовлю упражнение с коннекторами…';
      try {
        const data = item.gap_exercises || await generateTextGaps(id);
        item.gap_exercises = data;
        renderGapExercise(data);
        gapBtn.hidden = true;
      } catch (e) {
        gapBtn.disabled = false;
        gapBtn.textContent = '🧩 Упражнение: Вставка предложений и коннекторов (Lesen B2)';
        gapHost.replaceChildren(h('p', { class: 'error', text: describeError(e) }));
      }
    },
  });

  container.replaceChildren(
    h('a', { href: '#/texts', text: '← Тексты' }),
    h('h2', { text: String(item.title || 'Текст') }),
    h('p', { class: 'muted', text: [item.level, item.topic, item.word_count ? `${item.word_count} слов` : ''].filter(Boolean).join(' · ') }),
    h('div', { class: 'actions' }, h('label', null, timerToggle, ' Таймер '), timerEl, gapBtn),
    h('p', { class: 'muted', text: 'Нажмите на слово, чтобы увидеть перевод.' }),
    textHost, gapHost, quizHost, resultHost);

  /** Сохранить попытку; при ошибке показать «Повторить» (результат квиза не теряется) */
  let submitting = false;
  async function submit(payload) {
    if (submitting) return;
    submitting = true;
    resultHost.replaceChildren(h('p', { class: 'muted center', text: 'Сохраняем результат…' }));
    try {
      const r = await postTextAttempt(id, payload);
      const line = r && Number.isFinite(r.total) && r.total > 0
        ? `Результат сохранён: ${r.correct} из ${r.total}`
        : 'Чтение засчитано.';
      resultHost.replaceChildren(h('div', { class: 'card-box stack center' },
        h('p', null, h('strong', { text: line })),
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: `#/lab?text=${id}`, text: 'Анализ слов' }),
          h('a', { class: 'btn', href: '#/texts', text: 'Все тексты' }),
          h('a', { class: 'btn primary', href: '#/texts?new=1', text: 'Новый текст' }))));
    } catch (e) {
      resultHost.replaceChildren(h('div', { class: 'card-box stack center' },
        h('p', { class: 'error', text: `Не удалось сохранить: ${describeError(e)}` }),
        h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: () => { submitting = false; submit(payload); } })));
      return;
    }
    submitting = false;
  }

  const seconds = () => Math.min(14400, Math.max(0, secs));

  (async () => {
    if (questions.length) {
      const res = await mountQuiz(quizHost, questions, { revealAfter: 'end' });
      finished = true;
      await submit({ mode: 'read', answers: res.answers, seconds: seconds() });
    } else {
      resultHost.replaceChildren(h('button', {
        class: 'btn primary', type: 'button', text: 'Я прочитал(а)',
        onclick: () => { finished = true; submit({ mode: 'read', answers: [], seconds: seconds() }); },
      }));
    }
  })().catch(() => { /* ошибки показаны внутри */ });

  return cleanup;
}
