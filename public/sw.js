// Service worker for the installable app.
// It only keeps the page design and an offline page. Agreements, PDFs and everything under /api/ always
// come straight from the server and are never stored on the device.
const CACHE = 'esign-shell-v2';
const SHELL = ['/offline.html', '/offline.js', '/style.css', '/logo.png', '/icons/icon-192.png', '/icons/favicon-32.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Confidential or live data: never cached, never intercepted.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/t/') || url.pathname.endsWith('.pdf') || url.pathname === '/ca.cer') return;

  if (req.mode === 'navigate') {
    // Pages: always fresh from the server; show the offline page if it can't be reached.
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    // Design files: fresh when online, cached copy when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
