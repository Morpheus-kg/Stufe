// Результат пакетной проверки (BatchResult): карточки по предложениям + общий итог
import { h, toast } from '../app.js';
import { cardsFromErrors } from '../api2.js';
import { ERROR_CATEGORIES } from '/shared/constants.js';

const CAT_RU = {
  artikel: 'Артикли', kasus: 'Падежи', wortstellung: 'Порядок слов', praeposition: 'Предлоги',
  konjugation: 'Спряжение', rechtschreibung: 'Орфография', wortschatz: 'Лексика', sonstiges: 'Прочее',
};

const st = (el, o) => { Object.assign(el.style, o); return el; };
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');

/** Простой запасной вывод ошибок, если error_list.js недоступен */
function fallbackErrors(box, errors) {
  for (const e of errors) {
    box.append(h('p', {},
      h('s', { text: str(e.original) }), ' → ', h('strong', { text: str(e.fix) }),
      h('br'), h('span', { class: 'muted', text: str(e.explanation_ru) })));
  }
}

function errorsBlock(errors, sentence) {
  const box = h('div', { class: 'stack' });
  if (!errors.length) return box;
  import('./error_list.js')
    .then((m) => {
      if (typeof m.renderErrors !== 'function') throw new Error('no export');
      m.renderErrors(box, errors, { sentence });
    })
    .catch(() => { box.replaceChildren(); fallbackErrors(box, errors); });
  return box;
}

function scoreChip(score) {
  const n = Number.isFinite(Number(score)) ? Math.round(Number(score)) : 0;
  return h('span', { class: 'chip', text: `${n}/100` });
}

function itemCard(it, src) {
  const box = st(h('div', { class: 'card-box stack' }), { marginBottom: '12px' });
  const idx = Number.isInteger(it.idx) ? it.idx + 1 : '';
  const answered = it.answered !== false;
  const verdict = !answered ? 'Нет ответа' : it.is_acceptable ? '✓ Принято' : '✗ Нужно поправить';
  box.append(st(h('div', {}, h('strong', { text: `№${idx} ` }), h('span', { text: verdict }), ' ', answered ? scoreChip(it.score) : null),
    { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }));
  if (src && src.source) box.append(h('p', { class: 'muted', text: src.source }));
  if (!answered) {
    if (str(it.model_translation)) box.append(h('p', {}, h('span', { class: 'muted', text: 'Образец: ' }), str(it.model_translation)));
    return box;
  }
  if (src && src.answer) box.append(h('p', {}, h('span', { class: 'muted', text: 'Ваш ответ: ' }), src.answer));
  if (str(it.corrected) && it.corrected !== (src && src.answer)) {
    box.append(h('p', {}, h('span', { class: 'muted', text: 'Исправлено: ' }), h('strong', { text: it.corrected })));
  }
  if (str(it.model_translation)) box.append(h('p', {}, h('span', { class: 'muted', text: 'Образец: ' }), it.model_translation));
  const errs = arr(it.errors).filter((e) => e && typeof e === 'object');
  if (errs.length) box.append(errorsBlock(errs, str(it.corrected) || undefined));
  if (str(it.comment_ru)) box.append(h('p', { class: 'muted', text: it.comment_ru }));
  return box;
}

function listBlock(title, items) {
  const list = arr(items).filter((x) => typeof x === 'string' && x.trim());
  if (!list.length) return null;
  return h('div', {}, h('strong', { text: title }), h('ul', {}, list.map((t) => h('li', { text: t }))));
}

/** Собрать ошибки всех предложений для отправки в карточки (до 10) */
function collectErrors(items) {
  const out = [];
  for (const it of items) {
    for (const e of arr(it && it.errors)) {
      if (!e || !str(e.fix).trim() || !str(e.explanation_ru).trim()) continue;
      out.push({
        category: ERROR_CATEGORIES.includes(e.category) ? e.category : 'sonstiges',
        original: str(e.original).slice(0, 255),
        fix: str(e.fix).slice(0, 255),
        explanation_ru: str(e.explanation_ru).slice(0, 500),
        ...(str(it.corrected).trim() ? { sentence: it.corrected.slice(0, 600) } : {}),
      });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {object} result BatchResult
 * @param {{sources?: {idx:number, source?:string, answer?:string}[]}} [opts]
 */
export function renderBatchResult(container, result, opts = {}) {
  if (!result || typeof result !== 'object') {
    container.replaceChildren(h('p', { class: 'error', text: 'Нет результата проверки.' }));
    return;
  }
  const items = arr(result.items).filter((x) => x && typeof x === 'object');
  const srcMap = new Map();
  for (const s of arr(opts.sources)) if (s && Number.isInteger(s.idx)) srcMap.set(s.idx, s);
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : {};

  const head = h('div', { class: 'card-box stack' },
    h('div', { class: 'score-big', text: `${Math.round(Number(result.score) || 0)}` }),
    h('div', { class: 'stat-label', text: 'из 100 баллов' }),
    str(summary.overall_ru) ? h('p', { text: summary.overall_ru }) : null
  );

  const patterns = arr(summary.patterns).filter((p) => p && typeof p === 'object');
  if (patterns.length) {
    head.append(h('div', {}, h('strong', { text: 'Типичные ошибки' }),
      h('ul', {}, patterns.map((p) => h('li', {},
        h('strong', { text: `${CAT_RU[p.category] || str(p.category) || 'Прочее'} × ${Number(p.count) || 0}` }),
        str(p.tip_ru) ? `: ${p.tip_ru}` : '')))));
  }
  head.append(listBlock('Что получилось хорошо', summary.strengths_ru));
  head.append(listBlock('Над чем поработать', arr(summary.focus_ru).slice(0, 3)));

  const ids = arr(summary.words_to_review).filter((n) => Number.isInteger(n));
  if (ids.length) {
    head.append(h('div', {}, h('strong', { text: 'Слова на повтор: ' }),
      ids.map((id, i) => h('span', {}, i ? ', ' : '', h('a', { href: `#/cards?id=${id}`, text: `#${id}` })))));
  }

  const errs = collectErrors(items);
  if (errs.length) {
    const btn = h('button', { class: 'btn', type: 'button', text: `В карточки (${errs.length})` });
    st(btn, { minHeight: '44px' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await cardsFromErrors({ items: errs });
        btn.textContent = `Добавлено: ${r && r.added || 0}, дубликатов: ${r && r.duplicates || 0}`;
        toast('Ошибки добавлены в карточки');
      } catch (e) {
        btn.disabled = false;
        toast((e && e.message) || 'Не удалось добавить');
      }
    });
    head.append(h('div', { class: 'actions' }, btn));
  }

  container.replaceChildren(head, ...items.map((it) => itemCard(it, srcMap.get(it.idx))));
}