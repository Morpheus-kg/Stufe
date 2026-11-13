// Раннер сессии (v2): сложность, автопереходы, компактная оценка, корзина предложений
import { h, navigate, offline, state, toast, speakText, displayTerm, POS_RU } from '../app.js';
import { postReviews, putSettings, setCardLearned } from '../api.js';
import { gradeTyped, autoRating } from '/shared/grading.js';
import { MAX_HINT_STEP } from '/shared/hints.js';
import { fetchSession, clearCurrent } from './today.js';
import { voicesReady } from '../tts.js';

const MODE_OK = new Set(['ru_de', 'cloze', 'article', 'sentence']);
const RESULTS = ['correct', 'almost', 'wrong'];
const RATINGS = [[1, 'Снова'], [2, 'Трудно'], [3, 'Хорошо'], [4, 'Легко']];
const RATING_LABEL = { 1: 'Снова', 2: 'Трудно', 3: 'Хорошо', 4: 'Легко' };
const DIFFS = [['easy', 'Лёгкий'], ['medium', 'Средний'], ['hard', 'Сложный']];
const RESTART = Symbol('restart');

const BASKET_KEY = 'sentence_basket';
const BASKET_MAX = 12;
const BASKET_TTL_MS = 3 * 24 * 3600 * 1000;
const BATCH_CHUNK = 6;

const modeCache = new Map();
function loadMode(mode) {
  if (!MODE_OK.has(mode)) return Promise.resolve(null);
  if (!modeCache.has(mode)) modeCache.set(mode, import(`../modes/${mode}.js`).catch(() => null));
  return modeCache.get(mode);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function ruPlural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function uuid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* небезопасный контекст */ }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function validItem(it) {
  return it && typeof it === 'object' && typeof it.key === 'string' && Number.isInteger(it.card_id)
    && MODE_OK.has(it.mode) && it.card && typeof it.card === 'object';
}

// ---------- ключи отвеченных элементов (нужны только для офлайн-кеша очереди) ----------
function loadDone(date) {
  const key = 'gt_done_' + date;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('gt_done_') && k !== key) localStorage.removeItem(k);
    }
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveDone(date, set) {
  try { localStorage.setItem('gt_done_' + date, JSON.stringify([...set])); } catch { /* квота */ }
}

// ---------- корзина предложений (localStorage['sentence_basket']) ----------
// Запись: {card_id, source, answer, reference, added_at}; одна на карточку, максимум 12, не старше 3 дней
function basketLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(BASKET_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    const byCard = new Map();
    for (const e of raw) {
      if (!e || typeof e !== 'object') continue;
      const t = Date.parse(e.added_at);
      if (!Number.isInteger(e.card_id) || typeof e.source !== 'string' || typeof e.answer !== 'string') continue;
      if (!e.source.trim() || !e.answer.trim()) continue;
      if (!Number.isFinite(t) || now - t > BASKET_TTL_MS) continue;
      byCard.set(e.card_id, {
        card_id: e.card_id, source: e.source, answer: e.answer,
        reference: typeof e.reference === 'string' ? e.reference : '', added_at: e.added_at,
      });
    }
    return [...byCard.values()].sort((a, b) => Date.parse(a.added_at) - Date.parse(b.added_at)).slice(-BASKET_MAX);
  } catch {
    return [];
  }
}
function basketSave(list) {
  try { localStorage.setItem(BASKET_KEY, JSON.stringify(list)); } catch { /* квота */ }
}
function basketAdd(entry) {
  const list = basketLoad().filter((e) => e.card_id !== entry.card_id);
  list.push(entry);
  basketSave(list.slice(-BASKET_MAX));
}
function basketClear() {
  try { localStorage.removeItem(BASKET_KEY); } catch { /* ignore */ }
}

function batchErrorText(e) {
  const keep = ' Предложения сохранены в корзине.';
  const code = e && e.code;
  if (code === 'AI_CAP') return 'Дневной лимит проверок ИИ исчерпан.' + keep;
  if (code === 'AI_UNAVAILABLE') return 'ИИ сейчас недоступен, попробуйте позже.' + keep;
  if (code === 'RATE_LIMITED') return 'Слишком много запросов, подождите минуту.' + keep;
  if (e && e.status === 0) return 'Нет соединения с сервером.' + keep;
  return ((e && e.message) || 'Не удалось проверить предложения.') + keep;
}

