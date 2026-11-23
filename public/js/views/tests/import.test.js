// Тесты M1: ключ дедупликации, маппинг импорта, скобки, дубли, слияние, POST /cards (409)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../server/errors.js';
import { normalizeKey, splitArticle } from '../server/keys.js';
import { createCard, normalizeNewCard } from '../server/routes/cards.js';
import { prepareCards, saveCards } from '../server/routes/import.js';

/** Минимальная имитация соединения mysql2 для таблицы cards (в памяти) */
class FakeDb {
  constructor(rows = []) { this.rows = rows; this.nextId = rows.length + 1; this.updates = 0; }
  async query(sql, params = []) {
    if (/^SELECT id, dedupe_key, translation/.test(sql)) return [this.rows.map((r) => ({ ...r })), []];
    if (/^INSERT INTO cards .* VALUES \?$/.test(sql)) {
      const cols = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',').map((s) => s.trim());
      for (const vals of params[0]) this.rows.push({ id: this.nextId++, ...Object.fromEntries(cols.map((c, i) => [c, vals[i]])) });
      return [{ affectedRows: params[0].length }, []];
    }
    if (/^UPDATE cards SET/.test(sql)) {
      const cols = [...sql.matchAll(/`(\w+)` = \?/g)].map((m) => m[1]);
      const row = this.rows.find((r) => r.id === params[cols.length]);
      cols.forEach((c, i) => { row[c] = params[i]; });
      this.updates += 1;
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`FakeDb: неожиданный запрос ${sql}`);
  }
}

describe('normalizeKey / splitArticle', () => {
  it('регистр, пробелы, пунктуация, NFC', () => {
    assert.equal(normalizeKey(null, '  Der   TISCH. '), 'der tisch');
    assert.equal(normalizeKey('der', 'Tisch'), 'der tisch');
    assert.equal(normalizeKey(null, '„Hallo“!'), 'hallo');
    assert.equal(normalizeKey(null, 'Ä'.normalize('NFD')), normalizeKey(null, 'Ä'.normalize('NFC')));
    assert.equal(normalizeKey('der', '...'), '');
  });
  it('splitArticle', () => {
    assert.deepEqual(splitArticle('die Armut'), { article: 'die', term: 'Armut' });
    assert.deepEqual(splitArticle('laufen'), { article: null, term: 'laufen' });
    assert.deepEqual(splitArticle('die'), { article: null, term: 'die' });
  });
});

describe('маппинг импорта', () => {
  const one = (raw) => prepareCards([raw]).prepared.map((p) => p.card);

  it('старый формат: артикль отделяется, pos=noun, enriched=0', () => {
    const [c] = one({ term: 'der Tisch', translation: 'стол', example: 'Der Tisch ist groß.', example_translation: 'Стол большой.', type: 'word' });
    assert.equal(c.term, 'Tisch');
    assert.equal(c.article, 'der');
    assert.equal(c.pos, 'noun');
    assert.equal(c.enriched, 0);
    assert.equal(c.dedupe_key, 'der tisch');
  });
  it('type idiom -> pos idiom, артикль не отделяется', () => {
    const [c] = one({ term: 'der Apfel fällt nicht weit vom Stamm', translation: 'яблоко от яблони', type: 'idiom' });
    assert.equal(c.pos, 'idiom');
    assert.equal(c.article, null);
  });
  it('слово/фраза без артикля -> phrase; странный type не ломает', () => {
    assert.equal(one({ term: 'sich erinnern', translation: 'вспоминать', type: 'word' })[0].pos, 'phrase');
    assert.equal(one({ term: 'in Kraft treten', translation: 'вступать в силу', type: 42 })[0].pos, 'phrase');
  });
  it('новый формат принимается как есть', () => {
    const [c] = one({ term: 'Tisch', article: 'DER', plural: 'Tische', pos: 'noun', translation: 'стол', level: 'C1', topic: 'Alltag', enriched: true });
    assert.equal(c.article, 'der');
    assert.equal(c.plural, 'Tische');
    assert.equal(c.level, 'C1');
    assert.equal(c.topic, 'Alltag');
    assert.equal(c.enriched, 1);
  });
  it('скобки с оборотом -> ДВЕ карточки с одним примером', () => {
    const { prepared } = prepareCards([{ term: 'die Armut (in Armut aufwachsen)', translation: 'бедность', example: 'Er wuchs in Armut auf.', example_translation: 'Он рос в бедности.' }]);
    assert.equal(prepared.length, 2);
    const [word, phrase] = prepared.map((p) => p.card);
    assert.equal(word.term, 'Armut');
    assert.equal(word.article, 'die');
    assert.equal(word.pos, 'noun');
    assert.equal(phrase.term, 'in Armut aufwachsen');
    assert.equal(phrase.pos, 'phrase');
    assert.equal(phrase.article, null);
    assert.equal(phrase.example, word.example);
    assert.equal(phrase.example_translation, word.example_translation);
  });
  it('скобки с грамматикой не делятся', () => {
    const { prepared } = prepareCards([{ term: 'laufen (lief, ist gelaufen)', translation: 'бежать' }]);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].card.term, 'laufen (lief, ist gelaufen)');
  });
  it('split=false (восстановление) скобки не трогает', () => {
    const { prepared } = prepareCards([{ term: 'die Armut (in Armut aufwachsen)', translation: 'бедность' }], { split: false });
    assert.equal(prepared.length, 1);
  });
  it('мусор и пустые поля -> flagged, не падает', () => {
    const items = [null, 'строка', 42, [], {}, { term: '', translation: 'x' }, { term: 'a', translation: 'длинный' },
      { term: 'Haus', translation: '' }, { term: '...', translation: 'точки' }, { term: 'x'.repeat(300), translation: 'длинный термин' },
      { term: 'Haus', translation: 'дом' }];
    const { prepared, flagged } = prepareCards(items);
    assert.equal(prepared.length, 1);
    assert.equal(flagged, items.length - 1);
  });
});

