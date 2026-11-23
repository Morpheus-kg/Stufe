// 010_tts_cache: глобальный кэш серверной нейросетевой озвучки (edge-tts) и колонка gap_exercises в texts
export const name = '010_tts_cache';

export async function up(conn, h) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS tts_cache (
      cache_key CHAR(64) PRIMARY KEY,
      voice VARCHAR(64) NOT NULL,
      mime VARCHAR(32) NOT NULL DEFAULT 'audio/mpeg',
      audio LONGBLOB NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_tts_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  if (await h.tableExists('texts')) {
    await h.addColumnIfMissing('texts', 'gap_exercises', 'LONGTEXT NULL');
  }
}

