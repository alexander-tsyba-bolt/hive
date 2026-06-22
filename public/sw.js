// Bump this whenever the install list changes to force a fresh activate + purge.
const CACHE = 'hive-v4';
const STATIC = [
  '/', '/index.html', '/manifest.json', '/icon.svg',
  '/xterm.css', '/xterm.js', '/xterm-addon-fit.js', '/xterm-addon-web-links.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { pathname } = new URL(e.request.url);
  // Never cache API calls or WebSocket upgrades — always hit the server.
  if (pathname.startsWith('/api/') || pathname.startsWith('/ws')) return;

  // App shell (HTML): NETWORK-FIRST so frontend updates appear immediately. This
  // is a localhost tool, so the server is essentially always reachable; the cache
  // is only an offline fallback. Cache-first here is what froze the old UI.
  const isShell = e.request.mode === 'navigate' || pathname === '/' || pathname === '/index.html';
  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (xterm bundle, icons): stale-while-revalidate — serve cache
  // instantly but refresh it in the background so updates land on the next load.
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          return r;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
