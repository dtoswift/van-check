/*
 * Lets the van check open with no signal once it has been opened once.
 * Network first, so changes to questions.js reach phones straight away;
 * the saved copy is only used when there's no connection.
 * Bump VERSION if you ever need to force every phone to drop its saved copy.
 */
const VERSION = 'van-check-v1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'questions.js', 'logo.jpg', 'jspdf.umd.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
