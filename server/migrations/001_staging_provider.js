// v2: какой провайдер ИИ создал карточку в staging
export const name = '001_staging_provider';

export async function up(conn, h) {
  if (!(await h.tableExists('staging_cards'))) return; // таблицу создаст schema.sql
  await h.addColumnIfMissing('staging_cards', 'provider', 'VARCHAR(30) NULL');
}