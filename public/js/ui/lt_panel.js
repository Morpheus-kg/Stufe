// UI-панель быстрой проверки LanguageTool: подсветка ошибок в тексте, пояснения,
// быстрая подстановка исправления и кнопка «В FSRS» (через POST /api/cards/from-errors).
import { h, toast } from '../app.js';
import { cardsFromErrors } from '../api2.js';

function reasonNote(reason) {
  if (reason === 'rate_limit') return 'LanguageTool временно ограничил частоту запросов — основной разбор ИИ работает как обычно.';
  if (reason === 'timeout') return 'LanguageTool не успел ответить за отведённое время — основной разбор ИИ работает как обычно.';
  return 'LanguageTool сейчас недоступен — основной разбор ИИ работает как обычно.';
}

/** Подсветка совпадений LT поверх исходного текста (безопасно через createTextNode, без innerHTML) */
function renderHighlightedText(text, matches, onSelectMatch) {
  const box = h('div', { class: 'lt-highlighted', lang: 'de' });
  const sorted = [...matches]
    .filter((m) => Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length > 0 && m.offset < text.length)
    .sort((a, b) => a.offset - b.offset);

  let cursor = 0;
  for (let idx = 0; idx < sorted.length; idx += 1) {
    const m = sorted[idx];
    if (m.offset < cursor) continue; // пропускаем перекрытия
    if (m.offset > cursor) box.append(document.createTextNode(text.slice(cursor, m.offset)));
    const end = Math.min(text.length, m.offset + m.length);
    const span = h('mark', {
      class: `lt-mark lt-cat-${m.category || 'sonstiges'}`,
      title: m.shortMessage || m.message || '',
      text: text.slice(m.offset, end),
      onclick: () => onSelectMatch(m._idx),
    });
    box.append(span);
    cursor = end;
  }
  if (cursor < text.length) box.append(document.createTextNode(text.slice(cursor)));
  return box;
}

/**
 * Отрисовка результата LanguageTool в контейнер.
 * @param {HTMLElement} container
 * @param {{text: string, result: object, onApplyReplacement?: (match: object, replacement: string) => void}} opts
 */
export function renderLanguageToolPanel(container, { text, result, onApplyReplacement } = {}) {
  container.replaceChildren();
  if (!result || typeof result !== 'object') return;

  if (result.degraded || !result.available) {
    container.append(
      h('div', { class: 'card-box lt-panel lt-degraded' },
        h('div', { class: 'muted', text: `⚡ ${reasonNote(result.reason)}` }))
    );
    return;
  }

  const matches = (Array.isArray(result.matches) ? result.matches : []).map((m, i) => ({ ...m, _idx: i }));
  if (!matches.length) {
    container.append(
      h('div', { class: 'card-box lt-panel lt-ok' },
        h('strong', { text: '✓ LanguageTool: явных ошибок орфографии, артиклей и пунктуации не найдено.' }))
    );
    return;
  }

  const cardEls = new Map();
  const focusCard = (idx) => {
    const el = cardEls.get(idx);
    if (!el) return;
    el.classList.add('lt-focus');
    try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* ignore */ }
    setTimeout(() => el.classList.remove('lt-focus'), 1200);
  };

  const list = h('div', { class: 'stack' });
  for (const m of matches) {
    const fixText = m.suggestedCardTerm || (m.replacements && m.replacements[0]) || m.bad || '';
    const fsrsBtn = h('button', {
      class: 'btn sm',
      type: 'button',
      text: '+ В FSRS',
      title: fixText ? `Сохранить «${fixText}» в колоду карточек` : 'Сохранить в карточки',
    });
    fsrsBtn.addEventListener('click', async () => {
      if (!fixText) { toast('Нет исправления для сохранения в карточку'); return; }
      fsrsBtn.disabled = true;
      fsrsBtn.textContent = '…';
      try {
        const res = await cardsFromErrors({
          items: [{
            category: m.category || 'sonstiges',
            original: String(m.bad || '').slice(0, 300),
            fix: String(fixText).slice(0, 255),
            explanation_ru: String(m.shortMessage || m.message || 'Исправление LanguageTool').slice(0, 500),
            sentence: m.contextSentence || undefined,
          }],
        });
        if (res && res.added > 0) {
          fsrsBtn.textContent = '✓ В FSRS';
          toast(`«${fixText}» добавлено в колоду FSRS`);
        } else {
          fsrsBtn.textContent = 'Уже в колоде';
          toast('Такая карточка уже есть в колоде');
        }
      } catch (e) {
        fsrsBtn.disabled = false;
        fsrsBtn.textContent = '+ В FSRS';
        toast((e && e.message) || 'Не удалось сохранить в FSRS');
      }
    });

    const repChips = Array.isArray(m.replacements) && m.replacements.length
      ? h('div', { class: 'row wrap', style: 'gap: var(--s2);' },
          m.replacements.slice(0, 4).map((rep) => (
            typeof onApplyReplacement === 'function'
              ? h('button', {
                  class: 'btn sm ghost lt-rep-btn',
                  type: 'button',
                  lang: 'de',
                  title: 'Применить исправление в тексте',
                  text: `→ ${rep}`,
                  onclick: () => onApplyReplacement(m, rep),
                })
              : h('span', { class: 'chip', lang: 'de', text: rep })
          )))
      : null;

    const card = h('div', { class: 'card-box stack lt-item' },
      h('div', { class: 'row wrap', style: 'justify-content: space-between; align-items: center;' },
        h('span', { class: 'chip', text: m.categoryLabelRu || 'Грамматика' }),
        fsrsBtn),
      h('div', { lang: 'de' },
        h('del', { class: 'd-del', text: m.bad || '—' }),
        m.replacements && m.replacements[0] ? h('span', { text: '  →  ' }) : null,
        m.replacements && m.replacements[0] ? h('strong', { text: m.replacements[0] }) : null),
      m.message ? h('div', { class: 'muted', style: 'font-size: var(--fs-sm);', text: m.message }) : null,
      repChips,
    );
    cardEls.set(m._idx, card);
    list.append(card);
  }

  container.append(
    h('div', { class: 'card-box stack lt-panel' },
      h('div', { class: 'row wrap', style: 'justify-content: space-between; align-items: center;' },
        h('strong', { text: `⚡ Быстрая проверка LanguageTool (${matches.length})` }),
        h('span', { class: 'muted', style: 'font-size: var(--fs-xs);', text: 'орфография · падежи · артикли · пунктуация' })),
      renderHighlightedText(String(text || ''), matches, focusCard),
      list)
  );
}

export default renderLanguageToolPanel;
