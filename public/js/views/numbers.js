// Тренажёр чисел на слух (M14). Без ИИ: задания и проверка из /shared/numbers_de.js.
import {
  CATEGORIES, makeRng, generateItem, gradeNumber, pickCategory, nextLevel,
} from '/shared/numbers_de.js';
import { numbersPostAttempts, numbersStats } from '../api2.js';
import { speak, hasGermanVoice, voicesReady } from '../tts.js';

const ITEMS_PER_SESSION = 10;

const CAT_RU = {
  cardinal: 'Числа', year: 'Годы', date: 'Даты', time: 'Время',
  price: 'Цены', phone: 'Телефоны', percent: 'Проценты', decimal: 'Дроби',
};
const PATTERN_RU = {
  tens_units_swap: 'Единицы и десятки местами (25 ↔ 52)',
  teen_ty: '-zehn ↔ -zig (16 ↔ 60)',
  digit_drop: 'Пропущена или лишняя цифра',
  digit_swap: 'Цифры переставлены',
  magnitude: 'Неверное число нулей',
  ampm: '12 ↔ 24 часа',
  halb_trap: 'Ловушка «halb»',
  other: 'Другое',
};
const DIFF_RU = { easy: 'Лёгкий', medium: 'Средний', hard: 'Сложный' };

