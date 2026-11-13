// Режим cloze (v2): лёгкий — варианты; средний — ввод, перевод, подсказки; сложный — ввод без перевода и подсказок
import { h } from '../app.js';
import { mountTyped, mountChoices, validChoices, difficultyOf } from './ru_de.js';

export function expected(item) {
  return String((item && item.card && item.card.cloze_answer) ?? '').trim();
}

function renderCloze(text) {
  const parts = String(text ?? '').split('____');
  const p = h('div', { class: 'prompt cloze', lang: 'de' });
  parts.forEach((part, i) => {
    if (i > 0) p.append(h('span', { class: 'blank', 'aria-label': 'пропуск', text: '_____' }));
    p.append(part);
  });
  return p;
}

export async function mount(container, item, ctx) {
  const c = item.card || {};
  const exp = expected(item);
  if (!exp || !c.example_cloze) throw new Error('bad cloze card');
  const diff = difficultyOf(ctx);

  container.append(
    h('div', { class: 'card-box stack center' },
      h('div', { class: 'muted', text: 'Вставьте пропущенное слово или предлог' }),
      renderCloze(c.example_cloze),
      diff !== 'hard' && c.example_translation ? h('div', { class: 'muted', text: c.example_translation }) : null,
      diff !== 'hard' && c.rektion ? h('div', { class: 'row center wrap' }, h('span', { class: 'chip', text: `Управление: ${c.rektion}` })) : null
    )
  );

  if (diff === 'easy') {
    const choices = validChoices(item, [exp]);
    if (choices) return mountChoices(container, { choices, correctForms: [exp] });
    // нет вариантов — вводим текстом
  }
  return mountTyped(container, { expected: exp, ctx, hints: diff !== 'hard' });
}