// Режим article (v2): артикль кнопками der/die/das (сравнение с card.article);
// множественное число — отдельно через ctx.grade (gradeTyped(answer, card.plural))
//   лёгкий: перевод виден, plural не спрашиваем
//   средний: перевод виден, plural вводим (с подсказками)
//   сложный: только немецкое слово, plural обязателен, без подсказок
import { h } from '../app.js';
import { mountTyped, difficultyOf } from './ru_de.js';

const ARTICLES = ['der', 'die', 'das'];

const pluralOf = (c) => String((c && c.plural) ?? '').trim();

/** Ожидаемый ответ для обратной связи; в лёгком режиме plural не спрашивается */
export function expected(item, userAnswer, difficulty) {
  const c = (item && item.card) || {};
  const pl = pluralOf(c);
  return pl && difficulty !== 'easy' ? `${c.article} ${pl}` : String(c.article || '');
}

export async function mount(container, item, ctx) {
  const c = item.card || {};
  if (!ARTICLES.includes(c.article) || !c.term) throw new Error('bad article card');
  const diff = difficultyOf(ctx);
  const plural = pluralOf(c);
  const askPlural = diff !== 'easy' && !!plural;
  const t0 = performance.now();

  // Шаг 1: артикль (клавиши 1–3 тоже работают)
  const chosen = await new Promise((resolve) => {
    let done = false;
    const buttons = ARTICLES.map((a) => h('button', {
      class: 'btn article-btn art-' + a, type: 'button', text: a, onclick: () => pick(a),
    }));
    function onKey(e) {
      if (done || !container.isConnected) { document.removeEventListener('keydown', onKey); return; }
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= ARTICLES.length) { e.preventDefault(); pick(ARTICLES[n - 1]); }
    }
    function pick(a) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      buttons.forEach((b) => { b.disabled = true; });
      resolve(a);
    }
    container.append(
      h('div', { class: 'card-box stack center' },
        h('div', { class: 'muted', text: 'Выберите артикль' }),
        h('div', { class: 'prompt', lang: 'de', text: c.term }),
        diff !== 'hard' && c.translation ? h('div', { class: 'translation muted', text: c.translation }) : null,
        h('div', { class: 'article-row' }, buttons)
      )
    );
    document.addEventListener('keydown', onKey);
  });

  const articleOk = chosen === c.article;

  if (!askPlural) {
    return {
      result: articleOk ? 'correct' : 'wrong',
      userAnswer: chosen,
      responseMs: Math.round(performance.now() - t0),
      hints: 0,
    };
  }

  // Шаг 2: множественное число (проверка отдельно, неверный артикль всегда даёт wrong)
  container.append(
    h('div', { class: 'card-box stack center' },
      h('div', { class: 'muted', text: `Вы выбрали: ${chosen}. Теперь введите множественное число` }),
      h('div', { class: 'prompt', lang: 'de', text: c.term })
    )
  );
  const pr = await mountTyped(container, {
    expected: plural, ctx, label: 'Множественное число', hints: diff === 'medium',
  });

  return {
    result: articleOk ? pr.result : 'wrong',
    userAnswer: `${chosen} ${pr.userAnswer}`.trim(),
    responseMs: Math.round(performance.now() - t0),
    hints: pr.hints,
  };
}