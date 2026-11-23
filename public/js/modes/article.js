// Режим article (v2): артикль кнопками der/die/das (сравнение с card.article);
// множественное число — отдельно через ctx.grade (с раскрытием сокращений '-en', '¨-e', '-')
//   лёгкий: перевод виден, plural не спрашиваем
//   средний: перевод виден, plural вводим (с подсказками)
//   сложный: только немецкое слово, plural обязателен, без подсказок
import { h } from '../app.js';
import { resolvePlural } from '/shared/grading.js';
import { mountTyped, difficultyOf } from './ru_de.js';

const ARTICLES = ['der', 'die', 'das'];

const pluralOf = (c) => resolvePlural(c && c.term, c && c.plural);
const stripLeadingDie = (s) => String(s ?? '').trim().replace(/^die\s+/i, '').trim();

/** Ожидаемый ответ для обратной связи и озвучки: всегда полная фраза (с артиклем), не голый артикль */
export function expected(item, userAnswer, difficulty) {
  const c = (item && item.card) || {};
  const singular = c.article && c.term ? `${c.article} ${c.term}` : String(c.article || '');
  const pl = pluralOf(c);
  if (!pl || difficulty === 'easy') return singular;
  // Если шаг 1 (артикль) провален, userAnswer приходит как "<chosen> <term>"
  const ans = String(userAnswer ?? '').trim();
  const termLow = String(c.term ?? '').trim().toLowerCase();
  if (ans && termLow && ans.toLowerCase().endsWith(' ' + termLow)) {
    const first = ans.split(/\s+/)[0].toLowerCase();
    if (ARTICLES.includes(first) && first !== c.article) return singular;
  }
  return `die ${pl}`;
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

  // Если plural не спрашивается или артикль уже неверный — сразу завершаем без лишнего шага
  if (!askPlural || !articleOk) {
    return {
      result: articleOk ? 'correct' : 'wrong',
      userAnswer: `${chosen} ${c.term}`,
      responseMs: Math.round(performance.now() - t0),
      hints: 0,
    };
  }

  // Шаг 2: множественное число (заменяем контент, чтобы не дублировать карточку на экране телефона)
  container.replaceChildren(
    h('div', { class: 'card-box stack center' },
      h('div', { class: 'row center wrap' },
        h('span', { class: 'chip accent', lang: 'de', text: `✓ ${chosen} ${c.term}` })),
      h('div', { class: 'muted', text: 'Введите множественное число (die …)' }),
      diff !== 'hard' && c.translation ? h('div', { class: 'muted', text: c.translation }) : null
    )
  );
  const pluralCtx = {
    ...ctx,
    grade: (ans, exp) => ctx.grade(stripLeadingDie(ans), exp),
  };
  const pr = await mountTyped(container, {
    expected: plural, ctx: pluralCtx, label: 'Множественное число', hints: diff === 'medium',
  });

  const cleanPl = stripLeadingDie(pr.userAnswer);
  return {
    result: pr.result,
    userAnswer: cleanPl ? `die ${cleanPl}` : '',
    responseMs: Math.round(performance.now() - t0),
    hints: pr.hints,
  };
}