// Запасной вывод результата, если ui/batch_result.js недоступен
function fallbackBatchResult(out, result) {
  const items = Array.isArray(result && result.items) ? result.items : [];
  out.append(h('h3', { text: `Оценка: ${Number.isFinite(result && result.score) ? result.score : '—'} / 100` }));
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    out.append(h('div', { class: 'card-box stack' },
      h('div', { class: 'muted', text: `Предложение ${Number(it.idx) + 1}: ${it.answered ? it.score + ' / 100' : 'нет ответа'}` }),
      it.corrected ? h('div', { lang: 'de', text: String(it.corrected) }) : null,
      it.comment_ru ? h('div', { class: 'muted', text: String(it.comment_ru) }) : null));
  }
  const overall = result && result.summary && result.summary.overall_ru;
  if (overall) out.append(h('p', { text: String(overall) }));
}

/** Ожидаемый ответ: из режима (mod.expected) либо по контракту */
function expectedFor(mod, item, userAnswer, difficulty) {
  try {
    if (mod && typeof mod.expected === 'function') {
      const e = mod.expected(item, userAnswer, difficulty);
      if (typeof e === 'string' && e) return e;
    }
  } catch { /* запасной вариант ниже */ }
  const c = item.card || {};
  if (item.mode === 'cloze') return String(c.cloze_answer || '');
  return c.pos === 'noun' ? displayTerm(c) : String(c.term || '');
}

function renderDiff(diff) {
  const wrap = h('div', { class: 'diff' });
  for (const d of diff) {
    if (!d || typeof d.w !== 'string') continue;
    if (d.t === 'del') wrap.append(h('del', { class: 'd-del', title: 'лишнее слово', text: '−' + d.w }));
    else if (d.t === 'ins') wrap.append(h('ins', { class: 'd-ins', title: 'пропущено', text: '+' + d.w }));
    else wrap.append(h('span', { class: 'd-same', text: d.w }));
  }
  wrap.append(h('div', { class: 'muted legend', text: '−слово — лишнее, +слово — пропущено' }));
  return wrap;
}

function buildFeedback({ result, note, expected, diff, card }) {
  const titles = { correct: '✓ Верно', almost: '≈ Почти верно', wrong: '✗ Неверно' };
  const box = h('div', { class: 'feedback ' + result, role: 'status' }, h('div', { class: 'fb-title', text: titles[result] }));
  if (note) box.append(h('div', { class: 'fb-note', text: note }));
  if (expected) {
    box.append(h('div', { class: 'fb-expected row wrap' },
      h('span', { class: 'muted', text: 'Правильно:' }),
      h('strong', { lang: 'de', text: expected }),
      h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Озвучить ответ', text: '🔊', onclick: () => { speakText(expected); } })
    ));
  }
  if (diff.some((d) => d && d.t && d.t !== 'same')) box.append(renderDiff(diff));
  if (card.example && card.example !== expected) {
    box.append(h('div', { class: 'fb-example' },
      h('div', { lang: 'de', text: card.example }),
      card.example_translation ? h('div', { class: 'muted', text: card.example_translation }) : null
    ));
  }
  return box;
}

