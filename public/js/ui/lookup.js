// Нижняя панель «Поиск слова»: артикль, множественное число, перевод, пример, TTS, «В карточки»
import { h, toast, speakText, POS_RU } from '../app.js';
import { createCard } from '../api.js';
import { lookupWord } from '../api2.js';

let closeCurrent = null;

/** Понятное русское сообщение об ошибке ИИ/сети */
function errText(e) {
  const c = e && e.code;
  if (c === 'AI_CAP') return 'Дневной лимит ИИ исчерпан. Попробуйте завтра.';
  if (c === 'AI_UNAVAILABLE') return 'ИИ сейчас недоступен. Попробуйте позже.';
  if (c === 'RATE_LIMITED') return 'Слишком много запросов. Подождите немного.';
  if (c === 'NETWORK') return 'Нет соединения с сервером.';
  return (e && e.message) || 'Не удалось найти слово.';
}

const st = (el, o) => { Object.assign(el.style, o); return el; };

const SUFFIXES = new Set(['', 'e', 'en', 'er', 'es', 'em', 'n', 's', 't', 'st', 'te', 'ten', 'tet', 'test',
  'et', 'ete', 'eten', 'end', 'ende', 'enden', 'ender']);

function matchesStem(word, stem) {
  if (!word || !stem || stem.length < 3) return false;
  const bases = [word];
  if (word.length > stem.length + 2 && word.startsWith('ge')) bases.push(word.slice(2));
  return bases.some((b) => b.startsWith(stem) && SUFFIXES.has(b.slice(stem.length)));
}

function verbStem(w) {
  if (w.length >= 5 && w.endsWith('en')) return w.slice(0, -2);
  if (w.length >= 5 && w.endsWith('n')) return w.slice(0, -1);
  return w;
}

/** Поиск слова во встроенном глоссарии текста (по форме, лемме, мн. ч. или основе) */
export function findInGlossary(glossary, rawWord) {
  if (!Array.isArray(glossary) || !glossary.length) return null;
  const w = String(rawWord ?? '').trim().toLowerCase();
  if (!w) return null;
  const exact = glossary.find((g) => g && (
    String(g.word || '').toLowerCase() === w
    || String(g.lemma || '').toLowerCase() === w
    || (g.plural && String(g.plural).toLowerCase() === w)
  ));
  if (exact) return exact;
  return glossary.find((g) => {
    if (!g) return false;
    const lemma = String(g.lemma || '').toLowerCase();
    const word = String(g.word || '').toLowerCase();
    const tokens = `${lemma} ${word}`.split(/\s+/).filter((t) => t.length >= 4);
    return tokens.some((t) => matchesStem(w, t) || (g.pos === 'verb' && matchesStem(w, verbStem(t))));
  }) || null;
}

/**
 * Открыть панель со словом.
 * @param {string} word слово (любая форма)
 * @param {string} [context] предложение, в котором оно встретилось (до 200 символов)
 * @param {Array} [glossary] встроенный глоссарий текста (если есть — мгновенный показ без запроса к ИИ)
 */
