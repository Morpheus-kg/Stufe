// 007_cards_rektion_examples: управление глаголов/прилагательных (rektion) и пул контекстных примеров (examples_json)
export const name = '007_cards_rektion_examples';

export async function up(conn, h) {
  if (!(await h.tableExists('cards'))) return;
  await h.addColumnIfMissing('cards', 'rektion', 'VARCHAR(100) NULL AFTER grammar');
  await h.addColumnIfMissing('cards', 'examples_json', 'LONGTEXT NULL AFTER cloze_answer');
}

