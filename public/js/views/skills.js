// Навыки: статистика по навыкам Goethe B2 + экзамен (обратный отсчёт и журнал пробников)
import { h } from '../app.js';
import { getSkills, getExam, postExam, deleteExam } from '../api2.js';
import { putSettings } from '../api.js';

const STYLE_ID = 'gt-skills-style';
const CSS = `
.gt-sk{max-width:640px;margin:0 auto;padding:var(--s3) 0 var(--s6)}
.gt-sk h1{font-size:var(--fs-xl);margin:var(--s2) 0 var(--s4);font-weight:700}
.gt-sk h2{font-size:var(--fs-lg);margin:0 0 var(--s2);font-weight:600}
.gt-sk-card{border:1px solid var(--border);border-radius:var(--radius);padding:var(--s4);margin:0 0 var(--s4);background:var(--surface);color:var(--text)}
.gt-sk-muted{color:var(--text-2);font-size:var(--fs-sm)}
.gt-sk-err{color:var(--danger);font-weight:600}
.gt-sk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--s3)}
.gt-sk-item{border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--s3)}
.gt-sk-item b{display:block;font-size:var(--fs-md)}
.gt-sk-bar{position:relative;height:4px;background:var(--border);border-radius:var(--radius-pill);margin:var(--s2) 0;overflow:hidden}
.gt-sk-fill{height:100%;background:var(--accent);border-radius:var(--radius-pill)}
.gt-sk-mark{position:absolute;top:0;bottom:0;width:2px;background:var(--text-3)}
.gt-sk-days{display:grid;grid-template-columns:repeat(10,1fr);gap:3px}
.gt-sk-day{min-height:28px;border-radius:var(--radius-sm);font-size:var(--fs-xs);text-align:center;line-height:1.1;padding:2px;background:var(--surface-2)}
.gt-sk-day.l1{background:var(--accent-soft);color:var(--accent)}
.gt-sk-day.l2{background:var(--accent);color:var(--on-accent)}
.gt-sk-day.l3{background:var(--primary);color:var(--on-primary)}
.gt-sk-row{display:flex;gap:var(--s2);align-items:center;margin:var(--s1) 0}
.gt-sk-row .lbl{flex:0 0 40%;font-size:var(--fs-sm)}
.gt-sk-row .gt-sk-bar{flex:1;margin:0}
.gt-sk input,.gt-sk select{box-sizing:border-box;width:100%;min-height:var(--tap);font-size:var(--fs-md);padding:var(--s2) var(--s3);border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text)}
.gt-sk label{display:block;margin:var(--s2) 0 var(--s1);font-weight:500;font-size:var(--fs-sm);color:var(--text-2)}
.gt-sk button{min-height:var(--tap);font-size:var(--fs-md);padding:var(--s2) var(--s4);margin:var(--s2) var(--s2) 0 0;cursor:pointer;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font:inherit}
.gt-sk button:disabled{opacity:.4}
.gt-sk ul.exams{list-style:none;padding:0;margin:var(--s2) 0 0}
.gt-sk ul.exams li{display:flex;gap:var(--s2);align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding:var(--s2) 0}
`;

