#!/usr/bin/env node
// scripts/admin_cli.mjs — управление пользователями из командной строки
// Использование:
//   node scripts/admin_cli.mjs create-admin <username>
//   node scripts/admin_cli.mjs reset-password <username>
// Работает только с базой, указанной в переменных окружения (или в .env)
// ВНИМАНИЕ: Не выводит в лог пароли или ключи.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

// Загрузка .env если есть
if (process.env.NODE_ENV !== 'production') {
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ quiet: true });
  } catch { /* нет dotenv */ }
}

const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

/** Генерировать временный пароль: 12 символов из неоднозначного алфавита */
function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** Ввод пароля без echo (если readline поддерживает) */
async function promptPassword(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getDb() {
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({
    host: process.env.MYSQLHOST || 'localhost',
    port: Number(process.env.MYSQLPORT) || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD ?? '',
    database: process.env.MYSQLDATABASE || 'german_trainer',
    charset: 'UTF8MB4_UNICODE_CI',
    timezone: 'Z',
  });
  return pool;
}

function validateUsername(raw) {
  if (typeof raw !== 'string') return null;
  const u = raw.toLowerCase().trim();
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(u) ? u : null;
}

const [,, cmd, arg1] = process.argv;

if (!cmd) {
  console.log('Использование:');
  console.log('  node scripts/admin_cli.mjs create-admin <username>');
  console.log('  node scripts/admin_cli.mjs reset-password <username>');
  process.exit(1);
}

const pool = await getDb();

try {
  if (cmd === 'create-admin') {
    const username = validateUsername(arg1);
    if (!username) {
      console.error('ОШИБКА: Неверный username. Только строчные буквы, цифры, _, -, . Длина 3-32.');
      process.exit(1);
    }

    // Проверить что пользователь не существует
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length) {
      console.error(`ОШИБКА: Пользователь '${username}' уже существует. Используйте reset-password.`);
      process.exit(1);
    }

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);

    const [result] = await pool.query(
      "INSERT INTO users (username, role, password_hash, must_change_password, token_version) VALUES (?, 'admin', ?, 1, 0)",
      [username, hash],
    );

    console.log(`\nАдминистратор создан:`);
    console.log(`  Логин:    ${username}`);
    console.log(`  Пароль:   ${tempPassword}  ← сохраните, показывается один раз`);
    console.log(`  ID:       ${result.insertId}`);
    console.log(`\nПри первом входе потребуется смена пароля.\n`);

  } else if (cmd === 'reset-password') {
    const username = validateUsername(arg1);
    if (!username) {
      console.error('ОШИБКА: Неверный username.');
      process.exit(1);
    }

    const [rows] = await pool.query('SELECT id, role FROM users WHERE username = ? LIMIT 1', [username]);
    if (!rows.length) {
      console.error(`ОШИБКА: Пользователь '${username}' не найден.`);
      process.exit(1);
    }
    const user = rows[0];

    const tempPassword = generateTempPassword();
    const hash = await hashPassword(tempPassword);
    const newVersion = (Math.floor(Math.random() * 1000000) + 1) % 2147483647;

    await pool.query(
      'UPDATE users SET password_hash = ?, must_change_password = 1, token_version = ? WHERE id = ?',
      [hash, newVersion, user.id],
    );

    console.log(`\nПароль сброшен для пользователя '${username}':`);
    console.log(`  Временный пароль: ${tempPassword}  ← сохраните, показывается один раз`);
    console.log(`  Роль: ${user.role}`);
    console.log(`\nВсе активные сессии будут аннулированы.\n`);

  } else {
    console.error(`Неизвестная команда: ${cmd}`);
    process.exit(1);
  }
} finally {
  await pool.end();
}

