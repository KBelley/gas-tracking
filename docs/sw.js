// Service worker: keeps the app available offline and syncs queued entries in
// the background (Chrome's Background Sync) when the connection comes back.
importScripts('outbox.js');

var CACHE = 'gas-log-v1';
var ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'outbox.js', 'shared/parse.js', 'shared/stats.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Same-origin GETs: answer from the cache right away and refresh it in the
// background, so the app opens instantly and picks up updates on the next launch.
// API calls go to script.google.com and are never touched here.
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var key = req.mode === 'navigate' ? 'index.html' : req;
  event.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key, { ignoreSearch: true }).then(function (hit) {
      var refresh = fetch(req).then(function (res) {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      if (hit) {
        event.waitUntil(refresh.catch(function () {}));
        return hit;
      }
      return refresh;
    });
  }));
});

self.addEventListener('sync', function (event) {
  if (event.tag !== 'outbox') return;
  event.waitUntil(syncOutbox().then(function (result) {
    return self.clients.matchAll().then(function (clients) {
      clients.forEach(function (c) { c.postMessage({ type: 'synced', result: result }); });
      // Failing the event tells Chrome to retry later, if entries are still waiting
      // for a connection (not just ones the server rejected).
      if (result.remaining > result.errors.length) throw new Error('still offline');
    });
  }));
});
