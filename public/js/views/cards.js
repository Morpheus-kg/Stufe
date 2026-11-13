// Список карточек: поиск, фильтры, правка, удаление, добавление слова, статус выученных
import { h, toast, displayTerm, speakText, POS_RU } from '../app.js';
import { getCards, patchCard, deleteCard, createCard, setCardLearned, generateWords } from '../api.js';
import { TOPICS, POS, LEVELS } from '/shared/constants.js';

const asList = (x, fallback) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : fallback);
const POS_LIST = asList(POS, ['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation']);
const LEVEL_LIST = asList(LEVELS, ['B1', 'B2', 'C1']);
const TOPIC_LIST = asList(TOPICS, ['Sonstiges']);
const ARTICLES = ['der', 'die', 'das'];
const PAGE = 50;

// Поля формы правки
const FIELDS = [
  { key: 'term', label: 'Слово (без артикля)', kind: 'text', required: true },
  { key: 'article', label: 'Артикль', kind: 'article' },
  { key: 'plural', label: 'Мн. число', kind: 'text' },
  { key: 'pos', label: 'Часть речи', kind: 'pos', required: true },
  { key: 'translation', label: 'Перевод', kind: 'text', required: true },
  { key: 'rektion', label: 'Управление (напр. auf + Akk)', kind: 'text' },
  { key: 'grammar', label: 'Грамматика', kind: 'area' },
  { key: 'example', label: 'Пример', kind: 'area' },
  { key: 'example_translation', label: 'Перевод примера', kind: 'area' },
  { key: 'example_cloze', label: 'Пример с пропуском (____)', kind: 'area' },
  { key: 'cloze_answer', label: 'Слово для пропуска', kind: 'text' },
  { key: 'level', label: 'Уровень', kind: 'level', required: true },
  { key: 'topic', label: 'Тема', kind: 'topic', required: true },
];

function field(label, control) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label }), control);
}

function selectEl(name, options, value, emptyLabel) {
  const sel = h('select', { name, class: 'input' });
  if (emptyLabel !== undefined) sel.append(h('option', { value: '', text: emptyLabel }));
  const vals = options.map(([v]) => v);
  for (const [v, label] of options) sel.append(h('option', { value: v, text: label }));
  if (value && !vals.includes(value)) sel.append(h('option', { value, text: String(value) }));
  sel.value = value ?? '';
  return sel;
}

function inputEl(name, value) {
  const el = h('input', { type: 'text', name, class: 'input', autocomplete: 'off' });
  el.value = value ?? '';
  return el;
}

function areaEl(name, value) {
  const el = h('textarea', { name, class: 'input', rows: 2 });
  el.value = value ?? '';
  return el;
}

function errMessage(e) {
  if (e && (e.code === 'CONFLICT' || e.status === 409)) return 'Такая карточка уже есть';
  return (e && e.message) || 'Ошибка';
}

