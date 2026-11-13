// Режим ru_de (v2): лёгкий — 4 варианта; средний — ввод с лесенкой подсказок;
// сложный — ввод без подсказок + второй шаг (предложение уходит в корзину, не оценивается сразу)
import { h, POS_RU, displayTerm } from '../app.js';
import { makeHint, MAX_HINT_STEP } from '/shared/hints.js';
import { gradeSentence } from '/shared/grading.js';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const HINT_LABELS = ['💡 Подсказка', '💡 Ещё подсказка', '👁 Показать ответ'];

/** Ожидаемый ответ по контракту */
export function expected(item) {
  const c = (item && item.card) || {};
  return c.pos === 'noun' && c.article ? `${c.article} ${c.term}` : String(c.term || '');
}

/** Текущая сложность из ctx (по умолчанию medium) */
export function difficultyOf(ctx) {
  const d = ctx && (ctx.difficulty || (ctx.settings && ctx.settings.difficulty));
  return ['easy', 'medium', 'hard'].includes(d) ? d : 'medium';
}

/** Оценка через ctx.grade с запасным вариантом */
export function safeGrade(ctx, answer, exp) {
  try {
    const g = ctx.grade(answer, exp);
    if (g && ['correct', 'almost', 'wrong'].includes(g.result)) return g.result;
  } catch { /* ниже запасное сравнение */ }
  return norm(answer) === norm(exp) ? 'correct' : 'wrong';
}

/** Проверка item.choices: строки без повторов, минимум 2, среди них есть правильная; иначе null (ввод текстом) */
export function validChoices(item, correctForms) {
  const raw = item && item.choices;
  if (!Array.isArray(raw)) return null;
  const list = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim() && !list.includes(x)) list.push(x);
  }
  if (list.length < 2) return null;
  const ok = new Set(correctForms.map(norm));
  if (!list.some((x) => ok.has(norm(x)))) return null;
  return list.slice(0, 6);
}

/** Кнопки ä ö ü ß */
export function keypadFor(input, isDone) {
  return h('div', { class: 'keypad' }, ['ä', 'ö', 'ü', 'ß'].map((ch) => h('button', {
    class: 'btn key', type: 'button', text: ch, 'aria-label': 'Вставить ' + ch,
    onmousedown: (e) => e.preventDefault(),
    onclick: () => {
      if (isDone()) return;
      const s = input.selectionStart ?? input.value.length;
      const e2 = input.selectionEnd ?? s;
      input.setRangeText(ch, s, e2, 'end');
      input.focus();
    },
  })));
}

/**
 * Выбор из вариантов (лёгкий режим). Клавиши 1–4 тоже работают.
 * @returns {Promise<{result, userAnswer, responseMs, hints}>}
 */
export function mountChoices(container, { choices, correctForms }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ok = new Set(correctForms.map(norm));
    let done = false;

    const btns = choices.map((c, i) => h('button', {
      class: 'btn block', type: 'button', lang: 'de', onclick: () => pick(c),
    }, h('span', { class: 'muted', text: String(i + 1) + '.' }), ' ', c));

    function onKey(e) {
      if (done || !container.isConnected) { document.removeEventListener('keydown', onKey); return; }
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) { e.preventDefault(); pick(choices[n - 1]); }
    }
    function pick(c) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      btns.forEach((b) => { b.disabled = true; });
      resolve({
        result: ok.has(norm(c)) ? 'correct' : 'wrong',
        userAnswer: c,
        responseMs: Math.round(performance.now() - t0),
        hints: 0,
      });
    }

    container.append(h('div', { class: 'stack' }, btns));
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Ввод текста (средний/сложный). hints=true — лесенка подсказок (3-я ступень = показать ответ = ошибка).
 * Enter отправляет ответ, «go» на мобильной клавиатуре тоже.
 */
export function mountTyped(container, o) {
  const { expected: exp, ctx, label = 'Ваш ответ', hints = false } = o;
  return new Promise((resolve) => {
    const t0 = performance.now();
    let step = 0;
    let done = false;

    const input = h('input', {
      type: 'text', class: 'input answer', lang: 'de', autocomplete: 'off', autocapitalize: 'off',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: label, 'aria-label': label,
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); trySubmit(); } },
    });
    const hintBox = h('div', { class: 'hint muted center', hidden: true, 'aria-live': 'polite' });
    const hintBtn = hints ? h('button', { class: 'btn', type: 'button', text: HINT_LABELS[0], onclick: onHint }) : null;
    const giveUpBtn = h('button', { class: 'btn', type: 'button', text: 'Не знаю', onclick: () => finish('', true, false) });
    const submitBtn = h('button', { class: 'btn primary', type: 'button', text: 'Проверить', onclick: trySubmit });
    const keypad = keypadFor(input, () => done);
    const actions = h('div', { class: 'actions' }, hintBtn, giveUpBtn, submitBtn);
    actions.style.gridTemplateColumns = hints ? '1fr 1fr 2fr' : '1fr 2fr';

    function onHint() {
      if (done || step >= MAX_HINT_STEP) return;
      step += 1;
      if (typeof ctx.registerHint === 'function') ctx.registerHint();
      if (step >= MAX_HINT_STEP) { finish(input.value.trim(), false, true); return; } // раскрытие = ошибка
      let text = '';
      try { text = makeHint(exp, step); } catch { text = ''; }
      hintBox.hidden = false;
      hintBox.textContent = text;
      hintBtn.textContent = HINT_LABELS[step];
      input.focus();
    }

    function trySubmit() {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      finish(v, false, false);
    }

    function finish(answer, giveUp, revealed) {
      if (done) return;
      done = true;
      const responseMs = Math.round(performance.now() - t0);
      [input, giveUpBtn, submitBtn, hintBtn].forEach((el) => { if (el) el.disabled = true; });
      keypad.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const result = giveUp || revealed ? 'wrong' : safeGrade(ctx, answer, exp);
      const fromCtx = typeof ctx.hintsUsed === 'function' ? Number(ctx.hintsUsed()) || 0 : 0;
      resolve({
        result,
        userAnswer: giveUp ? '' : answer,
        responseMs,
        hints: revealed ? MAX_HINT_STEP : Math.min(MAX_HINT_STEP - 1, Math.max(step, fromCtx)),
      });
    }

    container.append(h('div', { class: 'stack' }, input, hintBox, keypad, actions));
    input.focus({ preventScroll: true });
  });
}

