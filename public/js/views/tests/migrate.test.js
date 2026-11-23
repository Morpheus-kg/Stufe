// Тесты миграций: порядок, идемпотентность, сохранность данных, блокировка (без реальной БД)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHelpers, migrate, splitSql } from '../server/migrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Имитация MySQL: таблицы как {колонки, число строк}; понимает нужные миграциям запросы */
class FakeDb {
  constructor(tables = {}, { lock = 1 } = {}) {
    this.tables = tables; this.log = []; this.applied = null; this.lock = lock; this.released = 0;
  }
  async getConnection() { const self = this; return { query: (s, p) => self.query(s, p), release() {} }; }
  async query(sql, params = []) {
    this.log.push(sql);
    if (/GET_LOCK/.test(sql)) return [[{ got: this.lock }], []];
    if (/RELEASE_LOCK/.test(sql)) { this.released += 1; return [[{ r: 1 }], []]; }
    if (/information_schema\.TABLES/.test(sql)) return [this.tables[params[0]] ? [{ ok: 1 }] : [], []];
    if (/information_schema\.COLUMNS/.test(sql)) return [this.tables[params[0]]?.cols.includes(params[1]) ? [{ ok: 1 }] : [], []];
    let m = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\)\s*ENGINE/.exec(sql);
    if (m) {
      if (m[1] === 'schema_migrations') this.applied ??= [];
      else if (!this.tables[m[1]]) {
        const cols = [...m[2].matchAll(/^\s*(\w+)\s+[A-Z]/gm)].map((x) => x[1]).filter((c) => !/^(KEY|UNIQUE|PRIMARY|CONSTRAINT)$/.test(c));
        this.tables[m[1]] = { cols, rows: 0 };
      }
      return [{}, []];
    }
    m = /^ALTER TABLE `(\w+)` ADD COLUMN `(\w+)`/.exec(sql);
    if (m) { this.tables[m[1]].cols.push(m[2]); return [{}, []]; }
    if (/^SELECT name FROM schema_migrations/.test(sql)) return [this.applied.map((name) => ({ name })), []];
    if (/^INSERT INTO schema_migrations/.test(sql)) { this.applied.push(params[0]); return [{}, []]; }
    throw new Error(`FakeDb: неожиданный запрос ${sql.slice(0, 60)}`);
  }
}

// Фейк «видит» CREATE только для таблиц из реальной schema.sql — поэтому создаём таблицы заранее для v1-базы
const v1Staging = () => ({ staging_cards: { cols: ['id', 'batch_id', 'term', 'reason', 'created_at'], rows: 5 }, cards: { cols: ['id'], rows: 300 } });

function tmpRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-mig-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const mig = (n, body = '') => `export const name = '${n}';\nexport async function up(c, h) { (globalThis.__mig ??= []).push('${n}'); ${body} }\n`;

describe('splitSql / schema.sql', () => {
  it('режет выражения и убирает комментарии', () => {
    assert.deepEqual(splitSql('-- c\nCREATE TABLE a (x INT);\nCREATE TABLE b (y INT);\n'), ['CREATE TABLE a (x INT)', 'CREATE TABLE b (y INT)']);
  });
  it('schema.sql содержит staging_cards.provider для чистой установки', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
    const stmt = splitSql(sql).find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS staging_cards'));
    assert.match(stmt, /\bprovider VARCHAR\(30\) NULL/);
  });
});

describe('помощники миграций', () => {
  it('columnExists / tableExists / addColumnIfMissing идемпотентны', async () => {
    const db = new FakeDb({ t: { cols: ['id'], rows: 1 } });
    const h = makeHelpers(db);
    assert.equal(await h.tableExists('t'), true);
    assert.equal(await h.tableExists('nope'), false);
    assert.equal(await h.columnExists('t', 'x'), false);
    assert.equal(await h.addColumnIfMissing('t', 'x', 'INT NULL'), true);
    assert.equal(await h.addColumnIfMissing('t', 'x', 'INT NULL'), false);
    assert.equal(db.log.filter((s) => s.startsWith('ALTER')).length, 1);
  });
  it('повторное добавление при гонке (ER_DUP_FIELDNAME) не падает', async () => {
    const db = { async query(sql) { if (/information_schema/.test(sql)) return [[], []]; throw Object.assign(new Error('dup'), { code: 'ER_DUP_FIELDNAME' }); } };
    assert.equal(await makeHelpers(db).addColumnIfMissing('t', 'x', 'INT NULL'), false);
  });
  it('мусорные идентификаторы и DDL отклоняются', async () => {
    const h = makeHelpers(new FakeDb({}));
    await assert.rejects(() => h.columnExists('a; DROP TABLE cards', 'x'));
    await assert.rejects(() => h.addColumnIfMissing('t', 'x', 'INT; DROP TABLE t'));
  });
});

