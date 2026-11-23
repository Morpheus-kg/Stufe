// Тесты настроек v1.1: значения по умолчанию, валидация, чтение из БД, веса навыков
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULTS, getSettings, getSkillWeights, saveSettings, settingsPatchSchema } from '../server/settings.js';
import { localDay, isValidTimezone } from '../server/time.js';

const ok = (patch) => settingsPatchSchema.safeParse(patch).success;
const fakeDb = (rows) => ({ async query() { return [rows, []]; } });

describe('значения по умолчанию v2', () => {
  it('совпадают с контрактом', () => {
    assert.deepEqual(
      Object.fromEntries(['difficulty', 'learn_auto_seconds', 'auto_next_ms', 'ai_provider_generate', 'stt_engine',
        'listening_plays', 'plan_minutes', 'weight_hoeren', 'weight_sprechen', 'weight_lesen', 'weight_schreiben',
        'weight_vocab', 'exam_date', 'numbers_level'].map((k) => [k, DEFAULTS[k]])),
      { difficulty: 'medium', learn_auto_seconds: 6, auto_next_ms: 900, ai_provider_generate: 'auto', stt_engine: 'browser',
        listening_plays: 2, plan_minutes: 20, weight_hoeren: 35, weight_sprechen: 25, weight_lesen: 25, weight_schreiben: 5,
        weight_vocab: 10, exam_date: '', numbers_level: 2 },
    );
  });
  it('пустая БД -> все настройки по умолчанию', async () => {
    assert.deepEqual(await getSettings(fakeDb([])), { ...DEFAULTS });
  });
  it('нет таблицы settings -> по умолчанию', async () => {
    const db = { async query() { throw Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' }); } };
    assert.deepEqual(await getSettings(db), { ...DEFAULTS });
  });
});

describe('валидация PUT /settings', () => {
  it('принимает корректные значения', () => {
    assert.ok(ok({ difficulty: 'hard', learn_auto_seconds: 0, auto_next_ms: 5000, ai_provider_generate: 'gemini',
      stt_engine: 'whisper', listening_plays: 1, plan_minutes: 120, weight_hoeren: 0, weight_vocab: 100,
      exam_date: '2027-03-15', numbers_level: 4 }));
    assert.ok(ok({ exam_date: '' }));
    assert.ok(ok({}));
  });
  it('отклоняет значения вне допустимых', () => {
    const bad = [
      { difficulty: 'extreme' }, { difficulty: 1 },
      { learn_auto_seconds: 31 }, { learn_auto_seconds: -1 }, { learn_auto_seconds: 1.5 }, { learn_auto_seconds: '6' },
      { auto_next_ms: 5001 }, { auto_next_ms: -1 },
      { ai_provider_generate: 'openai' }, { stt_engine: 'google' },
      { listening_plays: 0 }, { listening_plays: 3 }, { listening_plays: '2' },
      { plan_minutes: 4 }, { plan_minutes: 121 },
      { weight_hoeren: -1 }, { weight_lesen: 101 }, { weight_vocab: 2.5 }, { weight_schreiben: null },
      { exam_date: '2026-13-40' }, { exam_date: '2026-02-30' }, { exam_date: '26-01-01' }, { exam_date: '2026/01/01' }, { exam_date: null },
      { numbers_level: 0 }, { numbers_level: 5 },
    ];
    for (const b of bad) assert.equal(ok(b), false, JSON.stringify(b));
  });
  it('неизвестные ключи отбрасываются', () => {
    const r = settingsPatchSchema.parse({ difficulty: 'easy', bogus: 1 });
    assert.deepEqual(r, { difficulty: 'easy' });
  });
});

describe('чтение из БД', () => {
  it('типизирует значения, мусор заменяет умолчанием', async () => {
    const s = await getSettings(fakeDb([
      { key_name: 'difficulty', value: 'hard' },
      { key_name: 'listening_plays', value: '1' },
      { key_name: 'plan_minutes', value: '45' },
      { key_name: 'exam_date', value: '2027-03-15' },
      { key_name: 'ai_enabled', value: 'false' },
      { key_name: 'stt_engine', value: 'nonsense' },
      { key_name: 'auto_next_ms', value: 'abc' },
      { key_name: 'numbers_level', value: '9' },
      { key_name: 'exam_date_old', value: 'x' },
    ]));
    assert.equal(s.difficulty, 'hard');
    assert.equal(s.listening_plays, 1);
    assert.equal(s.plan_minutes, 45);
    assert.equal(s.exam_date, '2027-03-15');
    assert.equal(s.ai_enabled, false);
    assert.equal(s.stt_engine, 'browser');
    assert.equal(s.auto_next_ms, 900);
    assert.equal(s.numbers_level, 2);
    assert.equal('exam_date_old' in s, false);
  });
  it('saveSettings пишет строки и пропускает неизвестное', async () => {
    const calls = [];
    await saveSettings({ difficulty: 'easy', listening_plays: 1, bogus: 5, exam_date: '' }, { async query(sql, p) { calls.push(p); return [{}]; } });
    assert.deepEqual(calls, [['difficulty', 'easy'], ['listening_plays', '1'], ['exam_date', '']]);
  });
});

describe('getSkillWeights', () => {
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  it('по умолчанию нормализуются до 1', () => {
    const w = getSkillWeights(DEFAULTS);
    assert.ok(Math.abs(sum(w) - 1) < 1e-9);
    assert.ok(Math.abs(w.hoeren - 0.35) < 1e-9);
  });
  it('все нули -> значения по умолчанию', () => {
    const z = { weight_hoeren: 0, weight_sprechen: 0, weight_lesen: 0, weight_schreiben: 0, weight_vocab: 0 };
    assert.deepEqual(getSkillWeights(z), getSkillWeights(DEFAULTS));
  });
  it('пользовательские веса нормализуются', () => {
    const w = getSkillWeights({ ...DEFAULTS, weight_hoeren: 50, weight_sprechen: 50, weight_lesen: 0, weight_schreiben: 0, weight_vocab: 0 });
    assert.equal(w.hoeren, 0.5);
    assert.equal(w.lesen, 0);
  });
});

describe('.env.example', () => {
  it('содержит новые переменные v2', () => {
    const env = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const k of ['GROQ_MODEL_STT=whisper-large-v3-turbo', 'AI_DAILY_CAP_TEXT=30', 'AI_DAILY_CAP_TRANSLATE=100',
      'AI_DAILY_CAP_SPEAK=60', 'AI_DAILY_CAP_WRITE=30', 'AI_DAILY_CAP_LOOKUP=300']) assert.ok(env.includes(k), k);
  });
});

describe('персональная таймзона (timezone и смена суток в 04:00)', () => {
  it('валидация timezone в настройках', () => {
    assert.equal(isValidTimezone('Europe/Berlin'), true);
    assert.equal(isValidTimezone('Asia/Almaty'), true);
    assert.equal(isValidTimezone('Not/A_Zone'), false);
    assert.ok(ok({ timezone: 'Asia/Almaty' }));
    assert.ok(ok({ timezone: '' }));
    assert.equal(ok({ timezone: 'Invalid/Timezone_Name' }), false);
  });
  it('localDay учитывает смещение 04:00 и таймзону пользователя', () => {
    // 2026-03-10 00:30 UTC:
    // В Europe/Berlin (UTC+1) это 01:30 ночи -> до 04:00 ещё предыдущий учебный день (2026-03-09)
    // В Asia/Almaty (UTC+5) это 05:30 утра -> уже новый учебный день (2026-03-10)
    const dt = '2026-03-10T00:30:00.000Z';
    assert.equal(localDay(dt, 'Europe/Berlin'), '2026-03-09');
    assert.equal(localDay(dt, 'Asia/Almaty'), '2026-03-10');
  });
});