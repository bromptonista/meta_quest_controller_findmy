const CACHE_NAME = 'quest-controller-findmy-v1';
const ASSETS = [
  './',
  './index.html',
  './quest-pinger.html',
  './styles.css',
  './icon.svg',
  './manifest.webmanifest',
  './js/app.js',
  './js/math.js',
  './js/haptics.js',
  './js/audio.js',
  './js/hud-slate.js',
  './js/xr-renderer.js',
  './js/qr.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
