// M5: режим «предложение». Пользователь составляет предложение со словом, ИИ исправляет.
// В FSRS не оценивается. Подробный разбор показываем здесь и резолвимся по кнопке «Дальше».
import * as api from '../api.js';
import { renderDiff, ensureM5Styles } from '../ui/diff.js';

const MAX_LEN = 400;
const MAX_RESPONSE_MS = 3600000;

const CATEGORY_LABELS = {
  artikel: 'Артикль',
  kasus: 'Падеж',
  wortstellung: 'Порядок слов',
  praeposition: 'Предлог',
  konjugation: 'Спряжение',
  rechtschreibung: 'Орфография',
  wortschatz: 'Лексика',
  sonstiges: 'Другое',
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Слово в показываемом виде: артикль + term. */
function displayTerm(card) {
  if (!card || typeof card.term !== 'string') return '';
  const art = typeof card.article === 'string' && card.article ? card.article + ' ' : '';
  return art + card.term;
}

/** Приводит ответ сервера к безопасной форме (мусор не должен ломать экран). */
function normalizeResponse(res, fallbackText) {
  const d = res && typeof res === 'object' ? res : {};
  const errors = Array.isArray(d.errors) ? d.errors : [];
  return {
    corrected: str(d.corrected, 800) || fallbackText,
    isCorrect: d.is_correct === true,
    usesTarget: d.uses_target_word === true,
    errors: errors
      .filter((e) => e && typeof e === 'object')
      .slice(0, 10)
      .map((e) => ({
        category: CATEGORY_LABELS[e.category] || CATEGORY_LABELS.sonstiges,
        original: str(e.original, 300),
        fix: str(e.fix, 300),
        explanation: str(e.explanation_ru, 600),
      })),
    alternative: str(d.alternative, 800),
  };
}

function errorMessage(e) {
  const code = e && e.code;
  if (code === 'AI_UNAVAILABLE') return 'ИИ сейчас недоступен. Попробуйте позже или пропустите задание.';
  if (code === 'AI_CAP') return 'Дневной лимит проверок ИИ исчерпан. Пропустите задание.';
  if (code === 'RATE_LIMITED') return 'Слишком много запросов. Подождите немного.';
  if (code === 'UNAUTHORIZED') return 'Сессия истекла. Войдите заново.';
  return e && typeof e.message === 'string' && e.message ? e.message : 'Не удалось проверить предложение.';
}

/**
 * @param {HTMLElement} container
 * @param {{card?:object}} item  QueueItem (kind 'sentence')
 * @param {{grade?:Function, settings?:object}} ctx
 * @returns {Promise<{result:'correct'|'almost'|'wrong', userAnswer:string, responseMs:number, hints:number}>}
 */
export async function mount(container, item, ctx) {
  ensureM5Styles();
  const card = item && item.card && typeof item.card === 'object' ? item.card : null;
  const aiOn = !(ctx && ctx.settings && ctx.settings.ai_enabled === false);
  const t0 = performance.now();

  container.replaceChildren();

  return new Promise((resolve) => {
    let done = false;
    let busy = false;

    const root = el('div', 'm5-col');
    root.appendChild(el('h2', null, 'Составьте предложение'));

    if (card && displayTerm(card)) {
      const target = el('div', 'm5-box');
      const word = el('strong', null, displayTerm(card));
      word.lang = 'de';
      target.appendChild(word);
      if (typeof card.translation === 'string' && card.translation) {
        target.appendChild(document.createTextNode(' — ' + card.translation));
      }
      root.appendChild(target);
      root.appendChild(
        el('p', 'm5-note', 'Напишите одно предложение по-немецки с этим словом (можно в любой форме).')
      );
    } else {
      root.appendChild(el('p', 'm5-note', 'Напишите любое предложение по-немецки.'));
    }

    const status = el('p', 'm5-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const result = el('div', 'm5-col');
    result.setAttribute('aria-live', 'polite');

    function finish(res, text) {
      if (done) return;
      done = true;
      const responseMs = Math.min(MAX_RESPONSE_MS, Math.max(0, Math.round(performance.now() - t0)));
      resolve({ result: res, userAnswer: text, responseMs, hints: 0 });
    }

    // ИИ отключён в настройках: сразу даём перейти дальше
    if (!aiOn) {
      root.appendChild(el('p', 'm5-box', 'Проверка ИИ отключена в настройках. Задание пропущено.'));
      const next = el('button', 'm5-btn m5-btn-primary', 'Дальше');
      next.type = 'button';
      next.addEventListener('click', () => {
        next.disabled = true;
        finish('almost', '');
      });
      root.appendChild(next);
      container.appendChild(root);
      return;
    }

    const area = el('textarea', 'm5-input');
    area.rows = 3;
    area.maxLength = MAX_LEN;
    area.lang = 'de';
    area.setAttribute('aria-label', 'Ваше предложение');
    area.placeholder = 'Ihr Satz …';
    area.spellcheck = false;
    area.autocapitalize = 'sentences';

    const counter = el('p', 'm5-note', '0/' + MAX_LEN);

    const actions = el('div', 'm5-row');
    const btnCheck = el('button', 'm5-btn m5-btn-primary', 'Проверить');
    const btnSkip = el('button', 'm5-btn', 'Пропустить');
    btnCheck.type = 'button';
    btnSkip.type = 'button';
    actions.append(btnCheck, btnSkip);

    root.append(area, counter, actions, status, result);
    container.appendChild(root);

    area.addEventListener('input', () => {
      counter.textContent = area.value.length + '/' + MAX_LEN;
    });

    btnSkip.addEventListener('click', () => {
      if (busy || done) return;
      finish('almost', '');
    });

    function renderResult(r, text) {
      result.replaceChildren();

      const badge = el(
        'span',
        'm5-badge ' + (r.isCorrect ? 'm5-badge-ok' : 'm5-badge-bad'),
        r.isCorrect ? 'Верно' : 'Есть ошибки'
      );
      const head = el('div', 'm5-row');
      head.appendChild(badge);
      if (card && displayTerm(card)) {
        head.appendChild(
          el(
            'span',
            'm5-badge ' + (r.usesTarget ? 'm5-badge-ok' : 'm5-badge-warn'),
            r.usesTarget ? 'Слово использовано' : 'Слово не найдено в предложении'
          )
        );
      }
      result.appendChild(head);

      // Исправленный вариант + разбор по словам (diff считает ctx.grade, если он есть)
      const fixedBox = el('div', 'm5-col');
      fixedBox.appendChild(el('strong', null, 'Исправленный вариант'));
      const fixed = el('p', 'm5-box', r.corrected);
      fixed.lang = 'de';
      fixedBox.appendChild(fixed);
      result.appendChild(fixedBox);

      if (!r.isCorrect && ctx && typeof ctx.grade === 'function') {
        try {
          const g = ctx.grade(text, r.corrected);
          if (g && Array.isArray(g.diff) && g.diff.length) {
            const diffBox = el('div', 'm5-col');
            diffBox.appendChild(el('strong', null, 'Что изменилось'));
            diffBox.appendChild(renderDiff(g.diff, { legend: true }));
            result.appendChild(diffBox);
          }
        } catch (e) {
          // diff необязателен
        }
      }

      if (r.errors.length) {
        const list = el('ul', null);
        for (const e of r.errors) {
          const li = el('li');
          li.appendChild(el('strong', null, e.category + ': '));
          if (e.original || e.fix) {
            const o = el('span', null, e.original || '—');
            o.lang = 'de';
            const f = el('span', null, e.fix || '—');
            f.lang = 'de';
            li.append(o, document.createTextNode(' → '), f);
          }
          if (e.explanation) li.appendChild(el('div', 'm5-note', e.explanation));
          list.appendChild(li);
        }
        const errBox = el('div', 'm5-col');
        errBox.appendChild(el('strong', null, 'Ошибки'));
        errBox.appendChild(list);
        result.appendChild(errBox);
      }

      if (r.alternative) {
        const alt = el('div', 'm5-col');
        alt.appendChild(el('strong', null, 'Другой вариант'));
        const p = el('p', 'm5-box', r.alternative);
        p.lang = 'de';
        alt.appendChild(p);
        result.appendChild(alt);
      }

      const next = el('button', 'm5-btn m5-btn-primary', 'Дальше');
      next.type = 'button';
      next.addEventListener('click', () => {
        next.disabled = true;
        finish(r.isCorrect ? 'correct' : 'wrong', text);
      });
      result.appendChild(next);
      next.focus({ preventScroll: false });
    }

    async function check() {
      if (busy || done) return;
      const text = area.value.trim();
      if (!text) {
        status.textContent = 'Введите предложение.';
        area.focus();
        return;
      }
      if (text.length > MAX_LEN) {
        status.textContent = 'Слишком длинно: максимум ' + MAX_LEN + ' символов.';
        return;
      }
      busy = true;
      btnCheck.disabled = true;
      btnSkip.disabled = true;
      area.disabled = true;
      status.classList.remove('m5-err');
      status.textContent = 'Проверяю…';
      try {
        const body = card && Number.isInteger(card.id) ? { card_id: card.id, text } : { text };
        const res = await api.correctSentence(body);
        status.textContent = '';
        actions.hidden = true;
        counter.hidden = true;
        renderResult(normalizeResponse(res, text), text);
      } catch (e) {
        if (e && e.code === 'UNAUTHORIZED') {
          try {
            window.location.hash = '#/login';
          } catch (err) {
            // не критично
          }
        }
        status.classList.add('m5-err');
        status.textContent = errorMessage(e);
        // даём повторить или пропустить
        btnCheck.disabled = false;
        btnSkip.disabled = false;
        area.disabled = false;
      } finally {
        busy = false;
      }
    }

    btnCheck.addEventListener('click', check);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        check();
      }
    });
    try {
      area.focus({ preventScroll: true });
    } catch (e) {
      // не критично
    }
  });
}

export default { mount };