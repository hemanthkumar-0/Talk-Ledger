const CACHE_NAME = 'voice-khata-shell-v5';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app',
  '/app.html',
  '/privacy',
  '/terms',
  '/contact',
  '/vendor/supabase.js',
  '/css/tokens.css',
  '/css/lather.css',
  '/css/landing.css',
  '/css/app.css',
  '/css/reports.css',
  '/css/auth.css',
  '/pnl.js',
  '/voice-fields.js',
  '/db.js',
  '/locales/en.json',
  '/locales/hi.json',
  '/locales/kn.json',
  '/locales/ta.json',
  '/locales/ur.json',
  '/locales/voice-keywords.js',
  '/src/i18n.js',
  '/src/theme.js',
  '/src/signal-bg.js',
  '/src/landing.js',
  '/src/parser.js',
  '/src/vault.js',
  '/src/audio.js',
  '/src/voice.js',
  '/src/reports.js',
  '/src/auth-scene.js',
  '/src/auth.js',
  '/src/app.js',
  '/icons/favicon.svg',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws/') ||
    url.pathname.startsWith('/manifest')
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
