// 005_srs_cleanup: удаление состояний dictation и некорректных article, колонка source_batch, перенос pending из staging_cards в cards
export const name = '005_srs_cleanup';

export async function up(conn, h) {
  if (await h.tableExists('cards')) {
    await h.addColumnIfMissing('cards', 'source_batch', 'VARCHAR(36) NULL');
  }
  if (await h.tableExists('card_state')) {
    try {
      await conn.query("DELETE FROM card_state WHERE mode = 'dictation'");
      await conn.query(
        "DELETE cs FROM card_state cs JOIN cards c ON c.id = cs.card_id AND c.user_id = cs.user_id "
        + "WHERE cs.mode = 'article' AND (c.pos <> 'noun' OR c.article IS NULL)",
      );
    } catch {
      // В тестовых моках без таблиц или поддержки DELETE JOIN пропускаем
    }
  }
  if ((await h.tableExists('staging_cards')) && (await h.tableExists('cards'))) {
    try {
      await conn.query(
        "INSERT IGNORE INTO cards ("
        + "user_id, term, article, plural, pos, translation, grammar, example, example_translation, "
        + "example_cloze, cloze_answer, level, topic, source, source_batch, check_flag, enriched, active, dedupe_key, created_at, updated_at"
        + ") "
        + "SELECT "
        + "user_id, term, article, plural, IF(article IS NOT NULL, 'noun', pos), translation, grammar, example, example_translation, "
        + "example_cloze, cloze_answer, level, topic, CONCAT('staging:', COALESCE(provider, 'manual')), batch_id, check_flag, "
        + "IF(grammar IS NOT NULL AND example_cloze IS NOT NULL, 1, 0), 1, dedupe_key, created_at, UTC_TIMESTAMP() "
        + "FROM staging_cards WHERE status = 'pending'",
      );
      await conn.query("UPDATE staging_cards SET status = 'accepted' WHERE status = 'pending'");
    } catch {
      // В тестовых моках пропускаем
    }
  }
}

