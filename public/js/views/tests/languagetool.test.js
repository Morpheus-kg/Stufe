import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLanguageToolService,
  mapLtCategory,
  extractContextSentence,
  buildSuggestedCardTerm,
} from '../server/services/languagetool_service.js';
import { createLanguageToolClient } from '../public/js/services/languagetool_service.js';

test('LanguageToolService: успешная проверка de-DE, маппинг категорий и умное извлечение фразы для FSRS', async () => {
  const text = 'Ich wohne in der Wohnung. Er hat ein grose Problem.';
  let capturedBody = '';
  const lt = createLanguageToolService({
    baseUrl: 'https://lt.local/v2/check',
    timeoutMs: 3000,
    fetch: async (url, init) => {
      assert.equal(url, 'https://lt.local/v2/check');
      assert.equal(init.method, 'POST');
      capturedBody = init.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          matches: [
            {
              offset: 13,
              length: 3,
              message: 'Prüfen Sie den Artikel (Genus).',
              shortMessage: 'Artikel',
              replacements: [{ value: 'die' }],
              rule: { id: 'DER_DIE_DAS', description: 'Falscher Artikel', category: { id: 'GRAMMAR' }, issueType: 'grammar' },
            },
            {
              offset: 37,
              length: 5,
              message: 'Möglicher Rechtschreibfehler gefunden.',
              shortMessage: 'Rechtschreibung',
              replacements: [{ value: 'großes' }, { value: 'große' }],
              rule: { id: 'GERMAN_SPELLER_RULE', description: 'Rechtschreibung', category: { id: 'TYPOS' }, issueType: 'misspelling' },
            },
          ],
        }),
      };
    },
  });

  const res = await lt.check(text);
  assert.match(capturedBody, /language=de-DE/);
  assert.equal(res.available, true);
  assert.equal(res.degraded, false);
  assert.equal(res.matches.length, 2);

  // Артикль "der" -> "die" перед "Wohnung" должен склеиться в "die Wohnung" для FSRS
  assert.equal(res.matches[0].category, 'artikel');
  assert.equal(res.matches[0].bad, 'der');
  assert.equal(res.matches[0].suggestedCardTerm, 'die Wohnung');
  assert.equal(res.matches[0].contextSentence, 'Ich wohne in der Wohnung.');

  // Орфография
  assert.equal(res.matches[1].category, 'rechtschreibung');
  assert.equal(res.matches[1].bad, 'grose');
  assert.deepEqual(res.matches[1].replacements, ['großes', 'große']);
  assert.equal(res.matches[1].suggestedCardTerm, 'großes');
  assert.equal(res.matches[1].contextSentence, 'Er hat ein grose Problem.');
});

test('LanguageToolService: тихий graceful fallback при таймауте, 429 rate-limit и ошибке сети', async () => {
  // 1) Таймаут
  const ltTimeout = createLanguageToolService({
    baseUrl: 'https://lt.local/v2/check',
    timeoutMs: 500,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  const rTimeout = await ltTimeout.check('Hallo Welt', { timeoutMs: 500 });
  assert.deepEqual(rTimeout, { available: false, degraded: true, reason: 'timeout', language: 'de-DE', matches: [] });

  // 2) Rate-limit 429
  const lt429 = createLanguageToolService({
    baseUrl: 'https://lt.local/v2/check',
    fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  const r429 = await lt429.check('Hallo Welt');
  assert.deepEqual(r429, { available: false, degraded: true, reason: 'rate_limit', language: 'de-DE', matches: [] });

  // 3) Сетевая ошибка
  const ltNet = createLanguageToolService({
    baseUrl: 'https://lt.local/v2/check',
    fetch: async () => { throw new TypeError('fetch failed'); },
  });
  const rNet = await ltNet.check('Hallo Welt');
  assert.deepEqual(rNet, { available: false, degraded: true, reason: 'network', language: 'de-DE', matches: [] });
});

test('LanguageToolClient (frontend): тихий fallback при сбое сети и корректный проброс ответа', async () => {
  const clientFail = createLanguageToolClient({
    fetch: async () => { throw new Error('offline'); },
  });
  const rFail = await clientFail.check('Das ist gut.');
  assert.equal(rFail.available, false);
  assert.equal(rFail.degraded, true);
  assert.deepEqual(rFail.matches, []);

  const clientOk = createLanguageToolClient({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ available: true, degraded: false, language: 'de-DE', matches: [{ bad: 'tst' }] }),
    }),
  });
  const rOk = await clientOk.check('tst');
  assert.equal(rOk.available, true);
  assert.equal(rOk.matches.length, 1);
});

test('mapLtCategory / extractContextSentence / buildSuggestedCardTerm: граничные случаи', () => {
  assert.equal(mapLtCategory({ category: { id: 'PUNCTUATION' } }), 'rechtschreibung');
  assert.equal(mapLtCategory({ id: 'DATIV_RULE', category: { id: 'GRAMMAR' } }), 'kasus');
  assert.equal(mapLtCategory({ id: 'WORTSTELLUNG_X', category: { id: 'GRAMMAR' } }), 'wortstellung');
  assert.equal(extractContextSentence('Eins. Zwei Fehler hier! Drei.', 11, 6), 'Zwei Fehler hier!');
  assert.equal(buildSuggestedCardTerm('Ich gehe in die Schule.', 12, 3, 'die'), 'die Schule');
});