describe('migrate', () => {
  it('старая v1-база: колонка добавлена, данные на месте, второй запуск ничего не меняет', async () => {
    const root = tmpRoot({
      'db/schema.sql': fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'),
      'server/migrations/001_staging_provider.js': fs.readFileSync(path.join(ROOT, 'server', 'migrations', '001_staging_provider.js'), 'utf8'),
    });
    const db = new FakeDb(v1Staging());
    const ran = await migrate(db, { rootDir: root });
    assert.deepEqual(ran, ['001_staging_provider']);
    assert.ok(db.tables.staging_cards.cols.includes('provider'));
    assert.equal(db.tables.staging_cards.rows, 5);
    assert.equal(db.tables.cards.rows, 300);
    assert.ok(!db.log.some((s) => /^\s*(DROP|DELETE|TRUNCATE)/i.test(s)));
    const alters = db.log.filter((s) => s.startsWith('ALTER')).length;
    assert.deepEqual(await migrate(db, { rootDir: root }), []);
    assert.equal(db.log.filter((s) => s.startsWith('ALTER')).length, alters);
    assert.equal(db.released, 2);
  });
  it('чистая установка: колонка уже в schema.sql, ALTER не нужен, миграция всё равно записана', async () => {
    const root = tmpRoot({
      'db/schema.sql': fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'),
      'server/migrations/001_staging_provider.js': fs.readFileSync(path.join(ROOT, 'server', 'migrations', '001_staging_provider.js'), 'utf8'),
    });
    const db = new FakeDb();
    assert.deepEqual(await migrate(db, { rootDir: root }), ['001_staging_provider']);
    assert.ok(db.tables.staging_cards.cols.includes('provider'));
    assert.equal(db.log.filter((s) => s.startsWith('ALTER')).length, 0);
    assert.deepEqual(db.applied, ['001_staging_provider']);
  });
  it('порядок: schema.sql, schema_v2.sql, миграции по имени; schema_v2 может отсутствовать', async () => {
    const files = {
      'db/schema.sql': 'CREATE TABLE IF NOT EXISTS a (\n  id INT\n) ENGINE=InnoDB;\n',
      'db/schema_v2.sql': 'CREATE TABLE IF NOT EXISTS b (\n  id INT\n) ENGINE=InnoDB;\n',
      'server/migrations/002_second.js': mig('002_second'),
      'server/migrations/001_first.js': mig('001_first'),
      'server/migrations/readme.txt': 'не миграция',
    };
    const root = tmpRoot(files);
    globalThis.__mig = [];
    const db = new FakeDb();
    await migrate(db, { rootDir: root });
    assert.deepEqual(globalThis.__mig, ['001_first', '002_second']);
    const creates = db.log.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS')).map((s) => /EXISTS (\w+)/.exec(s)[1]);
    assert.deepEqual(creates, ['a', 'b', 'schema_migrations']);

    const root2 = tmpRoot({ 'db/schema.sql': files['db/schema.sql'] });
    assert.deepEqual(await migrate(new FakeDb(), { rootDir: root2 }), []);
  });
  it('упавшая миграция не записывается, блокировка снимается, повтор её выполнит', async () => {
    const root = tmpRoot({
      'db/schema.sql': 'CREATE TABLE IF NOT EXISTS a (\n  id INT\n) ENGINE=InnoDB;\n',
      'server/migrations/001_bad.js': mig('001_bad', "throw new Error('boom');"),
    });
    const db = new FakeDb();
    await assert.rejects(() => migrate(db, { rootDir: root }), /boom/);
    assert.deepEqual(db.applied, []);
    assert.equal(db.released, 1);
  });
  it('нет блокировки -> ошибка, ничего не выполняется', async () => {
    const db = new FakeDb({}, { lock: 0 });
    await assert.rejects(() => migrate(db, { rootDir: ROOT }), /блокировк/);
    assert.ok(!db.log.some((s) => s.startsWith('CREATE')));
    assert.equal(db.released, 0);
  });
});