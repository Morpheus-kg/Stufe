// Экран «Статистика»
import { getStats, getSettings, logExternal } from '../api.js';

const STYLE_ID = 'gt-stats-style';
const CSS = `
.gt-st{max-width:640px;margin:0 auto;padding:var(--s3) 0 var(--s6)}
.gt-st h1{font-size:var(--fs-xl);margin:var(--s2) 0 var(--s4);letter-spacing:-0.02em;font-weight:700}
.gt-st h2{font-size:var(--fs-xs);font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin:0 0 var(--s2)}
.gt-st-card{border:1px solid var(--border);border-radius:var(--radius);padding:var(--s4);margin:0 0 var(--s4);background:var(--surface);color:var(--text)}
/* Плитки статистики */
.gt-st-tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--s2);margin:0 0 var(--s2)}
.gt-st-tiles.cols3{grid-template-columns:repeat(3,1fr)}
.gt-st-tile{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--s2);text-align:center}
.gt-st-num{display:block;font-size:var(--fs-xl);font-weight:800;color:var(--accent);line-height:1.1}
.gt-st-lbl{display:block;font-size:var(--fs-xs);color:var(--text-3);margin-top:2px}
/* Серия */
.gt-st-streak{display:flex;align-items:center;gap:var(--s3)}
.gt-st-streak-num{font-size:var(--fs-term);font-weight:800;color:var(--accent);line-height:1}
.gt-st-streak-label{font-size:var(--fs-md);font-weight:600}
.gt-st-streak-hint{font-size:var(--fs-sm);color:var(--text-2);margin-top:2px}
/* График */
.gt-st-big{font-size:var(--fs-lg);margin:0 0 var(--s1)}
.gt-st-big strong{font-size:var(--fs-xl);color:var(--accent)}
.gt-st-muted{color:var(--text-2);font-size:var(--fs-sm);margin:var(--s1) 0}
.gt-st-err{color:var(--danger)}
.gt-st-row{display:flex;align-items:center;gap:var(--s2);margin:var(--s1) 0}
.gt-st-name{flex:0 0 42%;font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gt-st-row progress{flex:1;min-width:0;height:4px;border-radius:var(--radius-pill);border:none;overflow:hidden;background:var(--border);accent-color:var(--accent)}
.gt-st-val{flex:0 0 auto;min-width:3em;text-align:right;font-size:var(--fs-xs);font-variant-numeric:tabular-nums;color:var(--text-3)}
.gt-st-chips{display:flex;flex-wrap:wrap;gap:var(--s1);margin:var(--s2) 0}
.gt-st-chip{border:1px solid var(--border);border-radius:var(--radius-pill);padding:2px var(--s2);font-size:var(--fs-xs);background:var(--surface-2);color:var(--text-2)}
/* SVG chart */
.gt-st-chart{width:100%;height:auto;display:block;margin:var(--s1) 0}
.gt-st-ok{fill:var(--success)}
.gt-st-bad{fill:var(--border)}
.gt-st-axis{fill:var(--text-3);font-size:9px}
.gt-st-line{stroke:var(--border);stroke-width:1}
.gt-st-legend{display:flex;gap:var(--s3);font-size:var(--fs-xs);margin:var(--s1) 0;color:var(--text-3)}
.gt-st-sw{display:inline-block;width:8px;height:8px;margin-right:4px;border-radius:2px;vertical-align:middle}
.gt-st-sw.ok{background:var(--success)}
.gt-st-sw.bad{background:var(--border)}
/* Кольцо удержания */
.gt-st-ring-wrap{display:flex;align-items:center;gap:var(--s4)}
.gt-st-ring{flex-shrink:0}
.gt-st-ring-info{}
.gt-st-ring-pct{font-size:var(--fs-xl);font-weight:800;color:var(--accent)}
.gt-st-ring-label{font-size:var(--fs-xs);color:var(--text-3);margin-top:2px}
/* Слабые карточки */
.gt-st-weak{margin:var(--s1) 0;padding-left:18px}
.gt-st-weak li{margin:var(--s1) 0;font-size:var(--fs-sm)}
/* Форма */
.gt-st-form{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-top:var(--s2)}
.gt-st-form select,.gt-st-form input{min-height:var(--tap);font-size:var(--fs-sm);padding:var(--s1) var(--s2);border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);box-sizing:border-box}
.gt-st-form input{width:5em}
.gt-st button{min-height:var(--tap);font-size:var(--fs-sm);padding:var(--s1) var(--s3);border-radius:var(--radius-sm);cursor:pointer;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:inherit}
`;

