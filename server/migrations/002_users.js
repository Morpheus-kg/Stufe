// v2: мультипользователи — таблица users + роли
export const name = '002_users';

export async function up(conn, h) {
  if (await h.tableExists('users')) return; // уже есть
  await conn.query(`
    CREATE TABLE users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

