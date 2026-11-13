// Миграция 003: многопользовательская изоляция (A2, A3)
// Идемпотентна: каждый шаг проверяет текущее состояние через information_schema
// НИКАКИХ DROP/TRUNCATE на пользовательских данных
export const name = '003_multiuser';

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

/** Таблицы с user_id и их основные запросы (порядок важен для FK) */
const USER_OWNED_TABLES = [
  'cards',
  'card_state',
  'review_log',
  'sentences',
  'staging_cards',
  'settings',
  'daily_stats',
  'import_runs',
  'texts',
  'text_attempts',
  'translation_sets',
  'writing_tasks',
  'writing_attempts',
  'speaking_attempts',
  'number_attempts',
  'exam_log',
  'activities',
  // ai_usage уже имеет user_id в PK — обрабатывается отдельно
];

export async function up(conn, h) {
  // ---- Шаг 1: Дополняем таблицу users новыми колонками ----
  const usersColumns = [
    ['must_change_password', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['token_version',        'INT NOT NULL DEFAULT 0'],
    ['disabled',             'TINYINT(1) NOT NULL DEFAULT 0'],
    ['ai_mode',              "ENUM('shared','own','off') NOT NULL DEFAULT 'shared'"],
    ['last_login_at',        'DATETIME NULL'],
    ['last_active_day',      'DATE NULL'],
  ];
  for (const [col, ddl] of usersColumns) {
    await h.addColumnIfMissing('users', col, ddl);
  }

  // ---- Шаг 2: Определяем owner (первый admin или создаём из APP_PASSWORD) ----
  const [adminRows] = await conn.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1"
  );

  let ownerId;
  if (adminRows.length > 0) {
    ownerId = adminRows[0].id;
  } else {
    // Пробуем создать из APP_PASSWORD
    const appPassword = process.env.APP_PASSWORD;
    if (!appPassword) {
      throw new Error(
        'Нет администратора в таблице users и APP_PASSWORD не задан. ' +
        'Задайте APP_PASSWORD или создайте администратора через scripts/admin_cli.mjs.'
      );
    }
    const hash = await hashPassword(appPassword);
    // username 'owner' может конфликтовать — используем INSERT IGNORE
    const [ins] = await conn.query(
      "INSERT IGNORE INTO users (username, role, password_hash, must_change_password, token_version) VALUES ('owner', 'admin', ?, 1, 0)",
      [hash]
    );
    if (ins.insertId) {
      ownerId = ins.insertId;
    } else {
      // Уже был создан в предыдущем запуске
      const [ownerRows] = await conn.query("SELECT id FROM users WHERE username = 'owner' LIMIT 1");
      if (!ownerRows.length) throw new Error('Не удалось создать или найти пользователя owner');
      ownerId = ownerRows[0].id;
    }
  }

  // ---- Шаг 3: Для каждой user_owned таблицы добавляем user_id и мигрируем данные ----
  for (const table of USER_OWNED_TABLES) {
    const tableOk = await h.tableExists(table);
    if (!tableOk) continue; // таблица ещё не создана (свежая установка пойдёт через schema.sql)

    // 3a. Добавить user_id INT UNSIGNED NOT NULL DEFAULT 0 (если нет)
    const colExists = await h.columnExists(table, 'user_id');
    if (!colExists) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`user_id\` INT UNSIGNED NOT NULL DEFAULT 0`);
    }

    // 3b. Заполнить user_id = ownerId где user_id = 0
    await conn.query(`UPDATE \`${table}\` SET user_id = ? WHERE user_id = 0`, [ownerId]);

    // 3c. Снять DEFAULT 0 (колонка становится NOT NULL без default — ошибка при забытом INSERT)
    // Это MODIFY — только если default ещё есть
    const [colDefs] = await conn.query(
      'SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1',
      [table, 'user_id']
    );
    if (colDefs.length && colDefs[0].COLUMN_DEFAULT !== null) {
      await conn.query(`ALTER TABLE \`${table}\` MODIFY \`user_id\` INT UNSIGNED NOT NULL`);
    }
  }

  // ---- Шаг 4: ai_usage — добавить user_id в PK ----
  if (await h.tableExists('ai_usage')) {
    const pkCols = await h.primaryKeyColumns('ai_usage');
    if (!pkCols.includes('user_id')) {
      // Добавляем колонку user_id если нет
      await h.addColumnIfMissing('ai_usage', 'user_id', 'INT UNSIGNED NOT NULL DEFAULT 0');
      // Заполняем ownerId
      await conn.query('UPDATE ai_usage SET user_id = ? WHERE user_id = 0', [ownerId]);
      // Снимаем DEFAULT
      const [def] = await conn.query(
        'SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'ai_usage\' AND COLUMN_NAME=\'user_id\' LIMIT 1'
      );
      if (def.length && def[0].COLUMN_DEFAULT !== null) {
        await conn.query('ALTER TABLE ai_usage MODIFY user_id INT UNSIGNED NOT NULL');
      }
      // Меняем PK: DROP старый, ADD новый
      await conn.query('ALTER TABLE ai_usage DROP PRIMARY KEY, ADD PRIMARY KEY (day, user_id, provider, feature)');
    }
  }

  // ---- Шаг 5: Индексы и уникальные ключи (A2) ----

  // cards: заменить uq_dedupe -> uq_user_dedupe
  if (await h.indexExists('cards', 'uq_dedupe')) {
    // Сначала создаём новый, потом удаляем старый (чтобы не потерять целостность)
    await h.addIndexIfMissing('cards', 'uq_user_dedupe', 'UNIQUE KEY uq_user_dedupe (user_id, dedupe_key)');
    await h.dropIndexIfExists('cards', 'uq_dedupe');
  } else {
    await h.addIndexIfMissing('cards', 'uq_user_dedupe', 'UNIQUE KEY uq_user_dedupe (user_id, dedupe_key)');
  }
  await h.addIndexIfMissing('cards', 'idx_user_pos',     'KEY idx_user_pos (user_id, pos)');
  await h.addIndexIfMissing('cards', 'idx_user_topic',   'KEY idx_user_topic (user_id, topic)');
  await h.addIndexIfMissing('cards', 'idx_user_enriched','KEY idx_user_enriched (user_id, enriched)');

  // card_state: добавить индекс (user_id, due)
  await h.addIndexIfMissing('card_state', 'idx_user_due', 'KEY idx_user_due (user_id, due)');

  // review_log: заменить uq_uuid -> uq_user_uuid
  if (await h.indexExists('review_log', 'uq_uuid')) {
    await h.addIndexIfMissing('review_log', 'uq_user_uuid', 'UNIQUE KEY uq_user_uuid (user_id, client_uuid)');
    await h.dropIndexIfExists('review_log', 'uq_uuid');
  } else {
    await h.addIndexIfMissing('review_log', 'uq_user_uuid', 'UNIQUE KEY uq_user_uuid (user_id, client_uuid)');
  }
  await h.addIndexIfMissing('review_log', 'idx_user_day',  'KEY idx_user_day (user_id, local_day)');
  await h.addIndexIfMissing('review_log', 'idx_user_card', 'KEY idx_user_card (user_id, card_id, mode)');

  // staging_cards
  await h.addIndexIfMissing('staging_cards', 'idx_user_status', 'KEY idx_user_status (user_id, status)');
  await h.addIndexIfMissing('staging_cards', 'idx_user_dedupe', 'KEY idx_user_dedupe (user_id, dedupe_key)');

  // settings: PK меняем с (key_name) на (user_id, key_name)
  if (await h.tableExists('settings')) {
    const pkCols = await h.primaryKeyColumns('settings');
    if (!pkCols.includes('user_id') || pkCols.length === 1) {
      // Переименуем старый PK => сначала создаём уникальный составной, затем меняем PK
      try {
        await conn.query('ALTER TABLE settings DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, key_name)');
      } catch (err) {
        // Уже был изменён в предыдущем запуске
        if (!err?.message?.includes('PRIMARY')) throw err;
      }
    }
  }

  // daily_stats: PK меняем с (day) на (user_id, day)
  if (await h.tableExists('daily_stats')) {
    const pkCols = await h.primaryKeyColumns('daily_stats');
    if (!pkCols.includes('user_id') || pkCols.length === 1) {
      try {
        await conn.query('ALTER TABLE daily_stats DROP PRIMARY KEY, ADD PRIMARY KEY (user_id, day)');
      } catch (err) {
        if (!err?.message?.includes('PRIMARY')) throw err;
      }
    }
  }

  // texts
  await h.addIndexIfMissing('texts', 'idx_user_kind', 'KEY idx_user_kind (user_id, kind, created_at)');

  // activities
  await h.addIndexIfMissing('activities', 'idx_user_day_kind', 'KEY idx_user_day_kind (user_id, local_day, kind)');

  // number_attempts
  await h.addIndexIfMissing('number_attempts', 'idx_user_day',  'KEY idx_user_day (user_id, local_day)');
  await h.addIndexIfMissing('number_attempts', 'idx_user_cat',  'KEY idx_user_cat (user_id, category, local_day)');

  // exam_log
  await h.addIndexIfMissing('exam_log', 'idx_user_taken', 'KEY idx_user_taken (user_id, taken_on)');

  // translation_sets
  await h.addIndexIfMissing('translation_sets', 'idx_user_created', 'KEY idx_user_created (user_id, created_at)');

  // writing_attempts, speaking_attempts
  await h.addIndexIfMissing('writing_attempts',  'idx_user_day', 'KEY idx_user_day (user_id, local_day)');
  await h.addIndexIfMissing('speaking_attempts', 'idx_user_day', 'KEY idx_user_day (user_id, local_day)');

  // import_runs
  await h.addIndexIfMissing('import_runs', 'idx_user', 'KEY idx_user (user_id)');

  // sentences
  await h.addIndexIfMissing('sentences', 'idx_user_created', 'KEY idx_user_created (user_id, created_at)');

  // ---- Шаг 6: Создать user_keys ----
  if (!(await h.tableExists('user_keys'))) {
    await conn.query(`
      CREATE TABLE user_keys (
        user_id INT UNSIGNED NOT NULL,
        provider VARCHAR(20) NOT NULL,
        ciphertext VARBINARY(512) NOT NULL,
        iv VARBINARY(12) NOT NULL,
        tag VARBINARY(16) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, provider)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }
}

