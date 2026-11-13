// 009_error_profile: профиль типичных грамматических ошибок пользователя (из Письма, Пересказа, Карточек)
export const name = '009_error_profile';

export async function up(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS user_error_profile (
      user_id INT UNSIGNED NOT NULL,
      category VARCHAR(40) NOT NULL,
      hits INT UNSIGNED NOT NULL DEFAULT 1,
      last_example VARCHAR(500) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category),
      KEY idx_error_profile_hits (user_id, hits)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

