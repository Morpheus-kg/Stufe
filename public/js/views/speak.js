// Sprechen: shadow (повтор за диктором, без ИИ), free (монолог + мультимодальная оценка Gemini Audio) и discussion (диалог B2)
import { h, toast, state, speakText } from '../app.js';
import {
  speakingPrompt, speakingEvaluate, speakingEvaluateAudio,
  discussionStart, discussionTurn, discussionFinish,
} from '../api2.js';
import { createStt, sttSupport } from '../stt.js';
import { createRecorder, recorderSupported } from '../recorder.js';

const st = (el, o) => { Object.assign(el.style, o); return el; };
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : '');
const CRIT_RU = {
  content: 'Содержание',
  argumentation: 'Аргументация',
  interaction: 'Взаимодействие',
  vocabulary: 'Лексика',
  grammar: 'Грамматика',
  coherence: 'Связность',
  pronunciation: 'Произношение',
};

function errText(e) {
  const c = e && e.code;
  if (c === 'AI_CAP') return 'Дневной лимит ИИ исчерпан. Попробуйте завтра.';
  if (c === 'AI_UNAVAILABLE') return 'ИИ или распознавание сейчас недоступны. Можно ввести текст вручную.';
  if (c === 'RATE_LIMITED') return 'Слишком много запросов. Подождите немного.';
  if (c === 'NETWORK') return 'Нет соединения с сервером.';
  return (e && e.message) || 'Что-то пошло не так.';
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Diff с текстовыми метками (не только цвет) */
function diffBlock(diff) {
  const p = st(h('p', {}), { lineHeight: 'var(--lh-read)' });
  for (const d of arr(diff)) {
    if (!d || typeof d !== 'object') continue;
    const w = str(d.w);
    if (d.t === 'del') p.append(h('span', { class: 'd-del', text: `[−${w}]`, 'aria-label': `лишнее: ${w}` }), ' ');
    else if (d.t === 'ins') p.append(h('span', { class: 'd-ins', text: `[+${w}]`, 'aria-label': `пропущено: ${w}` }), ' ');
    else p.append(w, ' ');
  }
  return p;
}

function bar(label, v) {
  const n = Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
  const fill = h('div', { class: 'progress-fill', style: `width: ${n * 20}%` });
  const track = h('div', { class: 'progress', role: 'img', 'aria-label': `${label}: ${n} из 5`, style: 'flex: 1;' }, fill);
  return h('div', { class: 'row', style: 'gap: var(--s3); font-size: var(--fs-sm);' },
    h('span', { text: label, style: 'min-width: 110px;' }), track, h('span', { text: ` ${n}/5` }));
}

function listBlock(title, items) {
  const l = arr(items).filter((x) => typeof x === 'string' && x.trim());
  return l.length ? h('div', {}, h('strong', { text: title }), h('ul', {}, l.map((t) => h('li', { text: t })))) : null;
}

export async function mount(container) {
  let alive = true;
  let activeStt = null;
  let timerId = null;
  const stopAll = () => {
    clearInterval(timerId); timerId = null;
    if (activeStt) { try { activeStt.cancel ? activeStt.cancel() : activeStt.stop().catch(() => {}); } catch { /* ignore */ } activeStt = null; }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch { /* ignore */ }
  };
  const clear = () => container.replaceChildren();

  // ---------- результат ----------
  function showResult(res, task) {
    stopAll();
    const score = Math.round(Number(res && res.score) || 0);
    const crit = res && res.criteria && typeof res.criteria === 'object' ? res.criteria : null;
    const target = arr(res && res.used_target_words).length;
    clear();
    container.append(
      h('h2', { text: 'Результат' }),
      h('div', { class: 'card-box stack' },
        h('div', { class: 'score-big', text: `${score}` }),
        h('div', { class: 'stat-label', text: 'из 100 баллов' }),
        crit ? h('div', { class: 'stack', style: 'margin-top: var(--s2);' }, Object.keys(crit).filter((k) => CRIT_RU[k]).map((k) => bar(CRIT_RU[k], crit[k]))) : null,
        res && res.wpm ? h('p', { class: 'muted', text: `Темп речи: ~${res.wpm} сл./мин` }) : null,
        str(res && res.pronunciation_ru) ? h('div', {}, h('strong', { text: 'Фонетика и произношение (Gemini Audio)' }), h('p', { text: res.pronunciation_ru })) : null,
        str(res && res.fluency_ru) ? h('div', {}, h('strong', { text: 'Темп, паузы и интонация' }), h('p', { text: res.fluency_ru })) : null,
        task.kind === 'free' && arr(task.target_card_ids).length ? h('p', { class: 'muted', text: `Целевых слов использовано: ${target} из ${arr(task.target_card_ids).length}` }) : null,
        arr(res && res.used_redemittel).length ? listBlock('Использованные Redemittel', res.used_redemittel) : null,
        arr(res && res.diff).length ? h('div', {}, h('strong', { text: 'Сравнение с образцом' }), diffBlock(res.diff)) : null,
        listBlock('Что получилось', res && res.strengths_ru),
        listBlock('Что улучшить', res && res.improvements_ru),
        str(res && res.corrected_sample) ? h('div', {}, h('strong', { text: 'Исправленный вариант' }), h('p', { text: res.corrected_sample })) : null,
        str(res && res.summary_ru) ? h('div', {}, h('strong', { text: 'Итог дискуссии' }), h('p', { text: res.summary_ru })) : null,
        h('p', { class: 'muted', text: str(res && res.note_ru) || '' })
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary block lg', type: 'button', text: 'Ещё раз', onclick: showSetup }))
    );
    window.scrollTo(0, 0);
  }

  // ---------- задание Shadow (локальное прослушивание и запись для самоконтроля, без Whisper/LLM) ----------
  function showShadowTask(task) {
    stopAll();
    const canRec = recorderSupported();
    let rec = null;
    let recording = false;
    let audioUrl = null;
    const msg = h('p', { class: 'muted' }, 'Прослушайте диктора, запишите свой голос и сравните произношение на слух.');
    const recBtn = h('button', { class: 'btn primary', type: 'button', text: '🎙 Записать себя' });
    const playBox = h('div', { class: 'stack' });
    st(recBtn, { minHeight: '48px' });
    recBtn.hidden = !canRec;

    const cleanupUrl = () => {
      if (audioUrl) { try { URL.revokeObjectURL(audioUrl); } catch { /* ignore */ } audioUrl = null; }
    };

    recBtn.addEventListener('click', async () => {
      if (!recording) {
        cleanupUrl();
        playBox.replaceChildren();
        try {
          rec = createRecorder({ maxSeconds: 60 });
          await rec.start();
          recording = true;
          recBtn.textContent = '⏹ Остановить запись';
        } catch (e) {
          msg.textContent = errText(e);
        }
      } else {
        recording = false;
        recBtn.disabled = true;
        try {
          const { blob } = await rec.stop();
          if (!alive) return;
          audioUrl = URL.createObjectURL(blob);
          const audioEl = h('audio', { controls: true, src: audioUrl });
          st(audioEl, { width: '100%' });
          playBox.replaceChildren(h('strong', { text: 'Ваша запись:' }), audioEl);
        } catch (e) {
          if (!alive) return;
          msg.textContent = errText(e);
        } finally {
          recBtn.disabled = false;
          recBtn.textContent = '🎙 Записать заново';
        }
      }
    });

    const listen = h('button', { class: 'btn', type: 'button', text: '🔊 Прослушать диктора', onclick: () => speakText(String(task.expected)) });
    const slow = h('button', { class: 'btn', type: 'button', text: '🐢 Медленно', onclick: () => import('../tts.js').then((m) => m.speak(String(task.expected), { rate: 0.7 })) });
    const nextBtn = h('button', {
      class: 'btn primary',
      type: 'button',
      text: 'Другая фраза →',
      onclick: async () => {
        cleanupUrl();
        try {
          const next = await speakingPrompt({ kind: 'shadow' });
          if (alive && next && next.expected) showShadowTask(next);
        } catch (e) {
          toast(errText(e));
        }
      },
    });
    for (const b of [listen, slow, nextBtn]) st(b, { minHeight: '44px' });

    clear();
    container.append(h('div', { class: 'stack' },
      h('h2', { text: 'Повтор за диктором (Shadowing)' }),
      msg,
      h('div', { class: 'card-box stack' },
        st(h('p', { text: String(task.expected) }), { fontSize: '1.15em', lineHeight: '1.6' }),
        h('div', { class: 'actions' }, listen, slow)),
      h('div', { class: 'actions' }, recBtn, nextBtn),
      playBox,
      h('div', { class: 'actions' }, st(h('button', { class: 'btn', type: 'button', text: '← Назад', onclick: () => { cleanupUrl(); stopAll(); showSetup(); } }), { minHeight: '44px' }))
    ));
  }

  // ---------- задание и запись ----------
  function showTask(task, engineName) {
    if (task.kind === 'shadow') return showShadowTask(task);
    const isFree = task.kind === 'free';
    const limit = isFree ? (Number(task.time_limit_s) > 0 ? Math.min(300, Number(task.time_limit_s)) : 120) : 60;
    const sup = sttSupport();
    let engine = engineName;
    if (!sup[engine]) engine = sup[engine === 'whisper' ? 'browser' : 'whisper'] ? (engine === 'whisper' ? 'browser' : 'whisper') : null;
    let engineUsed = engine || 'browser';
    let recording = false;
    let busy = false;
    let durationS = 0;

    const timerEl = st(h('div', { text: fmt(limit), 'aria-live': 'off' }), { fontSize: '1.6em', textAlign: 'center' });
    const interimEl = st(h('p', { class: 'muted' }), { minHeight: '1.5em' });
    const msg = h('p', { class: 'error' });
    const ta = h('textarea', { rows: '6', maxlength: '4000', 'aria-label': 'Транскрипт', lang: 'de', spellcheck: 'false' });
    st(ta, { width: '100%', boxSizing: 'border-box', padding: '10px', fontSize: '1.05em' });
    const taBox = h('div', { class: 'stack' },
      h('p', { class: 'muted', text: engine ? 'Проверьте распознанный текст и поправьте ошибки распознавания.' : 'Запись недоступна на этом устройстве: введите текст вручную.' }), ta);
    taBox.hidden = !!engine;
    const recBtn = h('button', { class: 'btn primary', type: 'button', text: '🎙 Начать запись', 'aria-pressed': 'false' });
    const audioEvalBtn = h('button', { class: 'btn', type: 'button', text: '🎧 Записать для оценки произношения (Gemini Audio)' });
    const sendBtn = h('button', { class: 'btn primary', type: 'button', text: 'Оценить' });
    for (const b of [recBtn, audioEvalBtn, sendBtn]) st(b, { minHeight: '48px' });
    sendBtn.hidden = !!engine;
    recBtn.hidden = !engine;
    audioEvalBtn.hidden = !isFree || !recorderSupported();

    let audioRec = null;
    let audioRecording = false;
    audioEvalBtn.addEventListener('click', async () => {
      if (busy) return;
      msg.textContent = '';
      if (!audioRecording) {
        try {
          audioRec = createRecorder({ maxSeconds: limit });
          await audioRec.start();
          audioRecording = true;
          audioEvalBtn.textContent = '⏹ Остановить и оценить по аудио (Gemini)';
          recBtn.disabled = true;
        } catch (e) {
          msg.textContent = errText(e);
        }
      } else {
        audioRecording = false;
        busy = true;
        audioEvalBtn.disabled = true;
        audioEvalBtn.textContent = 'Оцениваю звук и произношение…';
        try {
          const { blob, duration_s } = await audioRec.stop();
          const res = await speakingEvaluateAudio(blob, {
            durationS: duration_s,
            prompt: str(task.prompt_de) || str(task.prompt_ru) || 'Freier Monolog',
            targetCardIds: arr(task.target_card_ids).filter((n) => Number.isInteger(n)),
          });
          if (!alive) return;
          showResult(res, task);
        } catch (e) {
          if (!alive) return;
          msg.textContent = errText(e);
          audioEvalBtn.disabled = false;
          audioEvalBtn.textContent = '🎧 Записать для оценки произношения (Gemini Audio)';
          recBtn.disabled = false;
        } finally {
          busy = false;
        }
      }
    });

    async function startRec() {
      msg.textContent = '';
      try {
        activeStt = createStt(engine, { onInterim: (t) => { if (alive) interimEl.textContent = t; } });
        await activeStt.start();
      } catch (e) {
        activeStt = null;
        msg.textContent = errText(e);
        taBox.hidden = false; sendBtn.hidden = false;
        return;
      }
      recording = true;
      recBtn.textContent = '⏹ Остановить';
      recBtn.setAttribute('aria-pressed', 'true');
      let left = limit;
      timerEl.textContent = fmt(left);
      timerId = setInterval(() => {
        left -= 1;
        timerEl.textContent = fmt(Math.max(0, left));
        if (left <= 0) stopRec();
      }, 1000);
    }

    async function stopRec() {
      if (!recording || busy) return;
      busy = true;
      recording = false;
      clearInterval(timerId); timerId = null;
      recBtn.disabled = true;
      recBtn.textContent = engine === 'whisper' ? 'Распознаю…' : 'Завершаю…';
      const s = activeStt; activeStt = null;
      try {
        const r = await s.stop();
        if (!alive) return;
        ta.value = String(r.transcript || '').slice(0, 4000);
        durationS = r.duration_s || 0;
        engineUsed = r.engine || engine;
        if (!ta.value.trim()) msg.textContent = 'Речь не распознана. Запишите ещё раз или введите текст вручную.';
      } catch (e) {
        if (!alive) return;
        msg.textContent = errText(e) + ' Запишите ещё раз или введите текст вручную.';
      }
      busy = false;
      interimEl.textContent = '';
      taBox.hidden = false; sendBtn.hidden = false;
      recBtn.disabled = false;
      recBtn.textContent = '🎙 Записать заново';
      recBtn.setAttribute('aria-pressed', 'false');
      timerEl.textContent = fmt(limit);
    }

    recBtn.addEventListener('click', () => { if (recording) stopRec(); else if (!busy) startRec(); });

    sendBtn.addEventListener('click', async () => {
      const transcript = ta.value.trim().slice(0, 4000);
      if (!transcript) { msg.textContent = 'Пустой текст: сначала запишите ответ или введите его.'; return; }
      sendBtn.disabled = true; msg.textContent = '';
      sendBtn.textContent = 'Оцениваю…';
      try {
        const res = await speakingEvaluate({
          kind: task.kind,
          prompt: str(task.prompt_de) || str(task.prompt_ru) || str(task.expected) || 'Sprechen',
          ...(task.expected ? { expected: String(task.expected) } : {}),
          transcript,
          duration_s: Math.max(0, Math.round(durationS)),
          engine: engineUsed,
          target_card_ids: arr(task.target_card_ids).filter((n) => Number.isInteger(n)),
          ...(task.provider && task.provider !== 'auto' ? { provider: task.provider } : {}),
        });
        if (!alive) return;
        showResult(res, task);
      } catch (e) {
        if (!alive) return;
        sendBtn.disabled = false; sendBtn.textContent = 'Оценить';
        msg.textContent = errText(e); // текст сохранён в поле
      }
    });

    const listen = task.expected ? h('button', { class: 'btn', type: 'button', text: '🔊 Прослушать', onclick: () => speakText(String(task.expected)) }) : null;
    const slow = task.expected ? h('button', { class: 'btn', type: 'button', text: '🐢 Медленно', onclick: () => import('../tts.js').then((m) => m.speak(String(task.expected), { rate: 0.7 })) }) : null;
    for (const b of [listen, slow]) if (b) st(b, { minHeight: '44px' });

    clear();
    container.append(h('div', { class: 'stack' },
      h('h2', { text: isFree ? 'Свободная речь' : 'Повтор за диктором' }),
      str(task.prompt_ru) ? h('p', { text: task.prompt_ru }) : null,
      isFree && str(task.prompt_de) ? st(h('p', {}, h('strong', { text: task.prompt_de })), { fontSize: '1.1em' }) : null,
      !isFree && task.expected ? h('div', { class: 'card-box stack' }, st(h('p', { text: String(task.expected) }), { fontSize: '1.15em', lineHeight: '1.6' }),
        h('div', { class: 'actions' }, listen, slow)) : null,
      isFree && arr(task.target_card_ids).length ? h('p', { class: 'muted', text: `Постарайтесь использовать слова из ваших карточек (${arr(task.target_card_ids).length}).` }) : null,
      timerEl, interimEl, h('div', { class: 'actions' }, recBtn, audioEvalBtn), taBox, h('div', { class: 'actions' }, sendBtn), msg,
      h('div', { class: 'actions' }, st(h('button', { class: 'btn', type: 'button', text: '← Назад', onclick: () => { stopAll(); showSetup(); } }), { minHeight: '44px' }))
    ));
  }

  // ---------- интерактивная дискуссия B2 (3–4 реплики) ----------
  function showDiscussion(sess, engineName, provider) {
    stopAll();
    const sup = sttSupport();
    let engine = engineName;
    if (!sup[engine]) engine = sup[engine === 'whisper' ? 'browser' : 'whisper'] ? (engine === 'whisper' ? 'browser' : 'whisper') : null;
    let recording = false;
    let busy = false;
    const t0 = Date.now();

    const turnsBox = h('div', { class: 'stack' });
    const redemittelBox = h('div', { class: 'row wrap', style: 'gap: 6px;' });
    const ta = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'Ваша реплика по-немецки (можно надиктовать или ввести)…', lang: 'de' });
    st(ta, { width: '100%', boxSizing: 'border-box', padding: '10px', fontSize: '1.05em' });
    const recBtn = h('button', { class: 'btn', type: 'button', text: '🎙 Надиктовать реплику' });
    const replyBtn = h('button', { class: 'btn primary', type: 'button', text: 'Отправить реплику →' });
    const finishBtn = h('button', { class: 'btn ok', type: 'button', text: '✓ Завершить дискуссию и получить оценку', hidden: true });
    const msg = h('p', { class: 'error' });
    recBtn.hidden = !engine;

    function renderTurns(turns) {
      turnsBox.replaceChildren();
      for (const t of arr(turns)) {
        const isPartner = t.role === 'assistant';
        const box = h('div', {
          class: 'card-box stack',
          style: isPartner ? 'border-left: 4px solid var(--accent);' : 'border-left: 4px solid var(--ok, #16a34a);',
        },
          h('div', { class: 'row', style: 'justify-content: space-between; align-items: center;' },
            h('strong', { text: isPartner ? '🗣 Собеседник' : '👤 Вы' }),
            isPartner
              ? h('button', { class: 'btn small', type: 'button', text: '🔊 Прослушать', onclick: () => speakText(str(t.text_de)) })
              : null
          ),
          h('p', { lang: 'de', text: str(t.text_de), style: 'margin: 4px 0;' }),
          isPartner && str(t.text_ru) ? h('small', { class: 'muted', text: t.text_ru }) : null,
          !isPartner && str(t.micro_fix_de)
            ? h('small', { class: 'muted', text: `💡 Лучше сказать: ${t.micro_fix_de}${t.micro_fix_ru ? ` (${t.micro_fix_ru})` : ''}` })
            : null
        );
        turnsBox.append(box);
      }
    }

    function renderRedemittel(list) {
      redemittelBox.replaceChildren();
      for (const phrase of arr(list)) {
        redemittelBox.append(h('button', {
          class: 'btn small',
          type: 'button',
          text: `+ ${phrase}`,
          onclick: () => {
            ta.value = (ta.value ? `${ta.value.trim()} ` : '') + phrase + ' ';
            ta.focus();
          },
        }));
      }
    }

    recBtn.addEventListener('click', async () => {
      if (busy) return;
      msg.textContent = '';
      if (!recording) {
        try {
          activeStt = createStt(engine, {});
          await activeStt.start();
          recording = true;
          recBtn.textContent = '⏹ Остановить диктовку';
        } catch (e) {
          activeStt = null;
          msg.textContent = errText(e);
        }
      } else {
        recording = false;
        recBtn.disabled = true;
        recBtn.textContent = 'Распознаю…';
        const s = activeStt; activeStt = null;
        try {
          const r = await s.stop();
          if (r && r.transcript) {
            ta.value = (ta.value ? `${ta.value.trim()} ` : '') + r.transcript.trim();
          }
        } catch (e) {
          msg.textContent = errText(e);
        } finally {
          recBtn.disabled = false;
          recBtn.textContent = '🎙 Надиктовать реплику';
        }
      }
    });

    replyBtn.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text.length < 2) { msg.textContent = 'Введите или надиктуйте ответ по-немецки.'; return; }
      busy = true;
      replyBtn.disabled = true;
      msg.textContent = '';
      replyBtn.textContent = 'Собеседник отвечает…';
      try {
        const r = await discussionTurn(sess.session_id, {
          text,
          ...(provider && provider !== 'auto' ? { provider } : {}),
        });
        if (!alive) return;
        ta.value = '';
        renderTurns(r.turns);
        renderRedemittel(r.suggested_redemittel);
        if (r.reply_de) speakText(r.reply_de);
        if (r.can_finish) finishBtn.hidden = false;
      } catch (e) {
        if (!alive) return;
        msg.textContent = errText(e);
      } finally {
        busy = false;
        replyBtn.disabled = false;
        replyBtn.textContent = 'Отправить реплику →';
      }
    });

    finishBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      finishBtn.disabled = true;
      finishBtn.textContent = 'Оцениваю дискуссию…';
      try {
        const res = await discussionFinish(sess.session_id, {
          duration_s: Math.round((Date.now() - t0) / 1000),
          ...(provider && provider !== 'auto' ? { provider } : {}),
        });
        if (!alive) return;
        showResult(res, { kind: 'discussion', target_card_ids: [] });
      } catch (e) {
        if (!alive) return;
        msg.textContent = errText(e);
        finishBtn.disabled = false;
        finishBtn.textContent = '✓ Завершить дискуссию и получить оценку';
      } finally {
        busy = false;
      }
    });

    renderTurns(sess.turns);
    renderRedemittel(sess.suggested_redemittel);
    const firstTurn = arr(sess.turns)[0];
    if (firstTurn && firstTurn.text_de) speakText(firstTurn.text_de);

    clear();
    container.append(h('div', { class: 'stack' },
      h('h2', { text: `Дискуссия (${sess.level || 'B2'}): ${sess.topic || ''}` }),
      str(sess.persona_ru) ? h('p', { class: 'muted', text: sess.persona_ru }) : null,
      arr(sess.target_words).length ? h('p', { class: 'muted', text: `Слова для использования: ${sess.target_words.join(', ')}` }) : null,
      turnsBox,
      h('div', { class: 'stack' },
        h('small', { class: 'muted', text: 'Подсказки Redemittel (нажмите, чтобы вставить):' }),
        redemittelBox,
        ta,
        h('div', { class: 'actions' }, recBtn, replyBtn),
        finishBtn,
        msg
      ),
      h('div', { class: 'actions' }, st(h('button', { class: 'btn', type: 'button', text: '← Назад', onclick: () => { stopAll(); showSetup(); } }), { minHeight: '44px' }))
    ));
  }

  // ---------- настройка ----------
  function showSetup() {
    stopAll();
    const sup = sttSupport();
    const kind = h('select', { 'aria-label': 'Режим' },
      h('option', { value: 'shadow', text: 'Shadow: повторите за диктором (локальный самоконтроль)' }),
      h('option', { value: 'free', text: 'Свободный монолог (текст или мультимодальное аудио Gemini)' }),
      h('option', { value: 'discussion', text: 'Дискуссия B2 (интерактивный диалог 3–4 реплики)' }));
    const level = h('select', { 'aria-label': 'Уровень' }, ['B1', 'B2', 'C1'].map((l) => h('option', { value: l, text: l, selected: l === 'B2' })));
    const topic = h('input', { type: 'text', maxlength: '60', placeholder: 'Тема (необязательно)', 'aria-label': 'Тема' });
    const prov = h('select', { 'aria-label': 'Модель ИИ' }, [
      ['auto', 'ИИ: Авто (Gemini)'],
      ['gemini:strong', 'Gemini Strong (Pro)'],
      ['gemini:fast', 'Gemini Fast (Flash)'],
      ['groq:strong', 'Groq Strong (Llama 70B)'],
      ['groq:fast', 'Groq Fast (Llama 8B)'],
      ['openrouter', 'OpenRouter'],
    ].map(([v, t]) => h('option', { value: v, text: t })));
    const def = state.settings && state.settings.stt_engine === 'whisper' ? 'whisper' : 'browser';
    const engine = h('select', { 'aria-label': 'Распознавание' },
      h('option', { value: 'browser', text: `Браузер${sup.browser ? '' : ' (недоступно)'}`, selected: def === 'browser' }),
      h('option', { value: 'whisper', text: `Whisper (сервер)${sup.whisper ? '' : ' (недоступно)'}`, selected: def === 'whisper' }));
    const topicRow = h('div', {}, topic, level, prov);
    topicRow.hidden = true;
    kind.addEventListener('change', () => { topicRow.hidden = kind.value === 'shadow'; });
    for (const el of [kind, level, topic, prov, engine]) st(el, { minHeight: '44px', width: '100%', boxSizing: 'border-box', marginBottom: '8px' });
    const err = h('p', { class: 'error' });
    const go = st(h('button', { class: 'btn primary', type: 'button', text: 'Начать' }), { minHeight: '48px' });
    go.addEventListener('click', async () => {
      go.disabled = true; err.textContent = ''; go.textContent = 'Готовлю задание…';
      try {
        if (kind.value === 'discussion') {
          const discBody = { level: level.value };
          if (topic.value.trim()) discBody.topic = topic.value.trim();
          if (prov.value !== 'auto') discBody.provider = prov.value;
          const sess = await discussionStart(discBody);
          if (!alive) return;
          showDiscussion(sess, engine.value, prov.value);
          return;
        }
        const body = { kind: kind.value, level: level.value };
        if (kind.value === 'free' && topic.value.trim()) body.topic = topic.value.trim();
        if (kind.value === 'free' && prov.value !== 'auto') body.provider = prov.value;
        const task = await speakingPrompt(body);
        if (!alive) return;
        if (!task || typeof task !== 'object') throw new Error('Пустое задание');
        if (task.kind === 'shadow' && !str(task.expected).trim()) {
          throw new Error('Нет подходящих предложений в карточках. Сначала добавьте слова с примерами.');
        }
        showTask({ ...task, kind: task.kind || kind.value, provider: prov.value }, engine.value);
      } catch (e) {
        if (!alive) return;
        go.disabled = false; go.textContent = 'Начать';
        err.textContent = errText(e);
      }
    });
    clear();
    container.append(
      h('h2', { text: 'Sprechen' }),
      h('p', { class: 'muted', text: 'Выберите режим: локальный повтор за диктором, свободный монолог (с оценкой фонетики через Gemini Audio) или живую дискуссию B2.' }),
      !sup.browser && !sup.whisper ? h('p', { class: 'error', text: 'Запись звука недоступна: ответ можно будет ввести вручную.' }) : null,
      h('div', { class: 'card-box stack' }, kind, topicRow, engine, go, err)
    );
  }

  showSetup();
  return () => { alive = false; stopAll(); };
}