export async function mount(container) {
  let cancelled = false;
  let keyHandler = null;
  let restartCurrent = null; // не null только пока открыт режим (смена сложности перезапускает карточку)
  let stopLearn = null;
  let putTimer = null;

  const setKeys = (fn) => {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = fn;
    if (fn) document.addEventListener('keydown', fn);
  };
  const getDiff = () => (['easy', 'medium', 'hard'].includes(state.settings.difficulty) ? state.settings.difficulty : 'medium');
  const cleanup = () => {
    cancelled = true;
    setKeys(null);
    if (stopLearn) { stopLearn(); stopLearn = null; }
    if (putTimer) { // не теряем выбор сложности, если ушли до отправки
      clearTimeout(putTimer);
      putTimer = null;
      putSettings({ difficulty: getDiff() }).catch(() => {});
    }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* ignore */ }
  };

  container.replaceChildren(h('p', { class: 'muted center', text: 'Загружаем очередь…' }));
  run().catch(() => { if (!cancelled) showError('Что-то пошло не так'); });
  return cleanup;

  // ---------- вспомогательные экраны ----------
  function showError(message) {
    container.replaceChildren(
      h('div', { class: 'card-box stack center' },
        h('p', { class: 'error', text: message }),
        h('button', { class: 'btn primary', type: 'button', text: 'Повторить', onclick: () => navigate('#/review') }),
        h('button', { class: 'btn', type: 'button', text: 'На главную', onclick: () => navigate('#/today') })
      )
    );
  }

  async function saveReview(record) {
    const o = await offline();
    try {
      if (o.enqueueReview) {
        await o.enqueueReview(record);
        if (o.flush) Promise.resolve(o.flush()).catch(() => {});
        return;
      }
    } catch { /* пробуем отправить напрямую */ }
    try { await postReviews({ reviews: [record] }); } catch { toast('Ответ не сохранён: нет связи'); }
  }

  // ---------- основной цикл ----------
  async function run() {
    let info;
    try {
      const o = await offline();
      if (o.flush) await Promise.race([Promise.resolve().then(() => o.flush()).catch(() => {}), sleep(3000)]);
      info = await fetchSession();
    } catch (e) {
      if (!cancelled) showError((e && e.message) || 'Не удалось загрузить очередь');
      return;
    }
    if (cancelled) return;

    const date = String(info.session.date || '');
    const doneKeys = loadDone(date);
    let queue = info.session.queue.filter(validItem).filter((it) => !doneKeys.has(it.key));

    async function markCardLearned(card, idx) {
      if (!card || !card.id) return;
      for (const m of MODE_OK) doneKeys.add(`${card.id}:${m}`);
      saveDone(date, doneKeys);
      for (let k = queue.length - 1; k > idx; k--) {
        if (queue[k] && queue[k].card_id === card.id) queue.splice(k, 1);
      }
      clearCurrent();
      try {
        await setCardLearned(card.id, true);
        toast('Отмечено как выученное ✓');
      } catch {
        toast('Скрыто на сегодня (нет связи для сохранения статуса)');
      }
    }

    // --- шапка: счётчик, выход, чипы сложности, прогресс ---
    const counter = h('span', { class: 'muted' });
    const barFill = h('div', { class: 'progress-fill' });
    const voiceHint = h('p', { class: 'muted', hidden: true, text: 'Для озвучки установите немецкий голос в настройках системы.' });
    const stage = h('div', { class: 'stage' });

    const chipBtns = DIFFS.map(([d, label]) => h('button', {
      type: 'button', text: label, 'aria-pressed': 'false', onclick: () => setDifficulty(d),
    }));
    function paintChips() {
      chipBtns.forEach((b, i) => {
        const on = DIFFS[i][0] === getDiff();
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('active', on);
      });
    }
    function setDifficulty(d) {
      if (d === getDiff()) return;
      state.settings.difficulty = d;
      paintChips();
      clearTimeout(putTimer);
      putTimer = setTimeout(() => {
        putTimer = null;
        putSettings({ difficulty: d }).catch(() => toast('Не удалось сохранить сложность'));
      }, 500);
      if (restartCurrent) restartCurrent(); // применяем сразу к текущей карточке
    }
    paintChips();

    container.replaceChildren(
      h('div', { class: 'review-top' },
        counter,
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Сложность' }, chipBtns),
        h('div', { class: 'row gap-xs' },
          h('button', {
            class: 'btn sm',
            type: 'button',
            text: '✓ Итоги',
            title: 'Завершить сессию, подвести итоги и проверить предложения',
            onclick: () => {
              cancelled = true;
              showSummary();
            },
          }),
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            text: '✕ Выйти',
            onclick: async () => {
              cancelled = true;
              try {
                const o = await offline();
                if (o.flush) await o.flush();
              } catch {}
              navigate('#/today');
            },
          })
        )),
      h('div', { class: 'progress' }, barFill),
      voiceHint,
      stage
    );
    voicesReady().then((ok) => { if (!cancelled && !ok) voiceHint.hidden = false; });

    const stats = { answered: 0, correct: 0 };
    const learnSeen = new Set();

    const updateProgress = (idx) => {
      counter.textContent = `${Math.min(idx + 1, queue.length)} / ${queue.length}`;
      barFill.style.width = Math.round((100 * idx) / Math.max(queue.length, 1)) + '%';
    };

    // ---------- экран изучения с автопереходом ----------
    function showLearn(card) {
      return new Promise((resolve) => {
        const secs = clampInt(state.settings.learn_auto_seconds, 0, 30, 6);
        const shownAt = performance.now();
        let remaining = secs;
        let paused = false;
        let speaking = false;
        let finished = false;
        let tick = null;

        const cd = secs > 0 ? h('button', { class: 'btn small ghost block', type: 'button', 'aria-pressed': 'false', onclick: togglePause }) : null;
        function paintCd() {
          if (!cd) return;
          if (paused) cd.textContent = '⏸ Пауза — нажмите, чтобы продолжить';
          else if (remaining > 0) cd.textContent = `⏱ Автопереход через ${remaining} с — нажмите, чтобы остановить`;
          else cd.textContent = '⏱ Дослушиваем…';
          cd.setAttribute('aria-pressed', String(paused));
        }
        function togglePause() { paused = !paused; paintCd(); }
        function go(learned = false) {
          if (finished) return;
          finished = true;
          clearInterval(tick);
          stopLearn = null;
          setKeys(null);
          try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* ignore */ }
          resolve(learned === true);
        }
        stopLearn = () => go(false);

        const sayBtn = (label, text) => (text
          ? h('button', { class: 'btn small', type: 'button', text: '🔊 ' + label, 'aria-label': 'Озвучить: ' + label, onclick: () => { speakText(text); } })
          : null);
        const art = ['der', 'die', 'das'].includes(card.article) ? card.article : 'none';
        stage.replaceChildren(
          h('div', { class: 'card-box learn stack' },
            h('div', { class: 'row wrap' },
              h('span', { class: 'chip accent', text: 'Новое слово' }),
              card.pos ? h('span', { class: 'chip', text: POS_RU[card.pos] || card.pos }) : null),
            h('div', { class: 'big-term article-' + art, lang: 'de', text: displayTerm(card) }),
            card.plural ? h('div', { class: 'muted', lang: 'de', text: 'мн. ч.: ' + card.plural }) : null,
            h('div', { class: 'translation', text: card.translation || '' }),
            card.grammar ? h('div', { class: 'muted', text: card.grammar }) : null,
            card.example
              ? h('div', { class: 'example' }, h('div', { lang: 'de', text: card.example }),
                  card.example_translation ? h('div', { class: 'muted', text: card.example_translation }) : null)
              : null,
            h('div', { class: 'row wrap' }, sayBtn('слово', displayTerm(card)), sayBtn('пример', card.example)),
            cd,
            h('div', { class: 'row wrap' },
              h('button', { class: 'btn primary', style: 'flex: 2;', type: 'button', text: 'К тесту', onclick: () => go(false) }),
              h('button', { class: 'btn ghost', style: 'flex: 1;', type: 'button', title: 'Слово уже хорошо знакомо — убрать в выученные', text: '✓ Уже знаю', onclick: () => go(true) }),
            )
          )
        );
        setKeys((e) => {
          const t = e.target;
          if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
          if (performance.now() - shownAt < 400) return;
          if (e.key === 'Enter') { e.preventDefault(); go(false); }
        });

        if (secs > 0) {
          paintCd();
          // слово, затем пример один раз
          (async () => {
            speaking = true;
            try {
              await speakText(displayTerm(card));
              if (!finished && card.example) await speakText(card.example);
            } catch { /* озвучка не критична */ }
            speaking = false;
          })();
          tick = setInterval(() => {
            if (paused || finished) return;
            if (remaining > 0) remaining -= 1;
            paintCd();
            if (remaining <= 0 && !speaking) go();
          }, 1000);
        }
      });
    }

    // ---------- обратная связь, компактная оценка, автопереход ----------
    function showFeedbackAndRate({ result, note, expected, diff, card, auto, usedHints }) {
      return new Promise((resolve) => {
        const shownAt = performance.now();
        const autoMs = clampInt(state.settings.auto_next_ms, 0, 5000, 900);
        let selected = auto;
        let finished = false;
        let autoTimer = null;
        let bar = null;

        const chip = h('span', { class: 'chip accent' });
        const paintChip = () => {
          chip.textContent = `Оценка: ${RATING_LABEL[selected]}${selected === auto ? ' (авто)' : ' (изменено)'}`;
        };
        const btns = RATINGS.map(([n, label]) => h('button', {
          class: 'btn rate r' + n, type: 'button', 'aria-pressed': String(n === selected), text: label,
          onclick: (e) => { select(n); e.currentTarget.blur(); },
        }));
        const ratingRow = h('div', { class: 'rating-row', hidden: true }, btns);
        const changeBtn = h('button', {
          class: 'btn small ghost', type: 'button', text: 'изменить', 'aria-expanded': 'false', title: 'Клавиши 1–4',
          onclick: () => {
            ratingRow.hidden = !ratingRow.hidden;
            changeBtn.setAttribute('aria-expanded', String(!ratingRow.hidden));
            cancelAuto();
          },
        });

        function cancelAuto() {
          if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
          if (bar) { bar.remove(); bar = null; }
        }
        function select(n) {
          selected = n;
          btns.forEach((b, i) => b.setAttribute('aria-pressed', String(RATINGS[i][0] === n)));
          paintChip();
          cancelAuto();
        }
        function finish() {
          if (finished) return;
          finished = true;
          cancelAuto();
          stage.removeEventListener('pointerdown', cancelAuto);
          setKeys(null);
          resolve(selected);
        }

        const learnedBtn = h('button', {
          class: 'btn small ghost', type: 'button', text: '✓ Уже знаю (выучено)',
          title: 'Пометить карточку как полностью выученную',
          onclick: () => {
            selected = 'learned';
            finish();
          },
        });

        const next = h('button', { class: 'btn primary block next-btn', type: 'button', text: 'Далее', onclick: finish });
        stage.append(
          buildFeedback({ result, note, expected, diff, card }),
          h('div', { class: 'row wrap' }, chip, changeBtn, learnedBtn),
          ratingRow,
          next
        );
        paintChip();
        try { next.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }

        // Верный ответ — следующая карточка через auto_next_ms; касание отменяет таймер
        if (result === 'correct' && usedHints < MAX_HINT_STEP && autoMs > 0) {
          const fill = h('div', { class: 'progress-fill' });
          bar = h('div', { class: 'progress' }, fill);
          next.after(bar);
          fill.style.transition = 'none';
          fill.style.width = '0';
          requestAnimationFrame(() => requestAnimationFrame(() => {
            fill.style.transition = `width ${autoMs}ms linear`;
            fill.style.width = '100%';
          }));
          autoTimer = setTimeout(finish, autoMs);
          stage.addEventListener('pointerdown', cancelAuto);
        }

        setKeys((e) => {
          const t = e.target;
          if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
          if (performance.now() - shownAt < 400) return; // защита от «того же» Enter
          if (e.key === 'Enter') { e.preventDefault(); finish(); }
          else if (['1', '2', '3', '4'].includes(e.key)) select(Number(e.key));
        });
      });
    }

    // ---------- один элемент очереди ----------
    async function runItem(item, idx) {
      const card = item.card;
      const mod = await loadMode(item.mode);
      if (!mod || typeof mod.mount !== 'function') {
        if (item.kind !== 'sentence') toast('Режим пока недоступен, карточка пропущена');
        return;
      }

      if (item.kind === 'new' && !learnSeen.has(item.card_id)) {
        learnSeen.add(item.card_id);
        const alreadyKnown = await showLearn(card);
        if (cancelled) return;
        if (alreadyKnown) {
          stats.answered += 1;
          stats.correct += 1;
          await markCardLearned(card, idx);
          return;
        }
      }

      const isSentence = item.kind === 'sentence' || item.mode === 'sentence';
      let hints = 0;
      let res;
      let usedDiff = getDiff();

      // Цикл нужен для перезапуска карточки при смене сложности
      for (;;) {
        const diff = getDiff();
        const host = h('div', { class: 'mode-host' });
        stage.replaceChildren(host);
        const modeCtx = {
          speak: speakText,
          grade: gradeTyped,
          settings: { ...state.settings, difficulty: diff },
          difficulty: diff,
          hintsUsed: () => hints,
          registerHint: () => { hints += 1; }, // необязательное расширение
        };
        const restartP = new Promise((resolve) => {
          restartCurrent = isSentence ? null : () => resolve(RESTART);
        });
        const mp = Promise.resolve().then(() => mod.mount(host, item, modeCtx));
        mp.catch(() => {}); // покинутый режим не должен давать unhandled rejection
        let r;
        try {
          r = await Promise.race([mp, restartP]);
        } catch {
          restartCurrent = null;
          if (!cancelled) toast('Ошибка в карточке, пропускаем');
          return;
        }
        restartCurrent = null;
        if (cancelled) return;
        if (r === RESTART) continue;
        res = r;
        usedDiff = diff;
        break;
      }

      // Предложения (sentence) не оцениваются и не пишутся в FSRS
      if (isSentence) {
        const shownAt = performance.now();
        const nextBtn = h('button', { class: 'btn primary block next-btn', type: 'button', text: 'Далее' });
        stage.append(nextBtn);
        await new Promise((resolve) => {
          const done = () => { setKeys(null); resolve(); };
          nextBtn.addEventListener('click', done, { once: true });
          setKeys((e) => {
            const t = e.target;
            if (t && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)) return;
            if (performance.now() - shownAt < 400) return;
            if (e.key === 'Enter') { e.preventDefault(); done(); }
          });
        });
        return;
      }

      const answeredAt = new Date().toISOString();
      const result = RESULTS.includes(res && res.result) ? res.result : 'wrong';
      const userAnswer = typeof (res && res.userAnswer) === 'string' ? res.userAnswer.slice(0, 1000) : '';
      const responseMs = Number.isFinite(res && res.responseMs) ? Math.min(600000, Math.max(0, Math.round(res.responseMs))) : null;
      const usedHints = Math.min(10, Math.max(0, Math.round(Number.isFinite(res && res.hints) ? res.hints : hints)));

      const expected = expectedFor(mod, item, userAnswer, usedDiff);
      let g = null;
      try { g = gradeTyped(userAnswer, expected); } catch { g = null; }
      const note = g && typeof g.note === 'string' ? g.note : '';
      const diff = g && Array.isArray(g.diff) ? g.diff : [];

      let auto;
      try {
        auto = Math.round(autoRating({
          result, responseMs: responseMs === null ? 60000 : responseMs, hints: usedHints, mode: item.mode, difficulty: usedDiff,
        }));
      } catch { auto = NaN; }
      if (!(auto >= 1 && auto <= 4)) auto = result === 'wrong' ? 1 : result === 'almost' ? 2 : 3;

      const rating = await showFeedbackAndRate({ result, note, expected, diff, card, auto, usedHints });
      if (cancelled) return;
      if (rating === 'learned') {
        stats.answered += 1;
        stats.correct += 1;
        await markCardLearned(card, idx);
        return;
      }

      stats.answered += 1;
      if (rating > 1) stats.correct += 1;

      // Повтор после ошибки — только тренировка, в FSRS не пишется
      if (!item._requeued) {
        clearCurrent();
        await saveReview({
          client_uuid: uuid(),
          card_id: item.card_id,
          mode: item.mode,
          rating,
          correct: rating > 1,
          response_ms: responseMs === null ? undefined : responseMs,
          user_answer: userAnswer || undefined,
          hints_used: usedHints,
          answered_at: answeredAt,
        });
        doneKeys.add(item.key);
        saveDone(date, doneKeys);
      }

      // Второй шаг сложного ru_de: предложение уходит в корзину, а не оценивается сейчас
      if (typeof res.followUp === 'function' && !item._requeued && card.example && card.example_translation && !cancelled) {
        const fHost = h('div', { class: 'mode-host' });
        stage.replaceChildren(fHost);
        let fr = null;
        try { fr = await res.followUp(fHost); } catch { fr = null; }
        if (cancelled) return;
        if (fr && typeof fr.answer === 'string' && fr.answer.trim()) {
          basketAdd({
            card_id: item.card_id,
            source: String(card.example_translation).slice(0, 400),
            answer: fr.answer.trim().slice(0, 600),
            reference: String(card.example).slice(0, 600),
            added_at: new Date().toISOString(),
          });
        }
      }

      if ((result === 'wrong' || rating === 1) && !item._requeued) {
        queue.splice(Math.min(queue.length, idx + 8), 0, { ...item, kind: 'review', key: item.key + '#r', _requeued: true });
      }
    }

    // ---------- итог сессии и проверка корзины ----------
    function buildBasketBox() {
      const basket = basketLoad();
      const n = basket.length;
      const requests = Math.ceil(n / BATCH_CHUNK);
      const label = `Проверить ${n} ${ruPlural(n, 'предложение', 'предложения', 'предложений')} (${requests} ${ruPlural(requests, 'запрос', 'запроса', 'запросов')} ИИ)`;
      const errEl = h('p', { class: 'error', role: 'alert', hidden: true });
      const out = h('div', { class: 'stack' });
      const btn = h('button', { class: 'btn primary block', type: 'button', text: label });

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const current = basketLoad();
        if (!current.length) { btn.hidden = true; return; }
        const items = current.map((e, i) => ({
          idx: i + 1,
          source: e.source.slice(0, 400),
          answer: e.answer.slice(0, 600),
          ...(e.reference ? { reference: e.reference.slice(0, 600) } : {}),
          card_id: e.card_id,
        }));
        btn.disabled = true;
        btn.textContent = 'Проверяем…';
        errEl.hidden = true;
        let result;
        try {
          const api2 = await import('../api2.js');
          if (typeof api2.checkBatch !== 'function') throw new Error('checkBatch');
          result = await api2.checkBatch({ kind: 'basket', items });
          if (!result || typeof result !== 'object') throw new Error('bad result');
        } catch (e) {
          // при ошибке корзина остаётся нетронутой
          errEl.textContent = batchErrorText(e);
          errEl.hidden = false;
          btn.disabled = false;
          btn.textContent = label;
          return;
        }
        basketClear();
        btn.hidden = true;
        out.replaceChildren();
        try {
          const ui = await import('../ui/batch_result.js');
          if (typeof ui.renderBatchResult !== 'function') throw new Error('renderBatchResult');
          ui.renderBatchResult(out, result, { sources: items.map((it) => ({ idx: it.idx, source: it.source, answer: it.answer })) });
        } catch {
          out.replaceChildren();
          fallbackBatchResult(out, result);
        }
      });

      return h('div', { class: 'card-box stack' },
        h('h3', { text: 'Предложения на проверку' }),
        h('p', { class: 'muted', text: 'В сложном режиме предложения не оцениваются сразу — проверим их все вместе.' }),
        btn, errEl, out);
    }

    function showSummary() {
      setKeys(null);
      counter.textContent = '';
      barFill.style.width = '100%';
      const acc = stats.answered ? Math.round((100 * stats.correct) / stats.answered) : 0;
      stage.replaceChildren(
        h('div', { class: 'card-box stack center' },
          h('h2', { text: stats.answered ? 'Сессия завершена' : 'Очередь пуста' }),
          h('p', { text: stats.answered ? `Ответов: ${stats.answered}, верно: ${acc}%` : 'На сегодня всё — отдыхайте!' }),
          h('button', { class: 'btn primary block', type: 'button', text: 'На главную', onclick: () => navigate('#/today') })
        )
      );
      if (basketLoad().length) stage.append(buildBasketBox());
      offline().then((o) => o.flush && o.flush()).catch(() => {});
    }

    for (let idx = 0; idx < queue.length && !cancelled; idx++) {
      updateProgress(idx);
      try {
        await runItem(queue[idx], idx);
      } catch {
        if (cancelled) return;
        toast('Не удалось показать карточку, пропускаем');
      }
    }
    if (!cancelled) showSummary();
  }
}