/**
 * Второй шаг сложного режима: русский пример -> немецкое предложение.
 * Не оценивается: нейтральный отзыв + справка о совпадении с эталоном (gradeSentence).
 * @returns {Promise<{answer:string, identical:boolean}|null>} null — пропущено
 */
function sentenceStep(host, item, ctx) {
  const c = item.card || {};
  return new Promise((resolve) => {
    let done = false;
    const input = h('textarea', {
      class: 'input answer', lang: 'de', rows: 3, autocomplete: 'off', autocapitalize: 'sentences',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go',
      placeholder: 'Предложение по-немецки', 'aria-label': 'Перевод предложения',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
    });
    const keypad = keypadFor(input, () => done);

    function submit() {
      if (done) return;
      const answer = input.value.trim();
      if (!answer) { input.focus(); return; }
      done = true;
      let identical = false;
      try {
        const g = gradeSentence(answer, c.example);
        identical = !!g && g.result === 'correct';
      } catch { identical = false; }
      waitNext({ answer, identical });
    }

    function waitNext(value) {
      const shownAt = performance.now();
      const autoMs = Math.min(5000, Math.max(0, Math.round(Number(ctx.settings && ctx.settings.auto_next_ms) || 0)));
      let timer = null;
      let closed = false;
      const next = h('button', { class: 'btn primary block next-btn', type: 'button', text: 'Далее', onclick: close });
      function close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      }
      function onKey(e) {
        if (!host.isConnected) { close(); return; }
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
        if (performance.now() - shownAt < 400) return;
        if (e.key === 'Enter') { e.preventDefault(); close(); }
      }
      host.replaceChildren(
        h('div', { class: 'feedback' },
          h('div', { class: 'fb-title', text: '📝 Записано, проверим в конце' }),
          h('div', { class: 'fb-note', text: value.identical
            ? 'Для справки: совпало с эталоном.'
            : 'Для справки: с эталоном не совпало — это нормально, проверка в конце оценит смысл и грамматику.' })),
        next
      );
      document.addEventListener('keydown', onKey);
      if (value.identical && autoMs > 0) timer = setTimeout(close, autoMs);
      host.addEventListener('pointerdown', () => { clearTimeout(timer); }, { once: true });
    }

    host.append(
      h('div', { class: 'card-box stack center' },
        h('div', { class: 'muted', text: 'Теперь переведите предложение на немецкий' }),
        h('div', { class: 'prompt cloze', text: c.example_translation || '' })),
      h('div', { class: 'stack' }, input, keypad,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', text: 'Пропустить', onclick: () => { if (!done) { done = true; resolve(null); } } }),
          h('button', { class: 'btn primary', type: 'button', text: 'Записать', onclick: submit })))
    );
    host.querySelector('.actions').style.gridTemplateColumns = '1fr 2fr';
    input.focus({ preventScroll: true });
  });
}

export async function mount(container, item, ctx) {
  const c = item.card || {};
  const exp = expected(item);
  if (!exp || !c.translation) throw new Error('bad ru_de card');
  const diff = difficultyOf(ctx);

  container.append(
    h('div', { class: 'card-box stack center' },
      h('div', { class: 'muted', text: diff === 'easy' ? 'Выберите перевод на немецкий' : 'Переведите на немецкий' }),
      h('div', { class: 'prompt', text: c.translation }),
      h('div', { class: 'row center wrap' },
        c.pos ? h('span', { class: 'chip', text: POS_RU[c.pos] || c.pos }) : null,
        c.pos === 'noun' ? h('span', { class: 'chip', text: 'с артиклем' }) : null,
        c.rektion ? h('span', { class: 'chip', text: `Управление: ${c.rektion}` }) : null)
    )
  );

  let first;
  const choices = diff === 'easy' ? validChoices(item, [exp, displayTerm(c)]) : null;
  if (choices) first = await mountChoices(container, { choices, correctForms: [exp, displayTerm(c)] });
  else first = await mountTyped(container, { expected: exp, ctx, hints: diff !== 'hard' });

  // Сложный режим: после слова — предложение (только если слово не пропущено и это не повтор)
  if (diff === 'hard' && c.example && c.example_translation && !item._requeued && String(first.userAnswer).trim()) {
    first.followUp = (host) => sentenceStep(host, item, ctx);
  }
  return first;
}