// Миграции при старте: schema.sql -> schema_v2.sql (если есть) -> server/migrations/NNN_name.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_NAME = 'german_trainer_migrate';
const IDENT_RE = /^[A-Za-z0-9_]+$/;
const FILE_RE = /^\d{3}_[A-Za-z0-9_]+\.js$/;

/** Текст SQL -> отдельные выражения (комментарии `--` убираются) */
export function splitSql(sql) {
  return String(sql)
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ident(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) throw new Error('Недопустимое имя таблицы/колонки');
  return name;
}

/**
 * Помощники для миграций (MySQL 8 и MariaDB: через information_schema, без IF NOT EXISTS).
 * @param {{query: Function}} conn соединение mysql2
 */
export function makeHelpers(conn) {
  const h = {
    async tableExists(table) {
      const [rows] = await conn.query(
        'SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1', [ident(table)]);
      return rows.length > 0;
    },
    async columnExists(table, col) {
      const [rows] = await conn.query(
        'SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
        [ident(table), ident(col)]);
      return rows.length > 0;
    },
    /** ddl — например 'VARCHAR(30) NULL'. Возвращает true, если колонка добавлена сейчас */
    async addColumnIfMissing(table, col, ddl) {
      if (typeof ddl !== 'string' || /[;`]|--/.test(ddl)) throw new Error('Недопустимый DDL колонки');
      if (await h.columnExists(table, col)) return false;
      try {
        await conn.query(`ALTER TABLE \`${ident(table)}\` ADD COLUMN \`${ident(col)}\` ${ddl}`);
      } catch (err) {
        if (err?.code === 'ER_DUP_FIELDNAME') return false; // параллельный запуск уже добавил
        throw err;
      }
      return true;
    },

    // --- Новые хелперы A3 ---

    /** Проверяет наличие индекса по имени */
    async indexExists(table, indexName) {
      const [rows] = await conn.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
        [ident(table), indexName]);
      return rows.length > 0;
    },

    /** Удаляет индекс если он существует (кроме PRIMARY) */
    async dropIndexIfExists(table, indexName) {
      if (indexName === 'PRIMARY') return false;
      if (!(await h.indexExists(table, indexName))) return false;
      try {
        await conn.query(`ALTER TABLE \`${ident(table)}\` DROP INDEX \`${indexName}\``);
      } catch (err) {
        if (err?.code === 'ER_CANT_DROP_FIELD_OR_KEY') return false;
        throw err;
      }
      return true;
    },

    /** Добавляет индекс если его нет */
    async addIndexIfMissing(table, indexName, colsDdl) {
      if (await h.indexExists(table, indexName)) return false;
      try {
        await conn.query(`ALTER TABLE \`${ident(table)}\` ADD ${colsDdl}`);
      } catch (err) {
        if (err?.code === 'ER_DUP_KEYNAME') return false;
        throw err;
      }
      return true;
    },

    /** Возвращает массив имён колонок первичного ключа */
    async primaryKeyColumns(table) {
      const [rows] = await conn.query(
        'SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? ORDER BY ORDINAL_POSITION',
        [ident(table), 'PRIMARY']);
      return rows.map((r) => r.COLUMN_NAME);
    },

    /**
     * Меняет первичный ключ таблицы (DROP + ADD).
     * ВНИМАНИЕ: MySQL не позволяет DROP PRIMARY KEY если есть AUTO_INCREMENT на нём — обработай заранее.
     */
    async setPrimaryKey(table, cols) {
      // Снять AUTO_INCREMENT если он на текущем PK
      const pkCols = await h.primaryKeyColumns(table);
      for (const col of pkCols) {
        const [colDef] = await conn.query(
          'SELECT COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
          [ident(table), col]);
        if (colDef.length && colDef[0].EXTRA && colDef[0].EXTRA.includes('auto_increment')) {
          await conn.query(`ALTER TABLE \`${ident(table)}\` MODIFY \`${col}\` ${colDef[0].COLUMN_TYPE} NOT NULL`);
        }
      }
      const colList = cols.map((c) => `\`${c}\``).join(', ');
      await conn.query(`ALTER TABLE \`${ident(table)}\` DROP PRIMARY KEY, ADD PRIMARY KEY (${colList})`);
    },
  };
  return h;
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function loadMigrations(dir) {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const list = [];
  for (const f of files.filter((x) => FILE_RE.test(x)).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    if (typeof mod.up !== 'function') throw new Error(`Миграция ${f}: нет функции up`);
    const name = typeof mod.name === 'string' && mod.name ? mod.name.slice(0, 100) : f.replace(/\.js$/, '');
    if (list.some((m) => m.name === name)) throw new Error(`Миграция ${f}: имя ${name} уже занято`);
    list.push({ name, up: mod.up });
  }
  return list;
}

/**
 * Запускает все миграции. Безопасно повторять: применённые пропускаются.
 * Параллельные запуски (два инстанса) разводятся через GET_LOCK.
 * @param {{getConnection: Function}} pool пул mysql2/promise
 * @param {{rootDir?: string, log?: Function}} [opts]
 * @returns {Promise<string[]>} имена миграций, применённых в этом запуске
 */
export async function migrate(pool, { rootDir = ROOT, log = () => {} } = {}) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [lock] = await conn.query('SELECT GET_LOCK(?, 60) AS got', [LOCK_NAME]);
    if (Number(lock?.[0]?.got) !== 1) throw new Error('Не удалось получить блокировку миграций');
    locked = true;

    // 1) базовая схема и схема v2 (она может отсутствовать)
    for (const file of ['schema.sql', 'schema_v2.sql']) {
      const sql = await readOptional(path.join(rootDir, 'db', file));
      if (sql === null) {
        if (file === 'schema.sql') throw new Error('Нет db/schema.sql');
        continue;
      }
      for (const stmt of splitSql(sql)) await conn.query(stmt);
    }

    // 2) пронумерованные миграции
    await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations ('
      + 'name VARCHAR(100) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP'
      + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    const [done] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(done.map((r) => r.name));
    const h = makeHelpers(conn);
    const ran = [];
    for (const m of await loadMigrations(path.join(rootDir, 'server', 'migrations'))) {
      if (applied.has(m.name)) continue;
      await m.up(conn, h); // DDL не откатывается, поэтому миграции идемпотентны
      await conn.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, UTC_TIMESTAMP())', [m.name]);
      ran.push(m.name);
      log(`миграция ${m.name} применена`);
    }
    return ran;
  } finally {
    if (locked) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch { /* соединение потеряно */ }
    }
    conn.release();
  }
}
