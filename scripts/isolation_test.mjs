// scripts/isolation_test.mjs
// Сквозной интеграционный тест изоляции данных (CONTRACT v3 Часть A)
// Запуск: $env:MYSQLDATABASE='german_trainer_test'; node scripts/isolation_test.mjs

import assert from 'node:assert/strict';
import { pool, query, tx } from '../server/db.js';
import { migrate } from '../server/migrate.js';
import { createApp } from '../server/index.js';
import { hashPassword, issueToken } from '../server/auth.js';
import { config } from '../server/config.js';

// ЖЁСТКОЕ ОГРАНИЧЕНИЕ: база данных обязана заканчиваться на _test
const dbName = process.env.MYSQLDATABASE || config.db.database || '';
if (!dbName.endsWith('_test')) {
  console.error(`[SECURITY ERROR] scripts/isolation_test.mjs отказывается запускаться: база данных "${dbName}" не заканчивается на "_test"!`);
  process.exit(1);
}

console.log(`[isolation_test] Запуск на базе данных: ${dbName}`);

async function run() {
  // 1. Применяем миграции к тестовой базе
  await migrate(pool, { log: () => {} });

  // 2. Запускаем Express сервер на случайном свободном порту
  const app = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };

  const req = async (path, options = {}) => {
    const url = `${baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, { ...options, headers });
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  };

  try {
    // 3. Очищаем тестовых пользователей
    await query("DELETE FROM users WHERE username LIKE 'iso_test_%'");

    // 4. Создаём тестовых пользователей:
    // admin, userA, userB
    const adminHash = await hashPassword('AdminPass123!');
    const userAHash = await hashPassword('UserAPass123!');
    const userBHash = await hashPassword('UserBPass123!');

    const resAdmin = await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('iso_test_admin', ?, 'admin', 0)",
      [adminHash],
    );
    const adminId = resAdmin.insertId;

    const resA = await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('iso_test_a', ?, 'user', 0)",
      [userAHash],
    );
    const userAId = resA.insertId;

    const resB = await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('iso_test_b', ?, 'user', 0)",
      [userBHash],
    );
    const userBId = resB.insertId;

    const tokenAdmin = issueToken(adminId, 0, 'admin');
    const tokenA = issueToken(userAId, 0, 'user');
    const tokenB = issueToken(userBId, 0, 'user');

    const authAdmin = { Authorization: `Bearer ${tokenAdmin}` };
    const authA = { Authorization: `Bearer ${tokenA}` };
    const authB = { Authorization: `Bearer ${tokenB}` };

    console.log('[1/12] Тест входа по логину и паролю...');
    const loginOk = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'iso_test_a', password: 'UserAPass123!' }),
    });
    assert.equal(loginOk.status, 200);
    assert.equal(loginOk.body.username, 'iso_test_a');
    const cookieA = loginOk.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookieA && (cookieA.startsWith('sid=') || cookieA.startsWith('gt_session=')));

    // Вход по APP_PASSWORD должен отвергаться
    if (config.appPassword) {
      const loginAppPass = await req('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'iso_test_a', password: config.appPassword }),
      });
      if (config.appPassword !== 'UserAPass123!') {
        assert.equal(loginAppPass.status, 401);
      }
    }

    console.log('[2/12] Наполнение данных пользователя A во всех доменах...');
    // Cards
    const cardRes = await req('/api/cards', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ term: 'Hund', article: 'der', translation: 'собака', pos: 'noun' }),
    });
    assert.ok(cardRes.status === 200 || cardRes.status === 201);
    const cardAId = cardRes.body.id;
    assert.ok(cardAId > 0);

    // Reviews & Card state (с уникальным client_uuid)
    const reviewUuid = 'iso-uuid-review-001';
    const revRes = await req('/api/reviews', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({
        reviews: [{
          card_id: cardAId,
          mode: 'ru_de',
          rating: 3,
          client_uuid: reviewUuid,
          reviewed_at: new Date().toISOString(),
          duration_ms: 2500,
        }],
      }),
    });
    assert.equal(revRes.status, 200);

    // Прямое добавление слов (бывший staging): дубль у A не блокирует B
    const fromLookupA = await req('/api/cards/from-lookup', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({ word: 'Katze', lemma: 'Katze', article: 'die', pos: 'noun', translation_ru: 'кошка' }),
    });
    assert.equal(fromLookupA.status, 201);

    // Texts
    const textRes = await req('/api/texts', {
      method: 'POST',
      headers: authA,
      body: JSON.stringify({
        title: 'Text A',
        body: 'Ein Hund und eine Katze leben zusammen in einem sehr schönen Haus.',
        kind: 'reading',
        level: 'B2',
        topic: 'Tiere',
        questions: [{ type: 'tf', text: 'Text A?', options: ['Richtig', 'Falsch'], answer: 0 }],
      }),
    });
    assert.ok(textRes.status === 200 || textRes.status === 201);
    const textAId = textRes.body.id;

    // Activities
    await query(
      "INSERT INTO activities (user_id, kind, local_day, seconds, score) VALUES (?, 'cards', CURDATE(), 120, 100)",
      [userAId],
    );

    // Number attempt
    await query(
      "INSERT INTO number_attempts (user_id, category, level, expected, answer, correct, local_day) VALUES (?, 'cardinal', 1, '5', '5', 1, CURDATE())",
      [userAId],
    );

    // Exam log
    await query(
      "INSERT INTO exam_log (user_id, taken_on, skill, points) VALUES (?, CURDATE(), 'gesamt', 85)",
      [userAId],
    );

    // Translation set
    await query(
      "INSERT INTO translation_sets (user_id, kind, items) VALUES (?, 'ru_de', '[]')",
      [userAId],
    );

    // Settings
    await req('/api/settings', {
      method: 'PUT',
      headers: authA,
      body: JSON.stringify({ difficulty: 'hard', plan_minutes: 50 }),
    });

    console.log('[3/12] Проверка полной изоляции: пользователь B видит только пустые списки...');
    const bCards = await req('/api/cards', { headers: authB });
    assert.equal(bCards.status, 200);
    assert.equal(bCards.body.items.length, 0);

    const bTexts = await req('/api/texts', { headers: authB });
    assert.equal(bTexts.status, 200);
    assert.equal(bTexts.body.items.length, 0);

    const bPlan = await req('/api/plan/today', { headers: authB });
    assert.equal(bPlan.status, 200);
    assert.equal(bPlan.body.done_tasks, 0);

    const bSkills = await req('/api/skills/summary', { headers: authB });
    assert.equal(bSkills.status, 200);

    const bStats = await req('/api/stats/summary', { headers: authB });
    assert.equal(bStats.status, 200);
    assert.equal(bStats.body.cards.total, 0);

    const bExport = await req('/api/export', { headers: authB });
    assert.equal(bExport.status, 200);
    assert.equal(bExport.body.cards.length, 0);

    const bSettings = await req('/api/settings', { headers: authB });
    assert.equal(bSettings.status, 200);
    assert.equal(bSettings.body.difficulty, 'medium'); // дефолт, а не 'hard' у A

    console.log('[4/12] Пользователь B получает 404 на любые ID пользователя A...');
    const bGetCardA = await req(`/api/cards/${cardAId}`, { headers: authB });
    assert.equal(bGetCardA.status, 404);

    const bPatchCardA = await req(`/api/cards/${cardAId}`, {
      method: 'PATCH',
      headers: authB,
      body: JSON.stringify({ translation: 'чужое' }),
    });
    assert.equal(bPatchCardA.status, 404);

    const bDeleteCardA = await req(`/api/cards/${cardAId}`, {
      method: 'DELETE',
      headers: authB,
    });
    assert.equal(bDeleteCardA.status, 404);

    const bGetTextA = await req(`/api/texts/${textAId}`, { headers: authB });
    assert.equal(bGetTextA.status, 404);

    const bUndoA = await req('/api/cards/undo-batch', {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({ batch_id: 'lookup-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') }),
    });
    assert.equal(bUndoA.status, 200);
    assert.equal(bUndoA.body.deleted, 0);

    console.log('[5/12] Дедупликация per-user: B может добавить точно такое же слово без конфликта с A...');
    const bCreateCard = await req('/api/cards', {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({ term: 'Hund', article: 'der', translation: 'собака', pos: 'noun' }),
    });
    assert.ok(bCreateCard.status === 200 || bCreateCard.status === 201);
    const cardBId = bCreateCard.body.id;
    assert.notEqual(cardBId, cardAId);

    // Но для самого B повторное добавление даёт 409
    const bDupCard = await req('/api/cards', {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({ term: 'Hund', article: 'der', translation: 'пёс', pos: 'noun' }),
    });
    assert.equal(bDupCard.status, 409);

    console.log('[6/12] Повторное использование client_uuid: B может использовать тот же UUID, что и A...');
    const bRevRes = await req('/api/reviews', {
      method: 'POST',
      headers: authB,
      body: JSON.stringify({
        reviews: [{
          card_id: cardBId,
          mode: 'ru_de',
          rating: 4,
          client_uuid: reviewUuid, // тот же UUID!
          reviewed_at: new Date().toISOString(),
          duration_ms: 1800,
        }],
      }),
    });
    assert.equal(bRevRes.status, 200);

    console.log('[7/12] Отключение пользователя (disabled=1) моментально даёт 401...');
    const disRes = await req(`/api/admin/users/${userBId}`, {
      method: 'PUT',
      headers: authAdmin,
      body: JSON.stringify({ disabled: 1 }),
    });
    assert.equal(disRes.status, 200);
    const bDisabled = await req('/api/cards', { headers: authB });
    assert.equal(bDisabled.status, 401);

    // Включаем обратно
    const enRes = await req(`/api/admin/users/${userBId}`, {
      method: 'PUT',
      headers: authAdmin,
      body: JSON.stringify({ disabled: 0 }),
    });
    assert.equal(enRes.status, 200);

    // Логинимся заново после ре-активации
    const bReLogin = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'iso_test_b', password: 'UserBPass123!' }),
    });
    assert.equal(bReLogin.status, 200);
    const cookieBActive = bReLogin.headers.get('set-cookie')?.split(';')[0];
    const authBActive = { Cookie: cookieBActive };

    console.log('[8/12] Смена пароля и устаревание старых токенов...');
    const changePass = await req('/api/me/password', {
      method: 'PUT',
      headers: authBActive,
      body: JSON.stringify({ current_password: 'UserBPass123!', new_password: 'UserBNewPass456!' }),
    });
    assert.equal(changePass.status, 204);
    // Предыдущий токен/сессия B теперь недействителен (token_version изменился при смене пароля)
    const bOldToken = await req('/api/cards', { headers: authBActive });
    assert.equal(bOldToken.status, 401);

    // Вход с новым паролем успешен
    const bNewLogin = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'iso_test_b', password: 'UserBNewPass456!' }),
    });
    assert.equal(bNewLogin.status, 200);
    const cookieBNew = bNewLogin.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookieBNew && (cookieBNew.startsWith('sid=') || cookieBNew.startsWith('gt_session=')));
    const authBNew = { Cookie: cookieBNew };

    console.log('[9/12] Обязательная смена пароля (must_change_password) блокирует роуты...');
    const resC = await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('iso_test_c', ?, 'user', 1)",
      [await hashPassword('TempPass123!')],
    );
    const userCId = resC.insertId;
    const tokenC = issueToken(userCId, 0, 'user');
    const authC = { Authorization: `Bearer ${tokenC}` };

    const cBlocked = await req('/api/cards', { headers: authC });
    assert.equal(cBlocked.status, 403);
    assert.equal(cBlocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');

    // /api/me/password разрешён
    const cPassOk = await req('/api/me/password', {
      method: 'PUT',
      headers: authC,
      body: JSON.stringify({ current_password: 'TempPass123!', new_password: 'PermPass456!' }),
    });
    assert.equal(cPassOk.status, 204);

    // Новый вход разблокирован
    const newLoginC = await req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'iso_test_c', password: 'PermPass456!' }),
    });
    assert.equal(newLoginC.status, 200);
    const cookieCNew = newLoginC.headers.get('set-cookie')?.split(';')[0];
    const cUnblocked = await req('/api/cards', { headers: { Cookie: cookieCNew } });
    assert.equal(cUnblocked.status, 200);
    assert.equal(cUnblocked.status, 200);

    console.log('[10/12] Разжалованный админ теряет доступ к /api/admin...');
    const resD = await query(
      "INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('iso_test_d', ?, 'admin', 0)",
      [await hashPassword('AdminDPass123!')],
    );
    const userDId = resD.insertId;
    const tokenD = issueToken(userDId, 0, 'admin');
    const authD = { Authorization: `Bearer ${tokenD}` };

    const dAdminOk = await req('/api/admin/users', { headers: authD });
    assert.equal(dAdminOk.status, 200);

    // Разжалуем D до user
    await query("UPDATE users SET role = 'user' WHERE id = ?", [userDId]);
    const dAdminRevoked = await req('/api/admin/users', { headers: authD });
    assert.equal(dAdminRevoked.status, 403);

    console.log('[11/12] Защита последнего админа и самого себя...');
    // Админ не может удалить самого себя
    const delSelf = await req(`/api/admin/users/${adminId}`, {
      method: 'DELETE',
      headers: authAdmin,
      body: JSON.stringify({ confirm_username: 'iso_test_admin' }),
    });
    assert.ok(delSelf.status === 400 || delSelf.status === 409);

    // Админ не может отключить самого себя
    const disableSelf = await req(`/api/admin/users/${adminId}`, {
      method: 'PUT',
      headers: authAdmin,
      body: JSON.stringify({ disabled: 1 }),
    });
    assert.ok(disableSelf.status === 400 || disableSelf.status === 409);

    console.log('[12/12] Каскадное удаление пользователя A удаляет ТОЛЬКО его данные, не трогая B...');
    const delA = await req(`/api/admin/users/${userAId}`, {
      method: 'DELETE',
      headers: authAdmin,
      body: JSON.stringify({ confirm_username: 'iso_test_a' }),
    });
    assert.equal(delA.status, 200);

    // Проверяем, что у A удалились все карточки
    const checkACards = await query('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?', [userAId]);
    assert.equal(Number(checkACards[0].c), 0);

    // А у B карточка осталась на месте!
    const checkBCards = await query('SELECT COUNT(*) AS c FROM cards WHERE user_id = ?', [userBId]);
    assert.equal(Number(checkBCards[0].c), 1);

    // И B может продолжать читать свою карточку
    const bReadOwn = await req('/api/cards', { headers: authBNew });
    assert.equal(bReadOwn.status, 200);
    assert.equal(bReadOwn.body.items.length, 1);
    assert.equal(bReadOwn.body.items[0].id, cardBId);

    console.log('----------------------------------------------------');
    console.log('УСПЕХ! Все 12 проверок изоляции успешно пройдены!');
    console.log('----------------------------------------------------');
  } finally {
    // Чистим тестовых пользователей
    try {
      await query("DELETE FROM users WHERE username LIKE 'iso_test_%'");
    } catch {}
    await cleanup();
  }
}

run().catch((err) => {
  console.error('[isolation_test FAILED]:', err);
  process.exit(1);
});
