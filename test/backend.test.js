// Security checks in the Apps Script backend, run in Node with small stand-ins for
// the Apps Script services they touch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TOKEN = 'a'.repeat(64);
const ctx = {
  console: { log() {}, warn() {}, error() {} },
  Utilities: {
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
    newBlob: (bytes, type, name) => ({ bytes, type, name }),
  },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'APP_TOKEN' ? TOKEN : null) }) },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
  },
};
vm.createContext(ctx);
for (const f of ['src/Code.js', 'src/stats.js', 'src/parse.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
}
const post = (obj) => JSON.parse(ctx.doPost({ postData: { contents: typeof obj === 'string' ? obj : JSON.stringify(obj) } }).text);

test('requests without the right token are refused, revealing nothing', () => {
  for (const body of [{}, { token: 'nope', action: 'status' }, { token: TOKEN.slice(1), action: 'status' },
    { token: TOKEN + 'a', action: 'status' }, 'not json', '']) {
    assert.deepStrictEqual(post(body), { ok: false, error: 'unauthorized' });
  }
});

test('unknown action does not echo input back', () => {
  assert.deepStrictEqual(post({ token: TOKEN, action: '<script>' }), { ok: false, error: 'unknown action' });
});

test('constant-time compare', () => {
  assert.strictEqual(ctx.safeEquals_('abc', 'abc'), true);
  assert.strictEqual(ctx.safeEquals_('abd', 'abc'), false);
  assert.strictEqual(ctx.safeEquals_('ab', 'abc'), false);
  assert.strictEqual(ctx.safeEquals_('abcd', 'abc'), false);
});

test('GET reveals nothing', () => {
  assert.strictEqual(ctx.doGet().text, '');
});

test('text that would run as a formula is neutralized', () => {
  for (const evil of ['=IMPORTXML("https://evil.example","//a")', '+1+1', '-2', '@SUM(A1)', '\t=1', '\r=1']) {
    assert.ok(ctx.safeText_(evil).startsWith("'"), evil);
  }
  assert.strictEqual(ctx.safeText_('Shell on 5th'), 'Shell on 5th');
  assert.strictEqual(ctx.safeText_('a\u0000b'), 'ab');
});

test('entry validation', () => {
  const good = { id: 'abc-12345', date: Date.now(), odometer: 50000, gallons: 12, total: 42, full: true, notes: 'x' };
  const e = ctx.validateEntry_(good);
  assert.strictEqual(e.price, 3.5);
  assert.strictEqual(ctx.validateEntry_({ ...good, notes: 'n'.repeat(5000) }).notes.length, 500);

  const bad = [
    null, 'string', {},
    { ...good, odometer: -5 }, { ...good, odometer: 9e9 }, { ...good, gallons: 0 }, { ...good, gallons: 1e6 },
    { ...good, total: 1e9 }, { ...good, price_per_gallon: 999 },
    { ...good, date: 'garbage' }, { ...good, date: Date.now() + 30 * 864e5 }, { ...good, date: 0 },
    { ...good, id: '=HYPERLINK("x")' }, { ...good, id: 'short' }, { ...good, id: 'x'.repeat(100) },
  ];
  for (const b of bad) assert.throws(() => ctx.validateEntry_(b), JSON.stringify(b));
});

test('photos: only real JPEG/PNG/WebP of reasonable size', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString('base64');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]).toString('base64');
  const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
  assert.strictEqual(ctx.decodeDataUrl_('data:image/jpeg;base64,' + jpeg).mimeType, 'image/jpeg');
  assert.strictEqual(ctx.decodeDataUrl_('data:image/png;base64,' + png).mimeType, 'image/png');
  assert.strictEqual(ctx.decodeDataUrl_(null), null);
  for (const bad of [
    'data:text/html;base64,' + html,           // wrong type
    'data:image/jpeg;base64,' + html,          // lies about its type
    'data:image/svg+xml;base64,' + html,       // SVG can carry script
    'data:image/png;base64,' + jpeg,           // mismatched signature
    'data:image/jpeg;base64,' + 'A'.repeat(12 * 1024 * 1024), // too big
    'javascript:alert(1)', 42,
  ]) {
    assert.throws(() => ctx.decodeDataUrl_(bad), String(bad).slice(0, 40));
  }
});

test('manifest asks only for narrow scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(manifest.oauthScopes.sort(), [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/spreadsheets.currentonly',
  ]);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // ignore comments
  for (const broad of ['DriveApp.', 'DocumentApp.', 'openById', 'openByUrl', 'GmailApp', 'CalendarApp']) {
    assert.ok(!code.includes(broad), `${broad} would need a broader scope`);
  }
});
