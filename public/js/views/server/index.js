// Точка входа: миграции (server/migrate.js), автоподключение роутов, защита, статика
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { requireAuth, requirePasswordChanged } from './auth.js';
import { config } from './config.js';
import { getUserTz, tzStore } from './time.js';
import { startEnrichWorker, stopEnrichWorker } from './workers/enrich_worker.js';
import { pool } from './db.js';
import { ApiError, sendError } from './errors.js';
import { migrate } from './migrate.js';
import { query } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Ждём БД (на Railway она может подняться позже приложения) */
async function waitForDb(tries = 15, delayMs = 2000) {
  for (let i = 1; ; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`БД недоступна (${err?.code ?? err?.name}), попытка ${i}/${tries}`);
      await sleep(delayMs);
    }
  }
}

/** Проверить что существует хотя бы один admin, иначе сервер не стартует */
async function checkAdminExists() {
  try {
    const rows = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 LIMIT 1");
    if (Number(rows?.[0]?.n) === 0) {
      console.error(
        'ОШИБКА: Нет активного администратора в базе данных.\n' +
        'Создайте администратора: node scripts/admin_cli.mjs create-admin <username>\n' +
        'Или задайте APP_PASSWORD для автоматического создания при миграции.'
      );
      process.exit(1);
    }
  } catch {
    // Таблица users ещё не создана — OK, миграция создаст
  }
}

async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.isProd ? 1 : false); // за прокси Railway

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        upgradeInsecureRequests: config.isProd ? [] : null,
        mediaSrc: ["'self'", 'blob:', 'data:'],
      },
    },
  }));
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());

  // API: без кэша
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Публичные эндпоинты (без auth)
  const PUBLIC_PATHS = new Set(['/auth/login', '/auth/logout', '/health', '/ai/providers']);
  const isPublic = (path) => PUBLIC_PATHS.has(path) || path.startsWith('/health');

  // requireAuth для всех /api кроме публичных
  app.use('/api', (req, res, next) => {
    const p = req.path.replace(/\/+$/, '');
    if (isPublic(p)) return next();
    return requireAuth(req, res, next);
  });

  // Блокировка при must_change_password (кроме /auth/* и /me/password)
  app.use('/api', (req, res, next) => {
    const p = req.path.replace(/\/+$/, '');
    if (isPublic(p)) return next();
    return requirePasswordChanged(req, res, next);
  });

  // Персональная таймзона пользователя для localDay() в рамках запроса
  app.use('/api', (req, res, next) => {
    if (!req.user?.id) return next();
    getUserTz(req.user.id).then((tz) => tzStore.run(tz, next), () => next());
  });

  // Автоподключение: server/routes/*.js в алфавитном порядке
  const dir = path.join(ROOT, 'server', 'routes');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      if (typeof mod.mountPath !== 'string' || !mod.mountPath.startsWith('/api') || typeof mod.default !== 'function') {
        console.error(`[routes] ${f}: нет mountPath/default — пропущен`);
        continue;
      }
      app.use(mod.mountPath, mod.default);
    } catch (err) {
      console.error(`[routes] ${f}: ошибка загрузки (${err?.name}: ${err?.message})`);
    }
  }
  app.use('/api', (req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Не найдено')));

  // Статика: public/ и shared/ (sw.js, index.html, manifest не кэшируем жёстко)
  const staticOpts = {
    setHeaders(res, filePath) {
      if (/(?:sw\.js|index\.html|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  };
  app.use('/shared', express.static(path.join(ROOT, 'shared'), staticOpts));
  app.use(express.static(path.join(ROOT, 'public'), staticOpts));

  // Единый обработчик ошибок
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message, err.extra);
    if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'BAD_REQUEST', 'Некорректный JSON');
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'BAD_REQUEST', 'Слишком большой запрос (максимум 5 МБ)');
    if (err?.name === 'ZodError') return sendError(res, 400, 'BAD_REQUEST', 'Некорректные данные запроса');
    if (err?.code === 'ER_DUP_ENTRY') return sendError(res, 409, 'CONFLICT', 'Такая запись уже есть');
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
      return sendError(res, err.status, 'BAD_REQUEST', 'Некорректный запрос');
    }
    // В лог — только тип ошибки и путь, без SQL и пользовательского текста
    console.error(`[error] ${req.method} ${req.path} ${err?.name ?? 'Error'} ${err?.code ?? ''}`.trim());
    return sendError(res, 500, 'INTERNAL', 'Внутренняя ошибка сервера');
  });
  return app;
}

process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection] ${reason?.name ?? 'Error'} ${reason?.code ?? ''}`.trim());
});

async function main() {
  await waitForDb();
  const ran = await migrate(pool, { log: (msg) => console.log(msg) });
  if (ran.length) console.log(`Применены миграции: ${ran.join(', ')}`);
  // Проверяем наличие админа после миграции
  await checkAdminExists();
  const app = await createApp();
  const server = app.listen(config.port, () => console.log(`German Trainer слушает порт ${config.port}`));
  startEnrichWorker();
  const stop = () => {
    stopEnrichWorker();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

export { createApp, main };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Не удалось запустить сервер: ${err?.name}: ${err?.message}`);
    process.exit(1);
  });
}
