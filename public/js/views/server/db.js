// Пул MySQL и помощники. Работаем в UTC, даты приходят строками.
import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: 'UTF8MB4_UNICODE_CI',
  timezone: 'Z',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Каждое новое соединение — в UTC (чтобы CURRENT_TIMESTAMP тоже был UTC)
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'", () => {});
});

/** SQL-запрос -> строки (для INSERT/UPDATE — ResultSetHeader). undefined -> NULL */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params.map((p) => (p === undefined ? null : p)));
  return rows;
}

/**
 * Транзакция. conn — обычное соединение mysql2 (promise):
 * `const [rows] = await conn.query(sql, params)`.
 * Ошибка внутри fn -> rollback и повторный throw.
 */
export async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* соединение уже потеряно */ }
    throw err;
  } finally {
    conn.release();
  }
}