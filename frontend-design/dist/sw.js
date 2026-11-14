const CACHE = 'svoi-vladik-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/polish.css', '/glass.css', '/motion.css', '/motion.js', '/mascot.css', '/mascot.js', '/app.js', '/manifest.webmanifest', '/assets/lighthouse.svg', '/assets/icon-192.png', '/assets/icon-512.png', '/assets/museum.svg', '/assets/theatre.svg', '/assets/funicular.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('svoi-vladik-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // API, геопозиция и ответы квестов никогда не попадают в Cache Storage.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !(SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/mascot/'))) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(() => caches.match(event.request)));
});
