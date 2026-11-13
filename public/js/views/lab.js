// #/lab: вставить немецкий текст и разобрать его (уровень, покрытие словами, незнакомые слова).
// #/lab?text=<id>: разобрать уже сохранённый текст (кнопка «Анализ слов» в читалке).
import { h, speakText } from '../app.js';
import { createText, analyzeText, getText } from '../api2.js';
import { openLookup } from '../ui/lookup.js';
import { AI_MODEL_OPTIONS, describeError } from './texts.js';

const asArray = (v) => (Array.isArray(v) ? v : []);

function shown(w) {
  const base = String((w && (w.lemma || w.word)) || '');
  return w && w.article ? `${w.article} ${base}` : base;
}

export async function mount(container, ctx) {
  const params = ctx && ctx.params;
  const fromId = Number(params && typeof params.get === 'function' ? params.get('text') : 0);

  const title = h('input', { id: 'lab-title', type: 'text', class: 'input', maxlength: '200', placeholder: 'Название (необязательно)' });
  const kind = h('select', { id: 'lab-kind', class: 'input' },
    h('option', { value: 'reading', text: 'Для чтения', selected: true }),
    h('option', { value: 'listening', text: 'Для аудирования' }));
  const level = h('select', { id: 'lab-level', class: 'input' },
    h('option', { value: 'B1', text: 'B1' }),
    h('option', { value: 'B2', text: 'B2', selected: true }),
    h('option', { value: 'C1', text: 'C1' }));
  const prov = h('select', { id: 'lab-prov', class: 'input' },
    AI_MODEL_OPTIONS.map(([v, t]) => h('option', { value: v, text: t, selected: v === 'auto' })));
  const body = h('textarea', { id: 'lab-body', class: 'input', rows: '8', placeholder: 'Вставьте немецкий текст (от 50 до 20000 символов)' });
  const counter = h('p', { class: 'muted', text: '0 / 20000' });
  body.addEventListener('input', () => { counter.textContent = `${body.value.length} / 20000`; });
  const err = h('p', { class: 'error' });
  const out = h('div', { class: 'stack' });
  let busy = false;
  let saved = null;   // {id, body}: повторная попытка не создаёт дубль текста

  const btn = h('button', { class: 'btn primary', type: 'button', text: 'Анализировать', onclick: onAnalyze });

  async function runAnalysis(textId) {
    out.replaceChildren(h('p', { class: 'muted center', text: 'Анализируем… (до минуты)' }));
    const reqBody = { text_id: textId };
    if (prov.value !== 'auto') reqBody.provider = prov.value;
    const r = await analyzeText(reqBody);
    renderResult(textId, r);
  }

  async function onAnalyze() {
    if (busy) return;
    const text = body.value.trim();
    if (text.length < 50 || text.length > 20000) { err.textContent = 'Длина текста должна быть от 50 до 20000 символов.'; return; }
    busy = true;
    btn.disabled = true;
    err.textContent = '';
    try {
      if (!saved || saved.body !== text || saved.kind !== kind.value) {
        const t = (title.value.trim() || `${text.slice(0, 40)}…`).slice(0, 200);
        const item = await createText({ kind: kind.value, title: t, body: text, level: level.value });
        if (!item || !item.id) throw new Error('Пустой ответ сервера');
        saved = { id: item.id, body: text, kind: kind.value };
      }
      await runAnalysis(saved.id);
    } catch (e) {
      out.replaceChildren();
      err.textContent = describeError(e);   // текст в поле остаётся
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  function renderResult(textId, r) {
    const data = r && typeof r === 'object' ? r : {};
    const pct = Number.isFinite(data.coverage_pct) ? Math.min(100, Math.max(0, Math.round(data.coverage_pct))) : null;
    const bar = h('div', { class: 'progress-fill', style: `width: ${pct ?? 0}%` });
    const track = h('div', { class: 'progress', style: 'margin: var(--s2) 0 var(--s3);' }, bar);

    const words = asArray(data.unknown_words).filter((w) => w && typeof w.word === 'string').slice(0, 30);
    const staged = Number.isFinite(data.staged) ? data.staged : 0;
    const rows = words.map((w) => {
      const tr = h('div', { class: 'card-box stack' },
        h('div', { class: 'actions' },
          h('strong', { text: shown(w) }),
          w.plural ? h('span', { class: 'muted', text: `мн.: ${w.plural}` }) : null,
          h('button', {
            class: 'btn', type: 'button', text: '🔊', 'aria-label': 'Озвучить',
            onclick: (e) => { e.stopPropagation(); try { speakText(shown(w)); } catch { /* нет голоса */ } },
          })),
        h('span', { text: String(w.translation_ru || '') }),
        w.example ? h('span', { class: 'muted', text: String(w.example) }) : null,
        w.in_cards ? h('span', { class: 'chip', text: 'Уже в карточках' }) : null);
      tr.style.cursor = 'pointer';
      tr.onclick = () => { try { openLookup(w.word, String(w.example || '').slice(0, 200), words); } catch { /* словарь недоступен */ } };
      return tr;
    });

    out.replaceChildren(
      h('div', { class: 'card-box stack' },
        h('p', null, h('strong', { text: `Оценка уровня: ${String(data.level_estimate || '—')}` })),
        pct === null ? null : h('p', { text: `Знакомые слова в тексте: ${pct}%` }),
        pct === null ? null : track,
        data.summary_ru ? h('p', { text: String(data.summary_ru) }) : null,
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: `#/text/${textId}`, text: 'Читать' }),
          h('a', { class: 'btn', href: `#/listen/${textId}`, text: 'Слушать' }))),
      staged > 0
        ? h('p', null, `Незнакомых слов добавлено в карточки: ${staged}. `, h('a', { href: '#/cards', text: 'Открыть карточки' }))
        : null,
      words.length ? h('h3', { text: 'Незнакомые слова' }) : h('p', { class: 'muted', text: 'Незнакомых слов не найдено.' }),
      h('p', { class: 'muted', text: 'Покрытие приблизительное. Нажмите на слово, чтобы открыть словарь.' }),
      ...rows);
  }

  container.append(
    h('h2', { text: 'Лаборатория текста' }),
    h('div', { class: 'card-box stack' },
      h('label', { class: 'stack' }, h('span', { class: 'muted', text: 'Название' }), title),
      h('label', { class: 'stack' }, h('span', { class: 'muted', text: 'Использовать' }), kind),
      h('label', { class: 'stack' }, h('span', { class: 'muted', text: 'Уровень' }), level),
      h('label', { class: 'stack' }, h('span', { class: 'muted', text: 'Модель ИИ' }), prov),
      h('label', { class: 'stack' }, h('span', { class: 'muted', text: 'Текст' }), body),
      counter, btn, err),
    out);

  // Анализ сохранённого текста по ссылке из читалки
  if (Number.isInteger(fromId) && fromId > 0) {
    busy = true;
    btn.disabled = true;
    (async () => {
      try {
        const item = await getText(fromId);
        if (item && item.title) out.replaceChildren(h('p', { class: 'muted', text: `Текст: ${String(item.title)}` }));
        await runAnalysis(fromId);
      } catch (e) {
        out.replaceChildren();
        err.textContent = describeError(e);
      } finally {
        busy = false;
        btn.disabled = false;
      }
    })();
  }

  return () => { /* таймеров и слушателей нет */ };
}