describe('дедупликация и слияние', () => {
  it('дубль в одном запросе сливается, а не вставляется', async () => {
    const db = new FakeDb();
    const { prepared } = prepareCards([
      { term: 'der Tisch', translation: 'стол' },
      { term: 'Der  tisch.', translation: 'стол', example: 'Der Tisch ist groß.' },
    ]);
    const r = await saveCards(db, prepared);
    assert.deepEqual(r, { added: 1, merged: 1 });
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].example, 'Der Tisch ist groß.'); // пустое поле заполнено при слиянии
  });
  it('повторный импорт: added=0, merged>0, ничего не затирается', async () => {
    const db = new FakeDb();
    const items = [
      { term: 'der Tisch', translation: 'стол', example: 'Der Tisch ist groß.' },
      { term: 'die Armut (in Armut aufwachsen)', translation: 'бедность', example: 'Er wuchs in Armut auf.' },
    ];
    const first = await saveCards(db, prepareCards(items).prepared);
    assert.equal(first.added, 3);
    assert.equal(first.merged, 0);
    const second = await saveCards(db, prepareCards(items).prepared);
    assert.equal(second.added, 0);
    assert.equal(second.merged, 3);
    assert.equal(db.rows.length, 3);
    assert.equal(db.updates, 0);
  });
  it('слияние заполняет только пустые поля существующей карточки', async () => {
    const db = new FakeDb([{
      id: 1, dedupe_key: 'der tisch', translation: 'стол', plural: null, grammar: '',
      example: 'Мой пример', example_translation: null, example_cloze: null, cloze_answer: null, source: null,
    }]);
    const { prepared } = prepareCards([{
      term: 'Tisch', article: 'der', translation: 'другой перевод', plural: 'Tische', grammar: 'm.',
      example: 'Чужой пример', example_translation: 'Перевод', example_cloze: '____ ist groß.', cloze_answer: 'Der Tisch',
    }]);
    const r = await saveCards(db, prepared);
    assert.deepEqual(r, { added: 0, merged: 1 });
    const row = db.rows[0];
    assert.equal(row.translation, 'стол');
    assert.equal(row.example, 'Мой пример');
    assert.equal(row.plural, 'Tische');
    assert.equal(row.grammar, 'm.');
    assert.equal(row.example_translation, 'Перевод');
    assert.equal(row.example_cloze, null); // пример другой — cloze не подмешиваем
  });
});

describe('POST /cards: createCard', () => {
  it('дубликат активной карточки -> 409 CONFLICT с existing_id', async () => {
    const db = { async query(sql) {
      if (/^SELECT id, active FROM cards WHERE dedupe_key/.test(sql)) return [[{ id: 7, active: 1 }], []];
      throw new Error(`лишний запрос: ${sql}`);
    } };
    await assert.rejects(
      () => createCard(db, { term: 'Tisch', article: 'der', translation: 'стол' }),
      (err) => err instanceof ApiError && err.status === 409 && err.code === 'CONFLICT' && err.extra.existing_id === 7,
    );
  });
  it('артикль в term при том же ключе тоже даёт 409', async () => {
    const seen = [];
    const db = { async query(sql, p) { seen.push(p); return [[{ id: 3, active: 1 }], []]; } };
    await assert.rejects(() => createCard(db, { term: 'der Tisch', translation: 'стол' }), (e) => e.status === 409);
    assert.equal(seen[0][0], 'der tisch');
  });
  it('нормализация новой карточки и флаг enriched', () => {
    const a = normalizeNewCard({ term: 'die Armut', translation: 'бедность' });
    assert.equal(a.term, 'Armut');
    assert.equal(a.article, 'die');
    assert.equal(a.pos, 'noun');
    assert.equal(a.enriched, 0);
    const b = normalizeNewCard({ term: 'Armut', translation: 'бедность', article: 'die', plural: 'Armuten', pos: 'noun', grammar: 'f.', level: 'B2', topic: 'Gesellschaft' });
    assert.equal(b.enriched, 1);
    const c = normalizeNewCard({ term: 'Armut', translation: 'бедность', article: 'die', plural: 'Armuten', pos: 'noun', grammar: 'f.', level: 'B2', topic: 'Gesellschaft', example: 'Sie lebt in Armut.' });
    assert.equal(c.enriched, 0); // cloze отправить нельзя -> пусть обогатится
  });
  it('card1.json: article="null", check=true -> check_flag=1 и автогенерация example_cloze', () => {
    const { prepared } = prepareCards([{
      id: 29,
      term: 'die Armut',
      article: 'null',
      translation: 'бедность',
      example: 'Viele Menschen leben in Armut.',
      example_translation: 'Многие люди живут в бедности.',
      type: 'word',
      check: true,
    }]);
    assert.equal(prepared.length, 1);
    const card = prepared[0].card;
    assert.equal(card.article, 'die');
    assert.equal(card.term, 'Armut');
    assert.equal(card.pos, 'noun');
    assert.equal(card.check_flag, 1);
    assert.equal(card.example_cloze, 'Viele Menschen leben in ____.');
    assert.equal(card.cloze_answer, 'Armut');
  });
});