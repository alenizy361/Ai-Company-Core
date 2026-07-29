// SIRA service worker: network-first with app-shell fallback. API truth is
// NEVER cached. Old caches (including the previous product's) are deleted on
// activate so a rebranded shell can't be pinned by a stale cache.
const CACHE = 'sira-shell-v1';
const SHELL = [
  '/', '/manifest.json',
  '/css/tokens.css', '/css/base.css', '/css/layout.css', '/css/components.css', '/css/network.css', '/css/motion.css',
  '/js/app.js',
  '/js/i18n/en.js', '/js/i18n/ar.js', '/js/i18n/i18n.js', '/js/i18n/bidi.js',
  '/js/core/dom.js', '/js/core/prefs.js', '/js/core/sse.js', '/js/core/store.js', '/js/core/conversation.js', '/js/core/core-state.js',
  '/js/a11y/announcer.js', '/js/a11y/focus.js', '/js/a11y/keys.js',
  '/js/ui/shell.js', '/js/ui/chat.js', '/js/ui/activity.js', '/js/ui/cards.js', '/js/ui/cards-rank.js', '/js/ui/palette.js', '/js/ui/inspector.js',
  '/js/network/layout.js', '/js/network/graph.js', '/js/network/pulses.js',
  '/js/sira/core.js',
  '/js/voice/controller.js', '/js/voice/session-store.js', '/js/voice/capture.js',
  '/js/voice/stt.js', '/js/voice/tts.js', '/js/voice/providers-ext.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // never cache API truth
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      const cache = await caches.open(CACHE);
      cache.put(e.request, fresh.clone());
      return fresh;
    } catch {
      return (await caches.match(e.request)) ?? (await caches.match('/'));
    }
  })());
});
