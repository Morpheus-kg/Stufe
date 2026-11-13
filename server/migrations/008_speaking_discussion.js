// 008_speaking_discussion: таблица диалоговых сессий (Sprechen — Diskussion)
export const name = '008_speaking_discussion';

export async function up(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS speaking_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      topic VARCHAR(120) NOT NULL,
      level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
      persona VARCHAR(255) NOT NULL,
      target_card_ids TEXT NULL,
      turns_json LONGTEXT NOT NULL,
      feedback_json LONGTEXT NULL,
      score SMALLINT NULL,
      status ENUM('active','finished') NOT NULL DEFAULT 'active',
      local_day CHAR(10) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_speaking_sessions_user (user_id, local_day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

