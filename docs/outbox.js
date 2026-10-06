/**
 * Offline storage and syncing, shared by the page (app.js) and the service worker
 * (sw.js, for Background Sync). IndexedDB holds:
 *   outbox  entries waiting to be sent to the sheet, keyed by entry id
 *   kv      config {api, token}, history (recent entries from the sheet), provider
 */
var DB_NAME = 'gas-log';

function openDb_() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore('outbox', { keyPath: 'id' });
      req.result.createObjectStore('kv');
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function withStore_(name, mode, fn) {
  return openDb_().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(name, mode);
      var result = fn(tx.objectStore(name));
      tx.oncomplete = function () { resolve(result && 'result' in result ? result.result : result); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function kvGet(key) { return withStore_('kv', 'readonly', function (s) { return s.get(key); }); }
function kvSet(key, value) { return withStore_('kv', 'readwrite', function (s) { s.put(value, key); }); }
function outboxAll() { return withStore_('outbox', 'readonly', function (s) { return s.getAll(); }); }
function outboxPut(entry) { return withStore_('outbox', 'readwrite', function (s) { s.put(entry); }); }
function outboxDelete(id) { return withStore_('outbox', 'readwrite', function (s) { s.delete(id); }); }

/**
 * Calls the Apps Script API. text/plain keeps it a "simple" request, so the browser
 * skips the CORS preflight that Apps Script can't answer.
 */
function callApi(action, payload) {
  return kvGet('config').then(function (cfg) {
    if (!cfg || !cfg.api || !cfg.token) throw apiError_('not-configured', false);
    var body = Object.assign({ token: cfg.token, action: action }, payload || {});
    return fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw apiError_('HTTP ' + res.status, false);
      return res.json();
    }, function () {
      throw apiError_('offline', false);
    }).then(function (json) {
      if (!json.ok) throw apiError_(json.error || 'unknown error', true);
      return json;
    });
  });
}

function apiError_(message, fromServer) {
  var e = new Error(message);
  e.fromServer = fromServer;
  return e;
}

var syncing_ = null;

/**
 * Sends queued entries oldest first. Stops at the first network problem (try again
 * later); an entry the server rejects keeps its error and is skipped so it can't
 * block the rest. The server ignores IDs it already has, so retries are safe.
 */
function syncOutbox() {
  if (syncing_) return syncing_;
  syncing_ = outboxAll().then(function (items) {
    items.sort(function (a, b) { return a.createdAt - b.createdAt; });
    var synced = 0;
    var chain = Promise.resolve(true);
    items.forEach(function (item) {
      chain = chain.then(function (keepGoing) {
        if (!keepGoing) return false;
        return callApi('save', { entry: item }).then(function () {
          synced++;
          return outboxDelete(item.id).then(function () { return true; });
        }, function (err) {
          if (err.fromServer && err.message !== 'unauthorized') {
            item.lastError = err.message;
            return outboxPut(item).then(function () { return true; });
          }
          return false;
        });
      });
    });
    return chain.then(function () { return outboxAll(); }).then(function (left) {
      return { synced: synced, remaining: left.length, errors: left.filter(function (i) { return i.lastError; }) };
    });
  }).finally(function () { syncing_ = null; });
  return syncing_;
}