const MODE_LABELS = {
  ru_de: 'RU → DE (перевод)',
  cloze: 'Пропуски',
  article: 'Артикли',
};
const ERROR_LABELS = {
  artikel: 'Артикли',
  kasus: 'Падежи',
  wortstellung: 'Порядок слов',
  praeposition: 'Предлоги',
  konjugation: 'Спряжение',
  rechtschreibung: 'Орфография',
  wortschatz: 'Лексика',
  sonstiges: 'Прочее',
};
const EXT_LABELS = { audio: 'Аудирование', speaking: 'Говорение', reading: 'Чтение' };

// ---------- Утилиты ----------

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

// Создание DOM только через textContent / createTextNode (никакого innerHTML)
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function svgEl(name, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  return node;
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function plural(count, forms) {
  const a = Math.abs(count) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const pct = (frac) => (typeof frac === 'number' && Number.isFinite(frac) ? `${Math.round(frac * 100)}%` : '—');

function fmtDay(day) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2]}.${m[1]}` : String(day);
}

function displayTerm(card) {
  const term = String(card?.term ?? '');
  return card?.article ? `${card.article} ${term}` : term;
}

function errText(e) {
  if (e && e.code && e.message) return e.message;
  if (e instanceof TypeError) return 'Нет связи с сервером.';
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Приводим ответ сервера к безопасной форме (ничего не падает при отсутствии полей)
function normalize(raw) {
  const s = objOf(raw);
  const cards = objOf(s.cards);
  const today = objOf(s.today);
  const ext = objOf(s.external_minutes_30d);
  return {
    streak: n(s.streak_days),
    today: {
      reviews: n(today.reviews),
      correct: n(today.correct),
      new_cards: n(today.new_cards),
      active_seconds: n(today.active_seconds),
    },
    days: Array.isArray(s.last_30_days)
      ? s.last_30_days.map((d) => ({
        day: String(d?.day ?? '').slice(0, 10),
        reviews: n(d?.reviews),
        correct: n(d?.correct),
      }))
      : [],
    retention: typeof s.retention_30d === 'number' ? s.retention_30d : null,
    cards: {
      total: n(cards.total),
      new: n(cards.new),
      learning: n(cards.learning),
      mature: n(cards.mature),
      flagged: n(cards.flagged_check),
      pending: n(cards.pending_enrich),
      by_level: objOf(cards.by_level),
      by_topic: objOf(cards.by_topic),
    },
    accuracy: objOf(s.accuracy_by_mode),
    weak: Array.isArray(s.weak_cards) ? s.weak_cards.filter((w) => w && w.card) : [],
    errors: objOf(s.error_categories),
    ext: { audio: n(ext.audio), speaking: n(ext.speaking), reading: n(ext.reading) },
  };
}

// ---------- Блоки ----------

function section(title, ...kids) {
  return h('section', { class: 'gt-st-card' }, h('h2', { text: title }), ...kids);
}

function tile(value, label) {
  return h('div', { class: 'gt-st-tile' },
    h('span', { class: 'gt-st-num', text: String(value) }),
    h('span', { class: 'gt-st-lbl', text: label }));
}

function barRow(name, value, max, text) {
  const top = Math.max(max, 1);
  return h('div', { class: 'gt-st-row' },
    h('span', { class: 'gt-st-name', text: name }),
    h('progress', { max: top, value: Math.max(0, Math.min(value, top)), 'aria-label': name }),
    h('span', { class: 'gt-st-val', text }));
}

function buildChart(days) {
  const W = 300;
  const H = 100;
  const STEP = 10;
  const BAR = 7;
  const TOP = 6;
  const BASE = 84;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'gt-st-chart',
    role: 'img',
    'aria-label': 'Повторений по дням',
  });
  const max = Math.max(1, ...days.map((d) => d.reviews));
  days.forEach((d, i) => {
    const x = i * STEP + 1;
    const total = Math.round((d.reviews / max) * (BASE - TOP));
    const good = Math.round((Math.min(d.correct, d.reviews) / max) * (BASE - TOP));
    const g = svgEl('g');
    const title = svgEl('title');
    title.textContent = `${fmtDay(d.day)}: ${d.reviews} повт., верно ${d.correct}`;
    g.append(title);
    if (total > 0) g.append(svgEl('rect', { x, y: BASE - total, width: BAR, height: total, class: 'gt-st-bad' }));
    if (good > 0) g.append(svgEl('rect', { x, y: BASE - good, width: BAR, height: good, class: 'gt-st-ok' }));
    svg.append(g);
  });
  svg.append(svgEl('line', { x1: 0, x2: W, y1: BASE + 1, y2: BASE + 1, class: 'gt-st-line' }));
  if (days.length) {
    const first = svgEl('text', { x: 1, y: H - 2, class: 'gt-st-axis' });
    first.textContent = fmtDay(days[0].day);
    const last = svgEl('text', { x: W - 1, y: H - 2, 'text-anchor': 'end', class: 'gt-st-axis' });
    last.textContent = fmtDay(days[days.length - 1].day);
    svg.append(first, last);
  }
  return svg;
}

/** Кольцевая диаграмма удержания (SVG, без внешних библиотек) */
function buildRetentionRing(frac) {
  const R = 36; const C = 44; const r = 2 * Math.PI * R;
  const val = Number.isFinite(frac) ? Math.max(0, Math.min(frac, 1)) : 0;
  const svg = svgEl('svg', { viewBox: '0 0 88 88', width: '88', height: '88', class: 'gt-st-ring', 'aria-hidden': 'true' });
  const bg = svgEl('circle', { cx: C, cy: C, r: R, fill: 'none', stroke: 'var(--border)', 'stroke-width': '10' });
  const fg = svgEl('circle', {
    cx: C, cy: C, r: R, fill: 'none',
    stroke: 'var(--ok,#3a9d5d)', 'stroke-width': '10',
    'stroke-dasharray': `${val * r} ${r}`,
    'stroke-dashoffset': r / 4,
    'stroke-linecap': 'round',
  });
  svg.append(bg, fg);
  return svg;
}

function externalForm(reload) {
  const kind = h('select', { 'aria-label': 'Тип занятия' },
    ...Object.entries(EXT_LABELS).map(([v, label]) => h('option', { value: v, text: label })));
  const minutes = h('input', {
    type: 'number', min: 1, max: 600, step: 1, value: 15, inputmode: 'numeric', 'aria-label': 'Минуты',
  });
  const msg = h('p', { class: 'gt-st-muted', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', text: 'Добавить' });
  btn.addEventListener('click', async () => {
    const m = Number(minutes.value);
    if (!Number.isInteger(m) || m < 1 || m > 600) {
      msg.className = 'gt-st-err';
      msg.setAttribute('role', 'alert');
      msg.textContent = 'Минуты: целое число от 1 до 600.';
      return;
    }
    btn.disabled = true;
    try {
      await logExternal({ kind: kind.value, minutes: m });
      await reload();
    } catch (e) {
      msg.className = 'gt-st-err';
      msg.setAttribute('role', 'alert');
      msg.textContent = errText(e);
      btn.disabled = false;
    }
  });
  return h('div', null,
    h('p', { class: 'gt-st-muted', text: 'Записать занятие вне приложения:' }),
    h('div', { class: 'gt-st-form' }, kind, minutes, h('span', { text: 'мин' }), btn),
    msg);
}

function render(s, settings, reload) {
  const out = [];
  const goal = n(settings?.daily_goal_minutes);
  const minutes = Math.round(s.today.active_seconds / 60);

  // --- Серия + Сегодня в одном блоке ---
  const streakHint = s.today.reviews > 0 ? 'Засчитано сегодня ✓'
    : s.streak > 0 ? 'Не прерывайте серию — сделайте повторение!'
    : 'Начните серию сегодня!';

  out.push(h('section', { class: 'gt-st-card' },
    h('div', { class: 'gt-st-streak' },
      h('div', { class: 'gt-st-streak-num', text: String(s.streak) }),
      h('div', null,
        h('div', { class: 'gt-st-streak-label', text: plural(s.streak, ['день подряд', 'дня подряд', 'дней подряд']) }),
        h('div', { class: 'gt-st-streak-hint', text: streakHint }),
      )),
    h('div', { class: 'gt-st-tiles', style: 'margin-top:12px' },
      tile(s.today.reviews, 'повторений'),
      tile(s.today.reviews ? pct(s.today.correct / s.today.reviews) : '—', 'точность'),
      tile(s.today.new_cards, 'новых слов'),
      tile(minutes + ' мин', 'время'),
    ),
    goal > 0
      ? h('div', null,
          barRow('Цель дня', Math.min(minutes, goal), goal, `${minutes} / ${goal} мин`))
      : null,
  ));

  // --- Активность за 30 дней (график) ---
  const sum30 = s.days.reduce((a, d) => a + d.reviews, 0);
  const activeDays = s.days.filter((d) => d.reviews > 0).length;
  out.push(h('section', { class: 'gt-st-card' },
    h('h2', { text: 'Активность за 30 дней' }),
    s.days.length && sum30 > 0
      ? h('div', null,
          buildChart(s.days),
          h('div', { class: 'gt-st-legend' },
            h('span', null, h('span', { class: 'gt-st-sw ok' }), 'верно'),
            h('span', null, h('span', { class: 'gt-st-sw bad' }), 'ошибки'),
          ),
          h('p', { class: 'gt-st-muted',
            text: `${sum30} повторений · ${activeDays} активных дней` }),
        )
      : h('p', { class: 'gt-st-muted', text: 'Пока нет данных.' }),
  ));

  // --- Удержание (кольцо) ---
  const retRing = buildRetentionRing(s.retention);
  out.push(h('section', { class: 'gt-st-card' },
    h('h2', { text: 'Удержание' }),
    h('div', { class: 'gt-st-ring-wrap' },
      retRing,
      h('div', { class: 'gt-st-ring-info' },
        h('div', { class: 'gt-st-ring-pct', text: pct(s.retention) }),
        h('div', { class: 'gt-st-ring-label', text: 'верных ответов на повторах' }),
      ),
    ),
  ));

  // --- Карточки ---
  const c = s.cards;
  const cardKids = [
    h('h2', { text: 'Словарь' }),
    h('div', { class: 'gt-st-tiles cols3' },
      tile(c.total, 'всего'),
      tile(c.new, 'новых'),
      tile(c.learning, 'в изучении'),
      tile(c.mature, 'выучено'),
      tile(c.flagged, 'проверить'),
      tile(c.pending, 'без обогащ.'),
    ),
  ];
  const levels = Object.entries(c.by_level).sort(([a], [b]) => a.localeCompare(b));
  if (levels.length) {
    cardKids.push(h('div', { class: 'gt-st-chips' },
      ...levels.map(([lvl, cnt]) => h('span', { class: 'gt-st-chip', text: `${lvl}: ${n(cnt)}` }))));
  }
  const topics = Object.entries(c.by_topic).map(([t, cnt]) => [t, n(cnt)]).sort((a, b) => b[1] - a[1]);
  const topMax = topics.length ? topics[0][1] : 0;
  for (const [t, cnt] of topics.slice(0, 8)) cardKids.push(barRow(t, cnt, topMax, String(cnt)));
  out.push(h('section', { class: 'gt-st-card' }, ...cardKids));

  // --- Точность по режимам (компактно, без "30 дней" в заголовке) ---
  const accuracyRows = Object.entries(MODE_LABELS).map(([mode, label]) => {
    const v = s.accuracy[mode];
    const has = typeof v === 'number' && Number.isFinite(v);
    return barRow(label, has ? v : 0, 1, has ? pct(v) : '—');
  });
  out.push(h('section', { class: 'gt-st-card' },
    h('h2', { text: 'Точность по режимам' }),
    ...accuracyRows,
  ));

  // --- Слабые карточки ---
  if (s.weak.length) {
    out.push(h('section', { class: 'gt-st-card' },
      h('h2', { text: 'Проблемные карточки' }),
      h('ol', { class: 'gt-st-weak' },
        ...s.weak.map((w) => h('li', null,
          h('strong', { text: displayTerm(w.card) }),
          ` — ${String(w.card.translation ?? '')} `,
          h('span', { class: 'gt-st-muted', text: `(${n(w.lapses)} ошибок)` }))))));
  }

  // --- Ошибки по категориям ---
  const errs = Object.entries(s.errors).map(([k, v]) => [k, n(v)]).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0);
  if (errs.length) {
    const errMax = errs[0][1];
    out.push(h('section', { class: 'gt-st-card' },
      h('h2', { text: 'Типичные ошибки' }),
      ...errs.map(([k, v]) => barRow(
        Object.hasOwn(ERROR_LABELS, k) ? ERROR_LABELS[k] : k, v, errMax, String(v)))));
  }

  // --- Занятия вне приложения ---
  const extTotal = s.ext.audio + s.ext.speaking + s.ext.reading;
  out.push(h('section', { class: 'gt-st-card' },
    h('h2', { text: 'Вне приложения' }),
    h('div', { class: 'gt-st-tiles cols3' },
      tile(s.ext.audio, 'аудирование'),
      tile(s.ext.speaking, 'говорение'),
      tile(s.ext.reading, 'чтение'),
    ),
    extTotal > 0 ? h('p', { class: 'gt-st-muted', text: `Итого: ${extTotal} мин` }) : null,
    externalForm(reload),
  ));

  return out;
}

// ---------- Точка входа ----------

export async function mount(container) {
  ensureStyle();
  const body = h('div');
  const root = h('section', { class: 'gt-st' }, h('h1', { text: 'Статистика' }), body);
  container.replaceChildren(root);

  async function load() {
    body.replaceChildren(h('p', { class: 'gt-st-muted', role: 'status', text: 'Загрузка…' }));
    try {
      const [raw, settings] = await Promise.all([getStats(), getSettings().catch(() => null)]);
      body.replaceChildren(...render(normalize(raw), settings, load));
    } catch (e) {
      if (e && e.status === 401) return; // редирект на логин делает api.js/app.js
      body.replaceChildren(
        h('p', { class: 'gt-st-err', role: 'alert', text: errText(e) }),
        h('button', { type: 'button', text: 'Повторить', onclick: load }));
    }
  }

  await load();
}

export default mount;