const SKILL_RU = {
  hoeren: 'Hören (аудирование)', lesen: 'Lesen (чтение)', sprechen: 'Sprechen (говорение)',
  schreiben: 'Schreiben (письмо)', wortschatz: 'Лексика', gesamt: 'Общий результат',
};
const SKILL_ORDER = ['hoeren', 'lesen', 'sprechen', 'schreiben', 'wortschatz'];
const EXAM_SKILLS = ['lesen', 'hoeren', 'schreiben', 'sprechen', 'gesamt'];
const ERR_RU = {
  artikel: 'Артикли', kasus: 'Падежи', wortstellung: 'Порядок слов', praeposition: 'Предлоги',
  konjugation: 'Спряжение', rechtschreibung: 'Орфография', wortschatz: 'Лексика', sonstiges: 'Прочее',
};
const TREND_RU = { up: '↑ растёт', flat: '→ без изменений', down: '↓ снижается' };

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plural(count, forms) {
  const a = Math.abs(count) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function errText(e) {
  if (e && e.message && (e.code || e.status !== undefined)) return e.message;
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

function section(title, ...kids) {
  return h('section', { class: 'gt-sk-card' }, h('h2', { text: title }), ...kids);
}

function bar(pct, passPct) {
  const p = Math.max(0, Math.min(100, n(pct)));
  const wrap = h('div', { class: 'gt-sk-bar', role: 'img', 'aria-label': `${Math.round(p)}%` },
    h('div', { class: 'gt-sk-fill', style: `width:${p}%` }));
  if (passPct !== undefined) {
    const m = h('div', { class: 'gt-sk-mark', title: `Ориентир ${passPct}%` });
    m.style.left = `${Math.max(0, Math.min(100, passPct))}%`;
    wrap.append(m);
  }
  return wrap;
}

// ---------- Навыки ----------

function renderSkills(box, data) {
  box.replaceChildren();
  if (!data || typeof data !== 'object') {
    box.append(section('Навыки', h('p', { class: 'gt-sk-muted', text: 'Данных пока нет.' })));
    return;
  }
  const by = data.by_skill && typeof data.by_skill === 'object' ? data.by_skill : {};
  const grid = h('div', { class: 'gt-sk-grid' });
  for (const k of SKILL_ORDER) {
    const s = by[k] && typeof by[k] === 'object' ? by[k] : {};
    const acc = s.accuracy_30d === null || s.accuracy_30d === undefined ? null : n(s.accuracy_30d);
    grid.append(h('div', { class: 'gt-sk-item' },
      h('b', { text: SKILL_RU[k] }),
      h('div', { text: `7 дн.: ${n(s.minutes_7d)} мин, 30 дн.: ${n(s.minutes_30d)} мин` }),
      h('div', { text: acc === null ? 'Точность: —' : `Точность за 30 дней: ${Math.round(acc * 100)}%` }),
      acc === null ? null : bar(acc * 100),
      h('div', { class: 'gt-sk-muted', text: `Динамика: ${TREND_RU[s.trend] || '—'}` })));
  }
  const kids = [grid];
  const numAcc = data.numbers && data.numbers.accuracy_30d;
  if (numAcc !== null && numAcc !== undefined) {
    kids.push(h('p', { class: 'gt-sk-muted', text: `Числа на слух, точность за 30 дней: ${Math.round(n(numAcc) * 100)}%` }));
  }
  const weakest = data.weakest && typeof data.weakest === 'object' ? (data.weakest.skill || data.weakest.name) : data.weakest;
  if (typeof weakest === 'string' && weakest) {
    kids.push(h('p', { text: `Слабее всего: ${SKILL_RU[weakest] || weakest}` }));
  }
  box.append(section('Навыки', ...kids));

  // Дни занятий за 30 дней (по локальному календарю устройства)
  const days = Array.isArray(data.activity_days_30) ? data.activity_days_30 : [];
  const map = new Map();
  for (const d of days) if (d && typeof d.day === 'string') map.set(d.day.slice(0, 10), n(d.minutes));
  const cells = h('div', { class: 'gt-sk-days' });
  const now = new Date();
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = ymd(d);
    const min = map.get(key) || 0;
    const lvl = min <= 0 ? '' : min < 10 ? 'l1' : min < 20 ? 'l2' : 'l3';
    cells.append(h('div', {
      class: `gt-sk-day ${lvl}`.trim(), title: `${key}: ${min} мин`, 'aria-label': `${key}: ${min} мин`,
    }, String(d.getDate()), h('br'), min > 0 ? String(Math.round(min)) : '·'));
  }
  box.append(section('Занятия за 30 дней', h('p', { class: 'gt-sk-muted', text: 'Число в клетке — день месяца, под ним минуты.' }), cells));

  // Категории ошибок
  const cats = data.error_categories_30d && typeof data.error_categories_30d === 'object' ? data.error_categories_30d : {};
  const entries = Object.entries(cats).map(([k, v]) => [k, n(v)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const errBox = h('div');
  if (!entries.length) errBox.append(h('p', { class: 'gt-sk-muted', text: 'Ошибок за 30 дней не найдено.' }));
  const max = entries.length ? entries[0][1] : 1;
  for (const [k, v] of entries) {
    errBox.append(h('div', { class: 'gt-sk-row' },
      h('span', { class: 'lbl', text: `${Object.hasOwn(ERR_RU, k) ? ERR_RU[k] : k}: ${v}` }),
      bar((v / max) * 100)));
  }
  box.append(section('Частые ошибки', errBox));
}

// ---------- Экзамен ----------

function daysLeftText(d) {
  if (d === null || d === undefined || !Number.isFinite(Number(d))) return 'Дата экзамена не выбрана.';
  const v = Number(d);
  if (v === 0) return 'Экзамен сегодня!';
  if (v < 0) return 'Дата экзамена уже прошла.';
  return `До экзамена: ${v} ${plural(v, ['день', 'дня', 'дней'])}`;
}

function renderExam(box, data, reload) {
  box.replaceChildren();
  const d = data && typeof data === 'object' ? data : {};
  const pass = Number.isFinite(Number(d.pass_pct)) ? Number(d.pass_pct) : 60;
  const msg = h('p', { class: 'gt-sk-muted', role: 'status', 'aria-live': 'polite' });
  const setMsg = (t, bad) => { msg.textContent = t || ''; msg.classList.toggle('gt-sk-err', !!bad); };

  // Дата экзамена
  const dateInp = h('input', { type: 'date', id: 'gt-sk-exam-date', value: typeof d.exam_date === 'string' ? d.exam_date : '' });
  dateInp.addEventListener('change', async () => {
    const v = dateInp.value;
    if (v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { setMsg('Некорректная дата.', true); return; }
    dateInp.disabled = true;
    try {
      await putSettings({ exam_date: v });
      await reload();
    } catch (e) {
      setMsg(errText(e), true);
      dateInp.disabled = false;
    }
  });

  // Последние результаты по навыкам
  const latest = d.latest_by_skill && typeof d.latest_by_skill === 'object' ? d.latest_by_skill : {};
  const latestBox = h('div');
  for (const k of EXAM_SKILLS) {
    const l = latest[k];
    if (!l || typeof l !== 'object') continue;
    latestBox.append(h('div', null,
      h('div', { text: `${SKILL_RU[k]}: ${Math.round(n(l.pct))}% (${String(l.taken_on || '')})` }),
      bar(l.pct, pass)));
  }
  if (!latestBox.childNodes.length) latestBox.append(h('p', { class: 'gt-sk-muted', text: 'Результатов пробников пока нет.' }));

  // Форма записи результата
  const fDate = h('input', { type: 'date', id: 'gt-sk-f-date', value: ymd(new Date()) });
  const fSkill = h('select', { id: 'gt-sk-f-skill' }, EXAM_SKILLS.map((k) => h('option', { value: k, text: SKILL_RU[k] })));
  const fPoints = h('input', { type: 'number', id: 'gt-sk-f-points', inputmode: 'decimal', min: 0, step: 0.5 });
  const fMax = h('input', { type: 'number', id: 'gt-sk-f-max', inputmode: 'decimal', min: 1, step: 0.5, value: 100 });
  const fSource = h('input', { type: 'text', id: 'gt-sk-f-source', maxlength: 100, placeholder: 'Например: Goethe Modelltest 1' });
  const fNote = h('input', { type: 'text', id: 'gt-sk-f-note', maxlength: 255 });
  const addBtn = h('button', { type: 'submit', text: 'Записать результат' });
  const form = h('form', { novalidate: true },
    h('label', { for: 'gt-sk-f-date', text: 'Дата' }), fDate,
    h('label', { for: 'gt-sk-f-skill', text: 'Навык' }), fSkill,
    h('label', { for: 'gt-sk-f-points', text: 'Баллы' }), fPoints,
    h('label', { for: 'gt-sk-f-max', text: 'Максимум баллов' }), fMax,
    h('label', { for: 'gt-sk-f-source', text: 'Источник (необязательно)' }), fSource,
    h('label', { for: 'gt-sk-f-note', text: 'Заметка (необязательно)' }), fNote,
    addBtn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const points = Number(String(fPoints.value).replace(',', '.'));
    const maxP = Number(String(fMax.value).replace(',', '.'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fDate.value)) { setMsg('Укажите дату.', true); return; }
    if (!Number.isFinite(points) || fPoints.value.trim() === '' || points < 0) { setMsg('Введите баллы (0 и больше).', true); return; }
    if (!Number.isFinite(maxP) || maxP <= 0 || points > maxP) { setMsg('Максимум должен быть больше нуля и не меньше баллов.', true); return; }
    const body = { taken_on: fDate.value, skill: fSkill.value, points, max_points: maxP };
    if (fSource.value.trim()) body.source = fSource.value.trim().slice(0, 100);
    if (fNote.value.trim()) body.note = fNote.value.trim().slice(0, 255);
    addBtn.disabled = true;
    try {
      await postExam(body);
      await reload();
    } catch (e) {
      setMsg(errText(e), true);
      addBtn.disabled = false;
    }
  });

  // Журнал
  const items = Array.isArray(d.items) ? d.items : [];
  const list = h('ul', { class: 'exams' });
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const del = h('button', { type: 'button', text: 'Удалить', 'aria-label': `Удалить результат от ${String(it.taken_on || '')}` });
    del.addEventListener('click', async () => {
      if (!window.confirm('Удалить эту запись?')) return;
      del.disabled = true;
      try {
        await deleteExam(it.id);
        await reload();
      } catch (e) {
        setMsg(errText(e), true);
        del.disabled = false;
      }
    });
    const extra = [it.source, it.note].filter(Boolean).join(' · ');
    list.append(h('li', null,
      h('span', null,
        h('div', { text: `${String(it.taken_on || '')} — ${SKILL_RU[it.skill] || String(it.skill || '')}: ${n(it.points)}/${n(it.max_points)} (${Math.round(n(it.pct))}%)` }),
        extra ? h('div', { class: 'gt-sk-muted', text: extra }) : null),
      del));
  }

  box.append(section('Экзамен',
    h('label', { for: 'gt-sk-exam-date', text: 'Дата экзамена' }), dateInp,
    h('p', { text: daysLeftText(d.days_left) }),
    h('p', { class: 'gt-sk-muted', text: `Вертикальная черта — ориентир ${pass}%. Проверь актуальные правила на сайте Goethe-Institut.` }),
    latestBox),
    section('Записать результат пробного теста', form, msg),
    section('Журнал результатов', items.length ? list : h('p', { class: 'gt-sk-muted', text: 'Журнал пуст.' })));
}

// ---------- Точка входа ----------

export async function mount(container) {
  ensureStyle();
  let disposed = false;
  const root = h('section', { class: 'gt-sk' }, h('h1', { text: 'Навыки и экзамен' }));
  const skillsBox = h('div', null, h('p', { class: 'gt-sk-muted', text: 'Загрузка…' }));
  const examBox = h('div');
  root.append(skillsBox, examBox);
  container.replaceChildren(root);

  function failBox(box, e, retry) {
    box.replaceChildren(section('Не удалось загрузить',
      h('p', { class: 'gt-sk-err', role: 'alert', text: errText(e) }),
      h('button', { type: 'button', text: 'Повторить', onclick: retry })));
  }

  async function loadSkills() {
    try {
      const data = await getSkills();
      if (!disposed) renderSkills(skillsBox, data);
    } catch (e) {
      if (!disposed) failBox(skillsBox, e, loadSkills);
    }
  }
  async function loadExam() {
    try {
      const data = await getExam();
      if (!disposed) renderExam(examBox, data, loadExam);
    } catch (e) {
      if (!disposed) failBox(examBox, e, loadExam);
    }
  }

  await Promise.all([loadSkills(), loadExam()]);
  return () => { disposed = true; };
}

export default mount;