// 006_enrich_queue: счётчик попыток и время следующей попытки фонового обогащения карточек
export const name = '006_enrich_queue';

export async function up(conn, h) {
  if (!(await h.tableExists('cards'))) return;
  await h.addColumnIfMissing('cards', 'enrich_attempts', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');
  await h.addColumnIfMissing('cards', 'enrich_next_at', 'DATETIME NULL');
  await h.addIndexIfMissing('cards', 'idx_enrich_queue', 'KEY idx_enrich_queue (enriched, active, enrich_next_at)');
}

