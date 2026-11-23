export const name = '004_text_glossary';

export async function up(conn, h) {
  if (!(await h.tableExists('texts'))) return;
  await h.addColumnIfMissing('texts', 'glossary', 'LONGTEXT NULL');
}

