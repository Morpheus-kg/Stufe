import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, checkBatch, aggregate, sanitizeErrors } from '../server/ai/batchcheck.js';
import { runCheck } from '../server/routes/translate.js';
import { scoreFromCriteria } from '../server/routes/retell.js';

// Фейковый ИИ: отвечает по каждому [idx N] из промпта; skipFirst — пропустить idx в первом вызове
function fakeChat(calls, { skipFirst = [], score = 80, errors = [], used = [] } = {}) {
  return async (opts) => {
    calls.push(opts);
    const skip = calls.length === 1 ? skipFirst : [];
    const idxs = [...opts.user.matchAll(/^\[idx (\d+)\]/gm)].map((m) => Number(m[1])).filter((i) => !skip.includes(i));
    return {
      provider: 'mock', cached: false,
      data: {
        results: idxs.map((idx) => ({ idx, is_acceptable: true, score, corrected: 'k', model_translation: 'm', errors, used_target_words: used, comment_ru: 'ok' })),
        summary: { tips: [{ category: 'artikel', tip_ru: 'Учите артикль с словом.' }], strengths_ru: ['Хороший порядок слов'], focus_ru: ['Артикли'], overall_ru: 'Нормально.' },
      },
    };
  };
}
const mk = (n) => Array.from({ length: n }, (_, i) => ({ idx: i + 1, source: `s${i}`, answer: `a${i}`, reference: `r${i}` }));

test('chunk делит по 6', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).map((c) => c.length), [6, 6, 2]);
});

test('14 ответов = 3 вызова ИИ, результаты слиты по idx', async () => {
  const calls = [];
  const r = await checkBatch(mk(14), { kind: 'ru_de', chat: fakeChat(calls) });
  assert.equal(calls.length, 3);
  assert.equal(r.items.length, 14);
  assert.deepEqual(r.items.map((i) => i.idx), mk(14).map((i) => i.idx));
  assert.equal(r.score, 80);
  assert.equal(calls[0].tier, 'strong');
});

test('пустые ответы: answered=false, балл 0, без вызова ИИ для них', async () => {
  const calls = [];
  const items = [...mk(2), { idx: 3, source: 's', answer: '   ', reference: 'ref' }];
  const r = await checkBatch(items, { kind: 'ru_de', chat: fakeChat(calls) });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].user.includes('[idx 3]'));
  const u = r.items[2];
  assert.equal(u.answered, false);
  assert.equal(u.score, 0);
  assert.equal(u.model_translation, 'ref');
  assert.equal(r.score, Math.round((80 + 80 + 0) / 3));
});

test('пропущенный idx запрашивается повторно один раз', async () => {
  const calls = [];
  const r = await checkBatch(mk(3), { kind: 'ru_de', chat: fakeChat(calls, { skipFirst: [2] }) });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].user.includes('[idx 2]') && !calls[1].user.includes('[idx 1]'));
  assert.equal(r.items[1].score, 80);
});

test('если ИИ так и не вернул idx, он не входит в средний балл', async () => {
  const chat = async (opts) => ({ provider: 'm', data: { results: [{ idx: 1, score: 100 }] } });
  const r = await checkBatch(mk(2), { kind: 'ru_de', chat });
  assert.equal(r.items[1].answered, true);
  assert.equal(r.items[1].score, 0);
  assert.equal(r.score, 100);
});

test('паттерны, слова на повторение и подсказки считаются кодом', async () => {
  const errors = [
    { category: 'artikel', original: 'der Haus', fix: 'das Haus', explanation_ru: 'Род.' },
    { category: 'выдуманная', original: 'x', fix: 'y', explanation_ru: 'z' },
  ];
  const targetsById = new Map([[5, 'die Armut'], [6, 'das Ziel']]);
  const items = [{ idx: 1, source: 's', answer: 'a', card_id: 5 }, { idx: 2, source: 's', answer: 'a', card_id: 6 }];
  const r = await checkBatch(items, { kind: 'ru_de', chat: fakeChat([], { errors, used: [5, 999] }), targetsById });
  assert.equal(r.summary.patterns.find((p) => p.category === 'artikel').count, 2);
  assert.equal(r.summary.patterns.find((p) => p.category === 'artikel').tip_ru, 'Учите артикль с словом.');
  assert.equal(r.summary.patterns.find((p) => p.category === 'sonstiges').count, 2);
  assert.deepEqual(r.items[0].used_target_words, [5]);
  assert.deepEqual(r.items[1].used_target_words, []);
  assert.deepEqual(r.summary.words_to_review, [6]);
  assert.ok(r.summary.focus_ru.length <= 3);
});

test('aggregate: без результатов балл 0', () => {
  assert.equal(aggregate([], new Map()).score, 0);
  assert.deepEqual(sanitizeErrors('мусор'), []);
});

test('scoreFromCriteria', () => {
  assert.equal(scoreFromCriteria({ content: 4, coherence: 4, vocabulary: 3, grammar: 3 }), 70);
  assert.equal(scoreFromCriteria({ content: 9, coherence: -1 }), 25);
});

test('повторная проверка набора -> 409; ответ скрывал reference до проверки', async () => {
  const row = {
    id: 7, kind: 'ru_de', level: 'B2', checked_at: null,
    items: JSON.stringify([{ idx: 1, source_text: 'a', reference: 'r1', card_id: null }, { idx: 2, source_text: 'b', reference: 'r2', card_id: null }]),
  };
  const saved = [];
  const query = async (sql, params) => {
    if (sql.startsWith('SELECT id, kind')) return [{ ...row }];
    if (sql.includes('SET checked_at = NULL')) { row.checked_at = null; return { affectedRows: 1 }; }
    if (sql.includes('SET checked_at = ?')) {
      if (row.checked_at) return { affectedRows: 0 };
      row.checked_at = params[0]; return { affectedRows: 1 };
    }
    if (sql.includes('SET answers')) { saved.push(params); return { affectedRows: 1 }; }
    return [];
  };
  const calls = [];
  const deps = { query, chat: fakeChat(calls), log: async () => {} };
  const res = await runCheck(7, [{ idx: 1, answer: 'x' }], 10, deps);
  assert.equal(res.id, 7);
  assert.equal(res.items[1].answered, false);
  assert.equal(calls.length, 1);
  assert.equal(saved.length, 1);
  await assert.rejects(() => runCheck(7, [{ idx: 1, answer: 'x' }], 0, deps), (e) => e.status === 409);
  assert.equal(calls.length, 1);
});

test('сбой ИИ освобождает набор для повторной проверки', async () => {
  const row = { id: 8, kind: 'ru_de', level: 'B2', checked_at: null, items: JSON.stringify([{ idx: 1, source_text: 'a', reference: 'r', card_id: null }]) };
  const query = async (sql, params) => {
    if (sql.startsWith('SELECT id, kind')) return [{ ...row }];
    if (sql.includes('SET checked_at = NULL')) { row.checked_at = null; return { affectedRows: 1 }; }
    if (sql.includes('SET checked_at = ?')) { row.checked_at = params[0]; return { affectedRows: 1 }; }
    return { affectedRows: 1 };
  };
  const deps = { query, chat: async () => { throw new Error('down'); }, log: async () => {} };
  await assert.rejects(() => runCheck(8, [{ idx: 1, answer: 'x' }], 0, deps));
  assert.equal(row.checked_at, null);
});