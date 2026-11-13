// M5: рендер word-level diff (поле diff из gradeTyped) + общие базовые стили модуля M5.
// Направление diff: ответ пользователя -> эталон.
//   del = слово есть в ответе, но лишнее/неверное; ins = слово пропущено в ответе.
// Смысл передаётся не только цветом: знак (− / +), подчёркивание/зачёркивание и скрытая подпись для скринридеров.

const DIFF_STYLE_ID = 'm5-diff-style';
const BASE_STYLE_ID = 'm5-base-style';
const MAX_PARTS = 300;
const MAX_WORD = 120;

const DIFF_CSS = `
.m5-diff-wrap{display:flex;flex-direction:column;gap:var(--s2)}
.m5-diff{margin:0;line-height:var(--lh-read);overflow-wrap:anywhere}
.m5-diff-del,.m5-diff-ins{border-radius:var(--radius-sm);padding:0 .3em;margin:0 .05em;text-decoration-thickness:2px}
.m5-diff-del{background:var(--danger-soft);color:var(--danger);text-decoration-line:line-through}
.m5-diff-ins{background:var(--success-soft);color:var(--success);text-decoration-line:underline}
.m5-diff-mark{font-weight:700;margin-right:.15em}
.m5-diff-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.m5-diff-legend{margin:0;font-size:var(--fs-xs);color:var(--text-3)}
`;

const BASE_CSS = `
.m5-row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.m5-col{display:flex;flex-direction:column;gap:var(--s3)}
.m5-btn{min-height:var(--tap);min-width:var(--tap);padding:var(--s2) var(--s4);border-radius:var(--radius);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:inherit;cursor:pointer;transition:background var(--dur),border-color var(--dur)}
.m5-btn:disabled{opacity:.4;cursor:default}
.m5-btn-primary{background:var(--primary);border-color:var(--primary);color:var(--on-primary);font-weight:600}
.m5-btn-danger{border-color:var(--danger);color:var(--danger);background:transparent}
.m5-btn-danger:hover{background:var(--danger-soft)}
.m5-input{min-height:var(--tap);padding:var(--s2) var(--s3);border-radius:var(--radius-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:inherit;width:100%;box-sizing:border-box}
.m5-field{display:flex;flex-direction:column;gap:var(--s1);font-size:var(--fs-sm);flex:1 1 140px;color:var(--text-2)}
.m5-note{margin:0;font-size:var(--fs-sm);color:var(--text-3)}
.m5-status{margin:0;min-height:1.2em;font-size:var(--fs-sm)}
.m5-err{color:var(--danger);font-weight:600}
.m5-box{margin:0;padding:var(--s2) var(--s3);border-radius:var(--radius-sm);background:var(--surface-2);overflow-wrap:anywhere}
.m5-badge{display:inline-flex;align-items:center;padding:2px var(--s2);border-radius:var(--radius-pill);border:1px solid var(--border);font-size:var(--fs-xs);color:var(--text-2);background:var(--surface-2)}
.m5-badge-warn{border-color:transparent;background:var(--warn-soft);color:var(--warn)}
.m5-badge-ok{border-color:transparent;background:var(--success-soft);color:var(--success)}
.m5-badge-bad{border-color:transparent;background:var(--danger-soft);color:var(--danger)}
.m5-card{border:1px solid var(--border);border-radius:var(--radius);padding:var(--s4);display:flex;flex-direction:column;gap:var(--s2);background:var(--surface);margin-bottom:var(--s3)}
`;

/** Добавляет <style> один раз (id защищает от дублей). */
function injectStyle(id, css) {
  if (typeof document === 'undefined' || !document.head) return;
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}

/** Общие стили кнопок/полей/бейджей для модулей M5 (идемпотентно). */
export function ensureM5Styles() {
  injectStyle(BASE_STYLE_ID, BASE_CSS);
  injectStyle(DIFF_STYLE_ID, DIFF_CSS);
}

/**
 * Очищает произвольный вход до безопасного списка частей diff.
 * @param {unknown} diff
 * @returns {{t:'same'|'del'|'ins', w:string}[]}
 */
function cleanParts(diff) {
  if (!Array.isArray(diff)) return [];
  const out = [];
  for (const p of diff) {
    if (out.length >= MAX_PARTS) break;
    if (!p || typeof p !== 'object') continue;
    if (p.t !== 'same' && p.t !== 'del' && p.t !== 'ins') continue;
    if (typeof p.w !== 'string' || p.w === '') continue;
    out.push({ t: p.t, w: p.w.slice(0, MAX_WORD) });
  }
  return out;
}

/** true, если в diff есть хоть одно отличие. */
export function diffHasChanges(diff) {
  return cleanParts(diff).some((p) => p.t !== 'same');
}

/**
 * Рисует diff. Весь текст вставляется через textContent.
 * @param {unknown} diff  массив [{t:'same'|'del'|'ins', w}]
 * @param {{legend?:boolean}} [opts]
 * @returns {HTMLElement}
 */
export function renderDiff(diff, opts = {}) {
  ensureM5Styles();
  const wrap = document.createElement('div');
  wrap.className = 'm5-diff-wrap';

  const line = document.createElement('p');
  line.className = 'm5-diff';
  line.lang = 'de';
  wrap.appendChild(line);

  const parts = cleanParts(diff);
  if (!parts.length) {
    line.textContent = '—';
    return wrap;
  }

  parts.forEach((p, i) => {
    if (i > 0) line.appendChild(document.createTextNode(' '));
    if (p.t === 'same') {
      const s = document.createElement('span');
      s.className = 'm5-diff-same';
      s.textContent = p.w;
      line.appendChild(s);
      return;
    }
    const isDel = p.t === 'del';
    const node = document.createElement(isDel ? 'del' : 'ins');
    node.className = isDel ? 'm5-diff-del' : 'm5-diff-ins';

    const sr = document.createElement('span');
    sr.className = 'm5-diff-sr';
    sr.textContent = isDel ? 'лишнее: ' : 'пропущено: ';

    const mark = document.createElement('span');
    mark.className = 'm5-diff-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = isDel ? '\u2212' : '+';

    const word = document.createElement('span');
    word.textContent = p.w;

    node.append(sr, mark, word);
    line.appendChild(node);
  });

  if (opts && opts.legend) {
    const legend = document.createElement('p');
    legend.className = 'm5-diff-legend';
    legend.textContent =
      '\u2212слово — лишнее или неверное в вашем ответе; +слово — пропущено; без знака — верно.';
    wrap.appendChild(legend);
  }
  return wrap;
}

export default renderDiff;