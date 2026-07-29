// Minimal PWA service worker: network-first for everything (state must be
// live truth — stale caches would lie); cache fallback only for the app shell
// when offline so the client can render its honest OFFLINE state.
const SHELL = ['/', '/js/app.js', '/js/store.js', '/js/voice/controller.js', '/js/voice/session-store.js',
  '/js/voice/capture.js', '/js/voice/stt.js', '/js/voice/tts.js', '/js/voice/orb.js', '/manifest.json'];
const CACHE = 'rabit-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // never cache API truth
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('/'))),
  );
});
