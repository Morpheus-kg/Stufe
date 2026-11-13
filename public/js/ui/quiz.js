// Квиз по вопросам к тексту (tf / mc).
// mountQuiz(container, questions, {revealAfter, showEvidence}) -> Promise<{answers, correct, total}>
// Промис завершается, когда пользователь нажал «Завершить»; разбор остаётся в DOM.
import { h } from '../app.js';

/** Вопрос годится для показа (иначе пропускаем, ответ остаётся null) */
function validQuestion(q) {
  return !!q && typeof q === 'object' && typeof q.text === 'string' && Array.isArray(q.options)
    && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length;
}

const GREEN = '2px solid var(--success)';
const RED = '2px solid var(--danger)';

/**
 * @param {HTMLElement} container
 * @param {object[]} questions Question[] из контракта (id, type, text, options, answer, explanation_ru, evidence)
 * @param {{revealAfter?: 'each'|'end', showEvidence?: boolean}} [opts]
 */
export function mountQuiz(container, questions, opts = {}) {
  const list = Array.isArray(questions) ? questions : [];
  const mode = opts.revealAfter === 'each' ? 'each' : 'end';
  const showEvidence = opts.showEvidence !== false;
  const valid = list.map(validQuestion);
  const seq = list.map((_, i) => i).filter((i) => valid[i]);
  const answers = list.map(() => null);   // выровнены по исходному массиву вопросов
  const locked = new Set();               // вопросы, по которым уже показан разбор

  return new Promise((resolve) => {
    if (!seq.length) {
      container.replaceChildren(h('p', { class: 'muted', text: 'Вопросов к тексту нет.' }));
      resolve({ answers, correct: 0, total: 0 });
      return;
    }
    const box = h('div', { class: 'stack quiz' });
    container.replaceChildren(box);
    let finished = false;
    let onKeyRef = null;

    const stopKeys = () => {
      if (onKeyRef) document.removeEventListener('keydown', onKeyRef);
      onKeyRef = null;
    };

    /** Собрать карточку вопроса: {el, btns, fb} */
    function buildCard(qi, n, onPick) {
      const q = list[qi];
      const btns = q.options.map((opt, oi) => {
        const base = q.type === 'mc' ? `${String.fromCharCode(65 + oi)}) ${String(opt)}` : String(opt);
        const b = h('button', {
          class: 'btn', type: 'button', 'aria-pressed': 'false', text: base,
          onclick: () => onPick(qi, oi),
        });
        b._base = base;
        b.style.width = '100%';
        b.style.minHeight = '44px';
        b.style.textAlign = 'left';
        return b;
      });
      const fb = h('div', { class: 'feedback stack' });
      const el = h('div', { class: 'card-box stack' },
        h('p', null, h('strong', { text: `${n}. ${q.text}` })),
        h('div', { class: 'stack' }, btns),
        fb);
      return { el, btns, fb };
    }

    function setSelected(ref, oi) {
      ref.btns.forEach((b, i) => {
        const on = i === oi;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.textContent = (on ? '● ' : '') + b._base;
        b.style.border = on ? '2px solid var(--accent)' : '';
        b.style.background = on ? 'var(--accent-soft)' : '';
      });
    }

    function pick(qi, oi, ref, afterPick) {
      if (finished || locked.has(qi)) return;
      answers[qi] = oi;
      setSelected(ref, oi);
      if (mode === 'each') {
        reveal(qi, ref);
        if (afterPick) afterPick();
      }
    }

    /** Показать верный ответ, пояснение и фрагмент текста */
    function reveal(qi, ref) {
      if (locked.has(qi)) return;
      locked.add(qi);
      const q = list[qi];
      const a = answers[qi];
      ref.btns.forEach((b, oi) => {
        b.style.pointerEvents = 'none';
        if (oi === q.answer) {
          b.textContent = `✓ ${b._base}`;
          b.style.border = GREEN;
          b.style.background = 'var(--success-soft)';
          b.style.fontWeight = '600';
        } else if (oi === a) {
          b.textContent = `✗ ${b._base}`;
          b.style.border = RED;
          b.style.background = 'var(--danger-soft)';
        } else {
          b.textContent = b._base;
          b.style.border = '';
          b.style.background = '';
        }
      });
      const verdict = a === null ? 'Без ответа' : a === q.answer ? 'Верно' : 'Неверно';
      const parts = [h('p', null, h('strong', { text: verdict }))];
      if (typeof q.explanation_ru === 'string' && q.explanation_ru.trim()) {
        parts.push(h('p', { text: q.explanation_ru }));
      }
      if (showEvidence && typeof q.evidence === 'string' && q.evidence.trim()) {
        parts.push(h('p', { class: 'muted', text: `В тексте: «${q.evidence}»` }));
      }
      ref.fb.replaceChildren(...parts);
    }

    function finish() {
      if (finished) return;
      finished = true;
      stopKeys();
      let correct = 0;
      for (const qi of seq) if (answers[qi] === list[qi].answer) correct++;
      const total = seq.length;
      box.append(h('div', { class: 'card-box stack center' },
        h('p', null, h('strong', { text: `Результат: ${correct} из ${total}` }))));
      resolve({ answers: answers.slice(), correct, total });
    }

    // Ответы по цифрам 1..N и Enter работают только в режиме 'each'
    function bindKeys(handler) {
      onKeyRef = (e) => {
        if (!box.isConnected || finished) { stopKeys(); return; }
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        handler(e);
      };
      document.addEventListener('keydown', onKeyRef);
    }

    if (mode === 'each') {
      let pos = 0;
      let current = null;
      let nextBtn = null;
      const show = () => {
        const qi = seq[pos];
        const last = pos === seq.length - 1;
        const ref = buildCard(qi, pos + 1, (i, oi) => pick(i, oi, ref, () => { nextBtn.hidden = false; }));
        nextBtn = h('button', {
          class: 'btn primary', type: 'button', hidden: true,
          text: last ? 'Завершить' : 'Дальше', onclick: advance,
        });
        current = { qi, ref };
        box.replaceChildren(
          h('p', { class: 'muted', text: `Вопрос ${pos + 1} из ${seq.length}` }),
          ref.el, nextBtn);
      };
      const advance = () => {
        if (finished || !current || !locked.has(current.qi)) return;
        if (pos >= seq.length - 1) { finishEach(); return; }
        pos++;
        show();
      };
      const finishEach = () => {
        // Оставляем в DOM разбор последнего вопроса и добавляем итог
        if (nextBtn) nextBtn.remove();
        finish();
      };
      bindKeys((e) => {
        if (!current) return;
        if (e.key === 'Enter') {
          // На кнопке Enter сработает штатный click
          if (e.target && e.target.tagName === 'BUTTON') return;
          advance();
        } else if (/^[1-9]$/.test(e.key) && !locked.has(current.qi)) {
          const oi = Number(e.key) - 1;
          if (oi < list[current.qi].options.length) pick(current.qi, oi, current.ref, () => { nextBtn.hidden = false; });
        }
      });
      show();
    } else {
      const refs = new Map();
      const cards = seq.map((qi, k) => {
        const ref = buildCard(qi, k + 1, (i, oi) => pick(i, oi, ref, null));
        refs.set(qi, ref);
        return ref.el;
      });
      const doneBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => {
        if (finished) return;
        for (const qi of seq) reveal(qi, refs.get(qi));
        doneBtn.remove();
        finish();
      } });
      const refreshLabel = () => {
        const left = seq.filter((qi) => answers[qi] === null).length;
        doneBtn.textContent = left ? `Завершить (без ответа: ${left})` : 'Завершить';
      };
      box.addEventListener('click', refreshLabel);
      refreshLabel();
      box.replaceChildren(...cards, doneBtn);
    }
  });
}