/** Мини-хелпер DOM: только textContent, никакого innerHTML. */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  const p = props || {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'onclick') n.addEventListener('click', v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

const clampPlays = (d) => (d === 'easy' ? Infinity : d === 'hard' ? 1 : 2);
const inputModeFor = (cat) => (cat === 'phone' || cat === 'cardinal' || cat === 'year' ? 'tel' : 'decimal');

export function mount(container, ctx = {}) {
  const settings = ctx.settings && typeof ctx.settings === 'object' ? ctx.settings : {};
  const difficulty = ['easy', 'medium', 'hard'].includes(settings.difficulty) ? settings.difficulty : 'medium';
  const maxPlays = clampPlays(difficulty);
  const baseRate = Number.isFinite(Number(settings.tts_rate)) && Number(settings.tts_rate) > 0 ? Number(settings.tts_rate) : 0.9;
  const voice = typeof settings.tts_voice === 'string' ? settings.tts_voice : '';
  const go = (hash) => {
    if (typeof ctx.navigate === 'function') ctx.navigate(hash);
    else location.hash = hash;
  };

  const root = el('div', { class: 'numbers-view' });
  container.replaceChildren(root);

  let alive = true;
  let phase = 'setup'; // setup | question | feedback | summary
  let s = null; // состояние сессии
  let statsByCat = {};
  let keyGuard = 0;

  // Статистика нужна только для pickCategory; ошибки сети не критичны
  const statsReady = numbersStats()
    .then((st) => { if (st && typeof st.by_category === 'object' && st.by_category) statsByCat = st.by_category; })
    .catch(() => {});

  function stopSpeech() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  // ---------- Экран настройки ----------
  function renderSetup() {
    phase = 'setup';
    stopSpeech();
    const catSel = el('select', { id: 'num-cat', class: 'input' },
      el('option', { value: 'mixed', text: 'Все категории (микс)' }),
      CATEGORIES.map((c) => el('option', { value: c, text: CAT_RU[c] || c })));
    const lvlSel = el('select', { id: 'num-lvl', class: 'input' },
      el('option', { value: 'auto', text: 'Авто' }),
      [1, 2, 3, 4].map((n) => el('option', { value: n, text: `Уровень ${n}` })));
    const startBtn = el('button', { class: 'btn primary', type: 'button', text: 'Начать (10 заданий)' });
    const warn = el('p', { class: 'muted' });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      await statsReady;
      await voicesReady(800);
      if (!alive) return;
      startSession(catSel.value, lvlSel.value);
    });
    root.replaceChildren(
      el('h2', { text: 'Числа на слух' }),
      el('p', { class: 'muted', text: `Сложность: ${DIFF_RU[difficulty]}. Прослушиваний на задание: ${maxPlays === Infinity ? 'без ограничений' : maxPlays}.` }),
      el('label', { for: 'num-cat', text: 'Категория' }), catSel,
      el('label', { for: 'num-lvl', text: 'Уровень' }), lvlSel,
      warn,
      startBtn,
    );
    if (!('speechSynthesis' in window) || !hasGermanVoice()) {
      warn.textContent = 'Немецкий голос не найден. Установите немецкий голос в системе, иначе озвучки не будет.';
    }
  }

  function startSession(catChoice, lvlChoice) {
    const startLevel = lvlChoice === 'auto'
      ? Math.min(4, Math.max(1, Math.round(Number(settings.numbers_level)) || 2))
      : Number(lvlChoice) || 1;
    s = {
      cat: CATEGORIES.includes(catChoice) ? catChoice : 'mixed',
      auto: lvlChoice === 'auto',
      level: startLevel,
      rng: makeRng(Date.now()),
      results: [],
      shown: [],
      idx: 0,
      startedAt: Date.now(),
      saved: false,
    };
    nextQuestion();
  }

  // ---------- Вопрос ----------
  function nextQuestion() {
    if (s.idx >= ITEMS_PER_SESSION) return renderSummary();
    const cat = s.cat === 'mixed' ? pickCategory(statsByCat, s.rng) : s.cat;
    const item = generateItem(cat, s.level, s.rng);
    s.cur = { item, plays: 0, shownAt: Date.now(), firstPlayAt: null, playing: false };
    renderQuestion();
  }

  async function play(rate, counted) {
    const c = s.cur;
    if (!c || c.playing) return false;
    if (counted && c.plays >= maxPlays) return false;
    c.playing = true;
    if (counted) {
      c.plays += 1;
      if (!c.firstPlayAt) c.firstPlayAt = Date.now();
    }
    updatePlayUi();
    const ok = await speak(c.item.spoken, { rate, voice });
    c.playing = false;
    // Не прозвучало из-за отсутствия голоса: не тратим попытку
    if (!ok && counted && !hasGermanVoice()) {
      c.plays = Math.max(0, c.plays - 1);
      if (c.plays === 0) c.firstPlayAt = null;
    }
    if (alive) updatePlayUi();
    return ok;
  }

  let playBtn = null;
  let slowBtn = null;
  let playInfo = null;
  function updatePlayUi() {
    const c = s && s.cur;
    if (!c || !playBtn) return;
    const left = maxPlays === Infinity ? Infinity : maxPlays - c.plays;
    playBtn.disabled = c.playing || left <= 0;
    if (slowBtn) slowBtn.disabled = c.playing;
    playBtn.textContent = c.playing ? '… звучит' : '▶ Прослушать';
    if (playInfo) {
      playInfo.textContent = left === Infinity ? 'Прослушиваний: без ограничений'
        : `Осталось прослушиваний: ${Math.max(0, left)}`;
    }
  }

  function renderQuestion() {
    phase = 'question';
    const { item } = s.cur;
    const input = el('input', {
      class: 'input num-input', type: 'text', inputmode: inputModeFor(item.category),
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      enterkeyhint: 'go', maxlength: 60, 'aria-label': 'Ответ',
    });
    const msg = el('p', { class: 'muted', role: 'status' });
    playBtn = el('button', { class: 'btn primary big', type: 'button', text: '▶ Прослушать', 'aria-label': 'Прослушать задание' });
    playBtn.style.minHeight = '64px';
    playBtn.style.width = '100%';
    playBtn.style.fontSize = '1.3rem';
    playBtn.addEventListener('click', () => play(baseRate, true));
    playInfo = el('p', { class: 'muted' });
    slowBtn = difficulty === 'easy'
      ? el('button', { class: 'btn', type: 'button', text: 'Медленно (0.8)', onclick: () => play(0.8, true) })
      : null;

    const submit = () => {
      const raw = input.value.trim();
      if (!raw) { msg.textContent = 'Введите ответ или нажмите «Не знаю».'; return; }
      finish(raw);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    root.replaceChildren(
      el('div', { class: 'muted', text: `Задание ${s.idx + 1} из ${ITEMS_PER_SESSION} · ${CAT_RU[item.category] || item.category} · уровень ${item.level}` }),
      el('progress', { max: ITEMS_PER_SESSION, value: s.idx, style: 'width:100%' }),
      el('p', { text: item.hint_ru || '' }),
      playBtn, slowBtn, playInfo,
      input, msg,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', type: 'button', text: 'Проверить', onclick: submit }),
        el('button', { class: 'btn', type: 'button', text: 'Не знаю', onclick: () => finish('') })),
    );
    updatePlayUi();
    try { input.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  // ---------- Обратная связь ----------
  function finish(raw) {
    if (phase !== 'question' || !s.cur) return;
    const c = s.cur;
    const g = gradeNumber(c.item, raw);
    const startedAt = c.firstPlayAt || c.shownAt;
    const rec = {
      category: c.item.category,
      level: c.item.level,
      expected: String(c.item.expected).slice(0, 60),
      answer: String(raw).slice(0, 60),
      correct: !!g.correct,
      response_ms: Math.max(0, Math.min(600000, Date.now() - startedAt)),
      plays: Math.max(1, c.plays),
      pattern: g.correct ? null : (g.pattern || 'other'),
    };
    s.results.push(rec);
    if (s.auto) s.level = nextLevel(s.level, s.results);
    s.idx += 1;
    keyGuard = Date.now();
    renderFeedback(c.item, rec, g);
  }

  function renderFeedback(item, rec, g) {
    phase = 'feedback';
    stopSpeech();
    const last = s.idx >= ITEMS_PER_SESSION;
    const replay = el('button', { class: 'btn', type: 'button', text: 'Повторить озвучку', onclick: () => speak(item.spoken, { rate: baseRate, voice }) });
    const nextBtn = el('button', { class: 'btn primary', type: 'button', text: last ? 'Итоги' : 'Далее', onclick: () => advance() });
    const row = (label, value) => el('div', { class: 'row' },
      el('span', { class: 'muted', text: label + ': ' }), el('strong', { text: value || '—' }));
    root.replaceChildren(
      el('h3', { text: rec.correct ? '✓ Верно' : '✗ Неверно' }),
      row('Вы ввели', rec.answer),
      row('Правильно', String(item.expected)),
      row('По-немецки', item.spoken),
      el('p', { text: g.note_ru || '' }),
      item.trap_ru ? el('p', { class: 'muted', text: item.trap_ru }) : null,
      el('div', { class: 'row' }, replay, nextBtn),
    );
  }

  function advance() {
    if (phase !== 'feedback') return;
    nextQuestion();
  }

  // Enter на экране обратной связи = далее (с защитой от залипания Enter после отправки)
  function onKey(e) {
    if (e.key !== 'Enter' || phase !== 'feedback') return;
    if (Date.now() - keyGuard < 250) return;
    e.preventDefault();
    advance();
  }
  document.addEventListener('keydown', onKey);

  // ---------- Итоги ----------
  async function save(statusEl, retryBtn) {
    retryBtn.disabled = true;
    statusEl.textContent = 'Сохраняю…';
    try {
      const seconds = Math.max(0, Math.round((Date.now() - s.startedAt) / 1000));
      await numbersPostAttempts(s.results, seconds);
      s.saved = true;
      statusEl.textContent = 'Результаты сохранены.';
      retryBtn.hidden = true;
    } catch (e) {
      statusEl.textContent = (e && e.message ? e.message : 'Не удалось сохранить') + '. Результаты на экране сохранены, попробуйте ещё раз.';
      retryBtn.disabled = false;
    }
  }

  function renderSummary() {
    phase = 'summary';
    stopSpeech();
    const total = s.results.length;
    const ok = s.results.filter((r) => r.correct).length;
    const byCat = {};
    const patterns = {};
    for (const r of s.results) {
      const b = byCat[r.category] || (byCat[r.category] = { n: 0, ok: 0 });
      b.n += 1;
      if (r.correct) b.ok += 1;
      else if (r.pattern) patterns[r.pattern] = (patterns[r.pattern] || 0) + 1;
    }
    const topPatterns = Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const status = el('p', { class: 'muted', role: 'status' });
    const retry = el('button', { class: 'btn', type: 'button', text: 'Сохранить ещё раз', hidden: true });
    retry.addEventListener('click', () => { retry.hidden = false; save(status, retry); });

    root.replaceChildren(
      el('h2', { text: 'Итоги' }),
      el('div', { class: 'card-box stack' },
        el('div', { class: 'score-big', text: `${total ? Math.round((ok / total) * 100) : 0}%` }),
        el('div', { class: 'stat-label', text: `Верно ${ok} из ${total}` }),
      ),
      el('h3', { text: 'По категориям' }),
      el('ul', {}, Object.entries(byCat).map(([c, b]) =>
        el('li', { text: `${CAT_RU[c] || c}: ${b.ok}/${b.n}` }))),
      topPatterns.length ? el('h3', { text: 'Частые ошибки' }) : null,
      topPatterns.length ? el('ul', {}, topPatterns.map(([p, n]) =>
        el('li', { text: `${PATTERN_RU[p] || p}: ${n}` }))) : null,
      status, retry,
      el('div', { class: 'row' },
        el('button', { class: 'btn primary', type: 'button', text: 'Ещё раз', onclick: () => renderSetup() }),
        el('button', { class: 'btn', type: 'button', text: 'На главную', onclick: () => go('#/today') })),
    );
    retry.hidden = true;
    // Показываем кнопку повтора только при ошибке сохранения
    const origSave = save;
    origSave(status, retry).then(() => { if (!s.saved) retry.hidden = false; });
  }

  renderSetup();

  // Очистка при уходе со страницы
  return () => {
    alive = false;
    document.removeEventListener('keydown', onKey);
    stopSpeech();
  };
}

export default mount;