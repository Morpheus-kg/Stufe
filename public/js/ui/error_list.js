// Список ошибок ИИ с кнопкой «В карточку» (стейджинг без ИИ). Используется M10 и M15.
import { h, toast } from '../app.js';
import { cardsFromErrors } from '../api2.js';

const CAT_RU = {
  artikel: 'Артикль', kasus: 'Падеж', wortstellung: 'Порядок слов', praeposition: 'Предлог',
  konjugation: 'Спряжение', rechtschreibung: 'Орфография', wortschatz: 'Лексика', sonstiges: 'Другое',
};

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** Приводит мусор от ИИ к безопасному виду ErrorItem */
function cleanErrors(errors) {
  if (!Array.isArray(errors)) return [];
  const out = [];
  for (const e of errors) {
    if (!e || typeof e !== 'object') continue;
    const item = {
      category: str(e.category, 30) || 'sonstiges',
      original: str(e.original, 300),
      fix: str(e.fix, 255),
      explanation_ru: str(e.explanation_ru, 500),
    };
    if (item.original || item.fix) out.push(item);
  }
  return out;
}

/**
 * renderErrors(container, errors, {sentence?})
 * Рисует ошибки; у каждой кнопка «В карточку» (POST /cards/from-errors).
 */
export function renderErrors(container, errors, opts = {}) {
  const list = cleanErrors(errors);
  const sentence = typeof (opts && opts.sentence) === 'string' ? opts.sentence.slice(0, 500) : '';
  const box = h('div', { class: 'error-list stack' });
  if (!list.length) {
    box.append(h('p', { class: 'muted', text: 'Ошибок не найдено.' }));
    container.append(box);
    return box;
  }
  for (const err of list) {
    const btn = h('button', { class: 'btn', type: 'button', text: 'В карточку' });
    btn.addEventListener('click', async () => {
      if (!err.fix) { toast('Нет исправленной формы для карточки'); return; }
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const item = { ...err };
        if (sentence) item.sentence = sentence;
        const res = await cardsFromErrors({ items: [item] });
        if (res && res.added > 0) {
          btn.textContent = 'Добавлено';
          toast('Добавлено в карточки');
        } else {
          btn.textContent = 'Уже есть';
          toast('Такая карточка уже есть');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'В карточку';
        toast(e && e.message ? e.message : 'Не удалось добавить');
      }
    });
    box.append(h('div', { class: 'card-box stack' },
      h('div', { class: 'muted', text: CAT_RU[err.category] || err.category }),
      h('div', {},
        h('span', { text: '− ' }), h('del', { text: err.original || '—' }),
        h('span', { text: '  + ' }), h('strong', { text: err.fix || '—' })),
      err.explanation_ru ? h('p', { text: err.explanation_ru }) : null,
      btn));
  }
  container.append(box);
  return box;
}

export default renderErrors;