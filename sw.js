/* Офлайн-режим и уведомления.
 * Кэшируем сам сайт, чтобы приложение открывалось без интернета.
 */
const VERSION = 'hz-hourly-v4';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'srs.js',
  'seed.js',
  'data/strokes.js',
  'recognize.js',
  'pinyin.js',
  'seed.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Сеть → кэш: так обновления приходят сразу, а офлайн работает из кэша.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});

// Клик по уведомлению — открываем приложение сразу на тренировке.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './?from=reminder';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) {
        const client = list[0];
        client.postMessage({ type: 'open-session' });
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ping') {
    event.source && event.source.postMessage({ type: 'pong' });
  }
});
