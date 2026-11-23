// Service worker: /js, /css, /shared — stale-while-revalidate; остальная статика — cache-first; /api — только сеть.
// ВАЖНО: при каждом деплое с изменениями в public/ или shared/ увеличивайте VERSION.
const VERSION = '7';
const CACHE_PREFIX = 'german-trainer-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

// Короткий список оболочки для первого офлайн-запуска; остальное кешируется по мере использования
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/app.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/js/app.js',
  '/js/api.js',
  '/js/api2.js',
  '/js/tts.js',
  '/js/services/audio_player.js',
  '/js/services/hands_free_matcher.js',
  '/js/services/hands_free_engine.js',
  '/js/services/sound_fx.js',
  '/js/services/wake_lock.js',
  '/js/offline.js',
  '/js/views/today.js',
  '/js/views/plan.js',
  '/js/views/review.js',
  '/js/views/login.js',
  '/shared/constants.js',
  '/shared/grading.js',
];

const SWR_PREFIXES = ['/js/', '/css/', '/shared/', '/audio/de/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Каждый файл отдельно: отсутствие одного не должно ломать установку
    await Promise.allSettled(PRECACHE_URLS.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (res.ok) await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const old = names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME);
    await Promise.all(old.map((n) => caches.delete(n)));
    await self.clients.claim();
    if (old.length) {
      // Сообщаем открытым вкладкам об обновлении
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'SW_UPDATED', version: VERSION });
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API и сам sw.js — только сеть (браузер обрабатывает по умолчанию)
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;
  if (SWR_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }
  event.respondWith(handleStatic(req));
});

const OFFLINE_RESPONSE = () => new Response('Нет сети', {
  status: 503,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
});

// Отдаём кеш сразу, в фоне обновляем (новая версия файла — при следующей загрузке)
async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req, { cache: 'no-cache' })
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  const res = await network;
  return res || OFFLINE_RESPONSE();
}

async function handleStatic(req) {
  const cache = await caches.open(CACHE_NAME);
  let hit = await cache.match(req, { ignoreSearch: true });
  // Навигация (SPA с hash-роутером): отдаём index.html
  if (!hit && req.mode === 'navigate') {
    hit = (await cache.match('/index.html')) || (await cache.match('/'));
  }
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return OFFLINE_RESPONSE();
  }
}