export async function mount(container) {
  let filters = { query: '', topic: '', pos: '', status: '', check: false };
  let offset = 0;
  let total = 0;
  let reqId = 0;
  let disposed = false;
  let timer = null;

  const listEl = h('ul', { class: 'list' });
  const statusEl = h('p', { class: 'muted', role: 'status' });
  const moreBtn = h('button', { class: 'btn block', type: 'button', text: 'Показать ещё', hidden: true, onclick: () => load(false) });

  // ---------- добавление слова ----------
  const addTerm = inputEl('term', '');
  addTerm.required = true;
  const addTr = inputEl('translation', '');
  addTr.required = true;
  const addPos = selectEl('pos', POS_LIST.map((p) => [p, POS_RU[p] || p]), '', 'Авто (ИИ определит)');
  const addArticle = selectEl('article', ARTICLES.map((a) => [a, a]), '', '—');
  const addPlural = inputEl('plural', '');
  const addExample = areaEl('example', '');
  const addMsg = h('p', { class: 'error', role: 'alert', hidden: true });
  const addBtn = h('button', { class: 'btn primary block', type: 'submit', text: 'Добавить' });

  async function onAdd(e) {
    e.preventDefault();
    addMsg.hidden = true;
    let term = addTerm.value.trim();
    const translation = addTr.value.trim();
    let article = addArticle.value;
    let pos = addPos.value;
    // «der Hund» в поле слова → артикль отдельно
    const m = term.match(/^(der|die|das)\s+(.+)$/i);
    if (m && !article) { article = m[1].toLowerCase(); term = m[2].trim(); }
    if (!term || !translation) {
      addMsg.textContent = 'Заполните слово и перевод';
      addMsg.hidden = false;
      return;
    }
    const body = { term, translation };
    if (article) { body.article = article; body.pos = 'noun'; }
    else if (pos) { body.pos = pos; }
    if (addPlural.value.trim()) body.plural = addPlural.value.trim();
    if (addExample.value.trim()) body.example = addExample.value.trim();
    addBtn.disabled = true;
    try {
      await createCard(body);
      toast('Добавлено (ИИ дополнит карточку в фоне)');
      addTerm.value = ''; addTr.value = ''; addPos.value = ''; addPlural.value = ''; addExample.value = ''; addArticle.value = '';
      load(true);
      addTerm.focus();
    } catch (ex) {
      addMsg.textContent = errMessage(ex);
      addMsg.hidden = false;
    } finally {
      addBtn.disabled = false;
    }
  }

  const addBox = h('details', { class: 'card-box' },
    h('summary', { text: '+ Добавить слово' }),
    h('form', { class: 'stack', onsubmit: onAdd },
      field('Слово или выражение', addTerm),
      field('Перевод', addTr),
      field('Часть речи (необязательно)', addPos),
      field('Артикль (для существительных)', addArticle),
      field('Мн. число (необязательно)', addPlural),
      field('Пример (необязательно — ИИ может составить сам)', addExample),
      addMsg,
      addBtn
    )
  );

  // ---------- генерация слов через ИИ ----------
  const genTopic = selectEl('topic', [...TOPIC_LIST.map((t) => [t, t]), ['__custom__', '✏️ Своя тема…']], TOPIC_LIST[0] || 'Alltag');
  const genCustomTopic = h('input', { type: 'text', placeholder: 'Введите тему (напр. KI, Medizin…)', hidden: true });
  genTopic.addEventListener('change', () => {
    const isCustom = genTopic.value === '__custom__';
    genCustomTopic.hidden = !isCustom;
    if (isCustom) genCustomTopic.focus();
  });
  const genLevel = selectEl('level', LEVEL_LIST.map((l) => [l, l]), 'B2');
  const genCount = selectEl('count', [['5', '5 слов'], ['10', '10 слов'], ['15', '15 слов']], '10');
  const genBtn = h('button', { class: 'btn primary block', type: 'submit', text: 'Сгенерировать и добавить' });
  const genMsg = h('p', { class: 'muted', role: 'status', hidden: true });

  async function onGenerate(e) {
    e.preventDefault();
    const topic = genTopic.value === '__custom__' ? genCustomTopic.value.trim() : genTopic.value;
    if (!topic) {
      toast('Введите название темы');
      genCustomTopic.focus();
      return;
    }
    genBtn.disabled = true;
    genMsg.hidden = false;
    genMsg.textContent = 'ИИ подбирает слова…';
    try {
      const res = await generateWords({
        topic,
        level: genLevel.value,
        count: Number(genCount.value) || 10,
      });
      const addedCount = Array.isArray(res && res.items) ? res.items.length : 0;
      const dups = Number(res && res.dropped_duplicates) || 0;
      genMsg.textContent = `Добавлено в карточки: ${addedCount}` + (dups ? ` (пропущено дублей: ${dups})` : '');
      toast(`Добавлено новых слов: ${addedCount}`);
      load(true);
    } catch (ex) {
      genMsg.textContent = errMessage(ex);
    } finally {
      genBtn.disabled = false;
    }
  }

  const genBox = h('details', { class: 'card-box' },
    h('summary', { text: '✨ Сгенерировать слова через ИИ' }),
    h('form', { class: 'stack', onsubmit: onGenerate },
      h('div', { class: 'row' },
        field('Тема', genTopic),
        field('Уровень', genLevel),
        field('Количество', genCount)
      ),
      genCustomTopic,
      genMsg,
      genBtn
    )
  );

  // ---------- фильтры ----------
  const qInput = h('input', {
    type: 'search', class: 'input', placeholder: 'Поиск', 'aria-label': 'Поиск по карточкам',
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(() => { filters.query = qInput.value.trim(); load(true); }, 300);
    },
  });
  const statusSel = selectEl('status', [
    ['new', 'Новые'],
    ['learning', 'В изучении'],
    ['learned', 'Выученные ✓'],
  ], '', 'Все статусы');
  const topicSel = selectEl('topic', TOPIC_LIST.map((t) => [t, t]), '', 'Все темы');
  const posSel = selectEl('pos', POS_LIST.map((p) => [p, POS_RU[p] || p]), '', 'Все типы');
  const checkBox = h('input', { type: 'checkbox' });
  statusSel.addEventListener('change', () => { filters.status = statusSel.value; load(true); });
  topicSel.addEventListener('change', () => { filters.topic = topicSel.value; load(true); });
  posSel.addEventListener('change', () => { filters.pos = posSel.value; load(true); });
  checkBox.addEventListener('change', () => { filters.check = checkBox.checked; load(true); });

  const filtersBox = h('div', { class: 'filters' },
    qInput,
    h('div', { class: 'row' }, statusSel, topicSel, posSel),
    h('label', { class: 'row' }, checkBox, h('span', { text: 'Только требующие проверки' }))
  );

  // ---------- строка списка ----------
  function renderRow(card) {
    const li = h('li', { class: 'list-item' });
    const titleEl = h('div', { class: 'li-term', lang: 'de' });
    const trEl = h('div', { class: 'muted' });
    const chips = h('div', { class: 'row wrap' });
    const panel = h('div', { class: 'li-panel', hidden: true });
    let built = false;

    function paint() {
      titleEl.textContent = displayTerm(card);
      trEl.textContent = card.translation || '';
      const statusBadge = card.learning_status === 'learned'
        ? h('span', { class: 'badge ok', text: '✓ Выучена' })
        : card.learning_status === 'learning'
          ? h('span', { class: 'badge accent', text: 'В изучении' + (card.stability ? ` · ${Math.round(card.stability)} дн.` : '') })
          : h('span', { class: 'badge', text: 'Новая' });
      chips.replaceChildren(...[
        statusBadge,
        card.pos ? h('span', { class: 'badge', text: POS_RU[card.pos] || card.pos }) : null,
        card.rektion ? h('span', { class: 'badge accent', text: card.rektion }) : null,
        card.level ? h('span', { class: 'badge accent', text: card.level }) : null,
        card.topic ? h('span', { class: 'badge', text: card.topic }) : null,
        card.check_flag ? h('span', { class: 'badge warn', text: 'проверить' }) : null,
        card.enriched === false ? h('span', { class: 'badge', text: 'не обогащена' }) : null,
      ].filter(Boolean));
    }

    function remove() {
      li.remove();
      total = Math.max(0, total - 1);
      offset = Math.max(0, offset - 1);
      statusEl.textContent = total ? `Всего: ${total}` : 'Ничего не найдено';
    }

    function buildPanel() {
      const ctl = {};
      const status = h('p', { class: 'muted', role: 'status' });
      const form = h('form', { class: 'stack', onsubmit: save });
      for (const f of FIELDS) {
        let el;
        if (f.kind === 'article') el = selectEl(f.key, ARTICLES.map((a) => [a, a]), card.article, '—');
        else if (f.kind === 'pos') el = selectEl(f.key, POS_LIST.map((p) => [p, POS_RU[p] || p]), card.pos);
        else if (f.kind === 'level') el = selectEl(f.key, LEVEL_LIST.map((l) => [l, l]), card.level);
        else if (f.kind === 'topic') el = selectEl(f.key, TOPIC_LIST.map((t) => [t, t]), card.topic);
        else if (f.kind === 'area') el = areaEl(f.key, card[f.key]);
        else el = inputEl(f.key, card[f.key]);
        ctl[f.key] = el;
        form.append(field(f.label, el));
      }
      const flag = h('input', { type: 'checkbox', checked: !!card.check_flag });
      form.append(
        h('label', { class: 'row' }, flag, h('span', { text: 'Нужна проверка (⚠)' })),
        status,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'submit', text: 'Сохранить' }),
          h('button', { class: 'btn danger', type: 'button', text: 'Удалить', onclick: del }))
      );

      async function save(e) {
        e.preventDefault();
        const patch = {};
        for (const f of FIELDS) {
          const raw = String(ctl[f.key].value ?? '').trim();
          if (f.required && !raw) { status.textContent = 'Заполните поле: ' + f.label; return; }
          const next = raw === '' ? null : raw;
          const prev = card[f.key] === undefined || card[f.key] === '' ? null : card[f.key];
          if (next !== prev) patch[f.key] = next;
        }
        if (flag.checked !== !!card.check_flag) patch.check_flag = flag.checked;
        if (!Object.keys(patch).length) { status.textContent = 'Нет изменений'; return; }
        status.textContent = 'Сохраняем…';
        try {
          const updated = await patchCard(card.id, patch);
          if (updated && typeof updated === 'object') Object.assign(card, updated);
          paint();
          status.textContent = '';
          toast('Сохранено');
        } catch (ex) {
          status.textContent = errMessage(ex);
        }
      }

      async function del() {
        if (!window.confirm(`Удалить карточку «${displayTerm(card)}»?`)) return;
        try {
          await deleteCard(card.id);
          toast('Удалено');
          remove();
        } catch (ex) {
          status.textContent = errMessage(ex);
        }
      }

      const learnedBtn = h('button', {
        class: 'btn small',
        type: 'button',
        text: card.learning_status === 'learned' ? '↺ Вернуть в обучение' : '✓ Отметить выученной',
        onclick: async () => {
          learnedBtn.disabled = true;
          try {
            const targetLearned = card.learning_status !== 'learned';
            const updated = await setCardLearned(card.id, targetLearned);
            if (updated && typeof updated === 'object') Object.assign(card, updated);
            learnedBtn.textContent = card.learning_status === 'learned' ? '↺ Вернуть в обучение' : '✓ Отметить выученной';
            paint();
            toast(targetLearned ? 'Карточка отмечена выученной ✓' : 'Карточка возвращена в обучение');
          } catch (ex) {
            status.textContent = errMessage(ex);
          } finally {
            learnedBtn.disabled = false;
          }
        },
      });

      panel.append(
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', type: 'button', text: '🔊 Слово', onclick: () => { speakText(displayTerm(card)); } }),
          card.example ? h('button', { class: 'btn small', type: 'button', text: '🔊 Пример', onclick: () => { speakText(card.example); } }) : null,
          learnedBtn),
        form
      );
    }

    const head = h('button', {
      type: 'button', class: 'li-head', 'aria-expanded': 'false',
      onclick: () => {
        if (panel.hidden) {
          if (!built) { built = true; buildPanel(); }
          panel.hidden = false;
          head.setAttribute('aria-expanded', 'true');
        } else {
          panel.hidden = true;
          head.setAttribute('aria-expanded', 'false');
        }
      },
    }, titleEl, trEl, chips);

    paint();
    li.append(head, panel);
    return li;
  }

  // ---------- загрузка ----------
  async function load(reset) {
    const my = ++reqId;
    if (reset) { offset = 0; total = 0; listEl.replaceChildren(); }
    statusEl.textContent = 'Загрузка…';
    moreBtn.hidden = true;
    try {
      const r = await getCards({ query: filters.query, topic: filters.topic, pos: filters.pos, status: filters.status, check: filters.check, limit: PAGE, offset });
      if (my !== reqId || disposed) return;
      const got = Array.isArray(r && r.items) ? r.items : [];
      got.forEach((c) => { if (c && typeof c === 'object') listEl.append(renderRow(c)); });
      offset += got.length;
      total = Number.isFinite(r && r.total) ? r.total : offset;
      statusEl.textContent = total ? `Всего: ${total}` : 'Ничего не найдено';
      moreBtn.hidden = got.length === 0 || offset >= total;
    } catch (e) {
      if (my !== reqId || disposed) return;
      statusEl.textContent = (e && e.message) || 'Не удалось загрузить карточки';
    }
  }

  container.append(h('h1', { text: 'Карточки' }), addBox, genBox, filtersBox, statusEl, listEl, moreBtn);
  load(true);
  return () => { disposed = true; clearTimeout(timer); };
}