export function openLookup(word, context = '', glossary = null) {
  const w = String(word ?? '').trim().slice(0, 60);
  if (!w) return;
  if (closeCurrent) closeCurrent();

  const body = h('div', { class: 'stack' });
  const sheet = st(h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Слово' }), {
    position: 'fixed', left: '0', right: '0', bottom: '0', maxHeight: '80vh', overflowY: 'auto',
    background: 'var(--surface, var(--card, Canvas))', color: 'var(--text, var(--fg, CanvasText))',
    borderRadius: '16px 16px 0 0', padding: '16px', boxShadow: '0 -4px 24px rgba(0,0,0,.3)',
    maxWidth: '640px', margin: '0 auto', zIndex: '1001', boxSizing: 'border-box',
  });
  const overlay = st(h('div', { class: 'lookup-overlay' }), {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.4)', zIndex: '1000',
  });
  const closeBtn = h('button', { class: 'btn', type: 'button', text: 'Закрыть', 'aria-label': 'Закрыть' });
  st(closeBtn, { minHeight: '44px' });
  sheet.append(body, st(h('div', { class: 'actions' }, closeBtn), { marginTop: '12px' }));
  overlay.append(sheet);
  document.body.append(overlay);

  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (closeCurrent === close) closeCurrent = null;
  }
  closeCurrent = close;
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  closeBtn.focus();

  const ctxStr = String(context ?? '').slice(0, 200);
  const hit = findInGlossary(glossary, w);
  if (hit) {
    renderResult({ ...hit, example: hit.example || ctxStr || null });
    return;
  }

  body.append(h('p', { class: 'muted', text: 'Ищу «' + w + '»…' }));

  lookupWord({ word: w, context: ctxStr })
    .then((r) => {
      if (Array.isArray(glossary) && r && typeof r === 'object') glossary.push(r);
      if (!closed) renderResult(r);
    })
    .catch((e) => {
      if (closed) return;
      body.replaceChildren(h('p', { class: 'error', text: errText(e) }));
    });

  function renderResult(r) {
    if (!r || typeof r !== 'object') {
      body.replaceChildren(h('p', { class: 'error', text: 'Пустой ответ.' }));
      return;
    }
    const lemma = String(r.lemma || r.word || w);
    const shown = r.article ? `${r.article} ${lemma}` : lemma;
    const card = r.in_cards && typeof r.in_cards === 'object' ? r.in_cards : null;
    const translation = r.translation_ru || (card && card.translation) || '';

    const ttsBtn = h('button', { class: 'btn', type: 'button', text: '🔊', 'aria-label': 'Озвучить',
      onclick: () => { speakText(shown); } });
    st(ttsBtn, { minWidth: '44px', minHeight: '44px' });

    const meta = [POS_RU[r.pos] || r.pos, r.plural ? `мн.: ${r.plural}` : ''].filter(Boolean).join(' · ');
    const addBox = h('div', { class: 'actions' });

    body.replaceChildren(
      st(h('div', { class: 'row' }, st(h('h2', { text: shown }), { margin: '0', flex: '1' }), ttsBtn), { display: 'flex', alignItems: 'center', gap: '8px' }),
      meta ? h('p', { class: 'muted', text: meta }) : null,
      translation ? st(h('p', { text: translation }), { fontSize: '1.15em' }) : null,
      r.example ? h('p', {}, h('em', { text: r.example })) : null,
      r.example_ru ? h('p', { class: 'muted', text: r.example_ru }) : null,
      addBox
    );

    if (card) {
      addBox.append(h('span', { class: 'chip', text: '✓ Уже в карточках' }));
      return;
    }
    const directBtn = h('button', { class: 'btn primary', type: 'button', text: '+ В карточки' });
    st(directBtn, { minHeight: '44px' });

    directBtn.addEventListener('click', async () => {
      directBtn.disabled = true;
      try {
        const created = await createCard({
          term: lemma,
          translation: translation || '—',
          ...(r.article ? { article: r.article } : {}),
          ...(r.plural ? { plural: r.plural } : {}),
          pos: r.pos || (r.article ? 'noun' : 'phrase'),
          ...(r.example ? { example: r.example } : {}),
          ...(r.example_ru ? { example_translation: r.example_ru } : {}),
        });
        r.in_cards = created;
        addBox.replaceChildren(h('span', { class: 'chip', text: '✓ Добавлено в карточки' }));
        toast('Слово сразу добавлено в карточки ✓');
      } catch (e) {
        if (e && e.status === 409) {
          addBox.replaceChildren(h('span', { class: 'chip', text: '✓ Уже есть в карточках' }));
        } else {
          directBtn.disabled = false;
          toast(errText(e));
        }
      }
    });

    addBox.append(directBtn);
  }
}