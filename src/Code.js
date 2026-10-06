/**
 * Gas Tracker backend: a small JSON API that the phone app (docs/, hosted on
 * GitHub Pages) calls to save fill-ups to this spreadsheet and read photos.
 * Shared helpers parse.js (OCR/speech parsing) and stats.js (MPG math) are copied
 * in from shared/ by `npm run sync`.
 *
 * Script Properties (Project Settings → Script Properties):
 *   APP_TOKEN          secret the phone app sends with every request (made by setup())
 *   PROVIDER           ocr | gemini | claude   photo reader (default: ocr)
 *   GEMINI_API_KEY     only needed for PROVIDER=gemini
 *   GEMINI_MODEL       optional, defaults to GEMINI_DEFAULT_MODEL
 *   ANTHROPIC_API_KEY  only needed for PROVIDER=claude
 *   SPREADSHEET_ID, FOLDER_ID  written by setup()
 */

var APP_URL = 'https://kbelley.github.io/gas-tracking/';
var SHEET_NAME = 'Fill-ups';
var SUMMARY_NAME = 'Summary';
var FOLDER_NAME = 'Gas Tracker Photos';
var HEADERS = ['Date', 'Odometer', 'Gallons', '$/gal', 'Total', 'Full?', 'Miles',
  'MPG', '$/mile', 'Odometer photo', 'Pump photo', 'Notes', 'ID'];
var COL = { date: 1, odometer: 2, gallons: 3, price: 4, total: 5, full: 6, miles: 7,
  mpg: 8, perMile: 9, odoPhoto: 10, pumpPhoto: 11, notes: 12, id: 13 };
var HISTORY_SIZE = 30; // recent entries sent to the phone for offline MPG

var CLAUDE_MODEL = 'claude-sonnet-5-5';
var GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
var PROVIDER_LABELS = { ocr: 'OCR', gemini: 'Gemini', claude: 'Claude' };

var VISION_PROMPT =
  'You are reading photos taken at a gas station to log a fill-up.\n' +
  'The odometer photo shows a car dashboard. Report the ODOMETER total (not trip A/B, ' +
  'range, temperature or the clock) as a whole number.\n' +
  'The pump photo shows a fuel pump display. Report the gallons pumped, the price per ' +
  'gallon, and the total sale in dollars.\n' +
  'Return numbers only. Use null for any value you cannot read with confidence, or whose ' +
  'photo was not provided. Do not guess or calculate values that are not visible.';

// ---------------------------------------------------------------------------
// JSON API. The phone app POSTs {token, action, ...} as text/plain (which avoids
// a CORS preflight that Apps Script can't answer) and gets {ok, ...} back.
// ---------------------------------------------------------------------------

function doGet() {
  return json_({ ok: true, app: 'gas-tracker', message: 'API is running. Use the phone app.' });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var token = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
    if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });

    switch (req.action) {
      case 'status': return json_({ ok: true, status: getStatus() });
      case 'extract': return json_({ ok: true, reading: extract(req.photos) });
      case 'save': return json_({ ok: true, result: saveEntry(req.entry) });
      default: return json_({ ok: false, error: 'unknown action: ' + req.action });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: err.message });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Which reader is active, plus recent entries so the phone can work out MPG offline. */
function getStatus() {
  var entries = [];
  try {
    entries = readEntries_(fillupsSheet_());
  } catch (e) {
    // Not set up yet: return an empty history.
  }
  entries.sort(function (a, b) { return a.odometer - b.odometer; });
  return {
    provider: PROVIDER_LABELS[provider_()] || provider_(),
    history: entries.slice(-HISTORY_SIZE).map(function (e) {
      return {
        date: e.date instanceof Date ? e.date.getTime() : null,
        odometer: e.odometer, gallons: e.gallons, total: e.total, full: e.full,
      };
    }),
  };
}

/**
 * Reads the photos with the configured provider, falling back to OCR if an AI
 * provider fails. Never throws: worst case it returns blank fields with a message.
 * @param {{odometer: ?string, pump: ?string}} photos data: URLs from the phone
 */
function extract(photos) {
  var images = {
    odometer: decodeDataUrl_(photos && photos.odometer),
    pump: decodeDataUrl_(photos && photos.pump),
  };
  var chosen = provider_();
  var result;
  var notice = null;

  if (chosen !== 'ocr') {
    try {
      result = chosen === 'claude' ? extractWithClaude_(images) : extractWithGemini_(images);
      result.readBy = PROVIDER_LABELS[chosen];
    } catch (e) {
      notice = PROVIDER_LABELS[chosen] + ' failed (' + e.message + '), so OCR was used instead.';
      console.warn(notice);
    }
  }
  if (!result) {
    try {
      result = extractWithOcr_(images);
      result.readBy = 'OCR';
    } catch (e) {
      notice = (notice ? notice + ' ' : '') + 'OCR also failed (' + e.message +
        '). Please type the numbers in.';
      result = emptyReading_();
      result.readBy = 'none';
    }
  }
  result.notice = notice;
  return result;
}

/**
 * Saves a confirmed fill-up and returns the computed miles/MPG. Entries carry an ID
 * from the phone, and an ID that is already in the sheet is not saved again, so the
 * phone can safely retry a sync that timed out.
 * @param {Object} entry {id, date (ms), odometer, gallons, price_per_gallon, total, full,
 *     notes, photos: {odometer, pump}}
 */
function saveEntry(entry) {
  if (!entry) throw new Error('Missing entry.');
  var odometer = toNumber_(entry.odometer);
  var gallons = toNumber_(entry.gallons);
  if (odometer == null || gallons == null) {
    throw new Error('Odometer and gallons are required.');
  }
  var price = toNumber_(entry.price_per_gallon);
  var total = toNumber_(entry.total);
  if (total == null && price != null) total = Math.round(gallons * price * 100) / 100;
  if (price == null && total != null) price = Math.round(total / gallons * 1000) / 1000;
  var full = entry.full !== false;
  var date = entry.date ? new Date(entry.date) : new Date();

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = fillupsSheet_();
    if (entry.id && idExists_(sheet, String(entry.id))) {
      return { duplicate: true, miles: '', mpg: '', perMile: '' };
    }
    var entries = readEntries_(sheet);
    var stats = computeStats_(entries, odometer, gallons, total, full);

    var stamp = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
    var odoLink = savePhoto_(entry.photos && entry.photos.odometer, stamp + ' odometer');
    var pumpLink = savePhoto_(entry.photos && entry.photos.pump, stamp + ' pump');

    var row = [date, odometer, gallons, price, total, full, stats.miles, stats.mpg,
      stats.perMile, odoLink, pumpLink, entry.notes || '', entry.id || ''];
    sheet.appendRow(row);
    var rowIndex = sheet.getLastRow();
    sheet.getRange(rowIndex, COL.full).insertCheckboxes().setValue(full);

    // An entry older than existing ones changes the MPG of the fills after it.
    var isLatest = entries.every(function (e) { return e.odometer < odometer; });
    if (isLatest) sortByOdometer_(sheet);
    else recalculateAll();
    return stats;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// One-time setup (run from the editor)
// ---------------------------------------------------------------------------

function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Run setup() from the Apps Script project bound to your sheet.');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('PROVIDER')) props.setProperty('PROVIDER', 'ocr');

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    var first = ss.getSheets()[0];
    sheet = first.getLastRow() === 0 ? first.setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd h:mm am/pm');
  sheet.getRange('B2:B').setNumberFormat('#,##0');
  sheet.getRange('C2:C').setNumberFormat('0.000');
  sheet.getRange('D2:D').setNumberFormat('$0.000');
  sheet.getRange('E2:E').setNumberFormat('$#,##0.00');
  sheet.getRange('G2:G').setNumberFormat('#,##0');
  sheet.getRange('H2:H').setNumberFormat('0.0');
  sheet.getRange('I2:I').setNumberFormat('$0.000');

  setupSummary_(ss);

  if (!props.getProperty('FOLDER_ID') || !folderExists_(props.getProperty('FOLDER_ID'))) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder(FOLDER_NAME).getId());
  }
  if (!props.getProperty('APP_TOKEN')) {
    props.setProperty('APP_TOKEN', Utilities.getUuid().replace(/-/g, '') +
      Utilities.getUuid().replace(/-/g, ''));
  }
  console.log('Setup done. Photo reader: ' + props.getProperty('PROVIDER') + '.\n' +
    'Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone),\n' +
    'then run phoneSetupLink() and open the link it prints on your phone.');
}

/**
 * Prints the one-time link that connects the phone app to this script. Run it after
 * deploying. If it can't find the deployment URL, paste the Web app URL (ends in
 * /exec) into a Script Property named EXEC_URL and run it again.
 */
function phoneSetupLink() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('APP_TOKEN');
  if (!token) throw new Error('Run setup() first.');
  var execUrl = props.getProperty('EXEC_URL') || ScriptApp.getService().getUrl() || '';
  if (!/\/exec$/.test(execUrl)) {
    throw new Error('No /exec deployment URL found (got "' + execUrl + '"). Deploy as a ' +
      'Web app, then add its URL as Script Property EXEC_URL and run this again.');
  }
  var link = APP_URL + '#api=' + encodeURIComponent(execUrl) + '&token=' + token;
  console.log('Open this on your phone (keep it private, it contains your token):\n' + link);
  return link;
}

/** Makes a new token; the old phone link stops working. Run phoneSetupLink() after. */
function rotateToken() {
  PropertiesService.getScriptProperties().setProperty('APP_TOKEN',
    Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  console.log('Token changed. Run phoneSetupLink() and open the new link on your phone.');
}

function setupSummary_(ss) {
  var sheet = ss.getSheetByName(SUMMARY_NAME) || ss.insertSheet(SUMMARY_NAME);
  var f = "'" + SHEET_NAME + "'!";
  var rows = [
    ['Fill-ups', '=COUNT(' + f + 'B2:B)'],
    ['Miles tracked', '=IFERROR(MAX(' + f + 'B2:B)-MIN(' + f + 'B2:B),0)'],
    ['Total spent', '=SUM(' + f + 'E2:E)'],
    ['Total gallons', '=SUM(' + f + 'C2:C)'],
    ['Average $/gal', '=IFERROR(SUM(' + f + 'E2:E)/SUM(' + f + 'C2:C),"")'],
    ['Average MPG', '=IFERROR(AVERAGE(' + f + 'H2:H),"")'],
    ['Best MPG', '=IFERROR(MAX(' + f + 'H2:H),"")'],
    ['Worst MPG', '=IFERROR(MIN(' + f + 'H2:H),"")'],
    ['Spent last 30 days', '=SUMIFS(' + f + 'E2:E,' + f + 'A2:A,">="&(TODAY()-30))'],
  ];
  sheet.clear();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  sheet.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  sheet.getRange('B3').setNumberFormat('$#,##0.00');
  sheet.getRange('B4').setNumberFormat('0.0');
  sheet.getRange('B5').setNumberFormat('$0.000');
  sheet.getRange('B6:B8').setNumberFormat('0.0');
  sheet.getRange('B9').setNumberFormat('$#,##0.00');

  sheet.getRange('D1').setValue('Spending by month').setFontWeight('bold');
  sheet.getRange('D2').setFormula(
    '=IFERROR(QUERY(' + f + 'A2:E, "select year(A), month(A)+1, sum(E), sum(C) ' +
    'where A is not null group by year(A), month(A)+1 order by year(A) desc, month(A)+1 desc ' +
    "label year(A) 'Year', month(A)+1 'Month', sum(E) 'Spent', sum(C) 'Gallons'\", 0), " +
    '"No fill-ups yet")');
  sheet.autoResizeColumns(1, 7);
}

// ---------------------------------------------------------------------------
// Sheet helpers and MPG math
// ---------------------------------------------------------------------------

function fillupsSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss && ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" not found. Run setup() first.');
  return sheet;
}

function readEntries_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, COL.total + 1).getValues()
    .filter(function (r) { return typeof r[COL.odometer - 1] === 'number'; })
    .map(function (r) {
      return {
        date: r[COL.date - 1],
        odometer: r[COL.odometer - 1],
        gallons: Number(r[COL.gallons - 1]) || 0,
        total: Number(r[COL.total - 1]) || 0,
        full: r[COL.full - 1] !== false,
      };
    });
}

function idExists_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  return sheet.getRange(2, COL.id, last - 1, 1).getValues()
    .some(function (r) { return String(r[0]) === id; });
}

// computeStats_ (the MPG math) lives in stats.js, shared with the phone app.

/**
 * Recomputes Miles/MPG/$-per-mile for every row. Run it from the editor after
 * editing numbers in the sheet by hand or backfilling old fill-ups.
 */
function recalculateAll() {
  var sheet = fillupsSheet_();
  sortByOdometer_(sheet);
  var entries = readEntries_(sheet);
  if (!entries.length) return;
  var out = entries.map(function (e, i) {
    var s = computeStats_(entries.slice(0, i), e.odometer, e.gallons, e.total, e.full);
    return [s.miles, s.mpg, s.perMile];
  });
  sheet.getRange(2, COL.miles, out.length, 3).setValues(out);
}

function sortByOdometer_(sheet) {
  var last = sheet.getLastRow();
  if (last > 2) sheet.getRange(2, 1, last - 1, HEADERS.length).sort(COL.odometer);
}

function savePhoto_(dataUrl, name) {
  var img = decodeDataUrl_(dataUrl);
  if (!img) return '';
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
    var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    var file = folder.createFile(img.blob.setName(name + '.jpg'));
    return '=HYPERLINK("' + file.getUrl() + '","photo")';
  } catch (e) {
    console.warn('Could not save photo: ' + e.message);
    return '';
  }
}

function folderExists_(id) {
  try {
    return !DriveApp.getFolderById(id).isTrashed();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Photo readers. Each takes {odometer, pump} (decoded images or null) and returns
// {odometer, gallons, price_per_gallon, total} with null for anything unread.
// ---------------------------------------------------------------------------

function extractWithOcr_(images) {
  var reading = emptyReading_();
  var rawText = [];
  if (images.odometer) {
    var odoText = ocr_(images.odometer.blob);
    rawText.push('--- Odometer ---\n' + odoText);
    reading.odometer = parseOdometer_(odoText);
  }
  if (images.pump) {
    var pumpText = ocr_(images.pump.blob);
    rawText.push('--- Pump ---\n' + pumpText);
    var pump = parsePump_(pumpText);
    reading.gallons = pump.gallons;
    reading.price_per_gallon = pump.price_per_gallon;
    reading.total = pump.total;
  }
  reading.rawText = rawText.join('\n\n');
  return reading;
}

/** OCR via Google Drive: convert the image to a temporary Google Doc and read its text. */
function ocr_(blob) {
  var file = Drive.Files.create(
    { name: 'gas-tracker-ocr-temp', mimeType: MimeType.GOOGLE_DOCS },
    blob,
    { ocrLanguage: 'en' }
  );
  try {
    return DocumentApp.openById(file.id).getBody().getText();
  } finally {
    Drive.Files.remove(file.id);
  }
}

function extractWithClaude_(images) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  var content = [];
  addClaudeImage_(content, 'Odometer photo:', images.odometer);
  addClaudeImage_(content, 'Pump photo:', images.pump);
  content.push({ type: 'text', text: VISION_PROMPT });

  var nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
  var body = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    // Retries on another model if this one declines the request.
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            odometer: nullableNumber,
            gallons: nullableNumber,
            price_per_gallon: nullableNumber,
            total: nullableNumber,
          },
          required: ['odometer', 'gallons', 'price_per_gallon', 'total'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: content }],
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var json = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ': ' +
      ((json.error && json.error.message) || res.getContentText().slice(0, 200)));
  }
  if (json.stop_reason === 'refusal') throw new Error('request was declined');
  if (json.stop_reason === 'max_tokens') throw new Error('response was cut off');
  var text = (json.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('');
  return normalizeReading_(JSON.parse(text));
}

function addClaudeImage_(content, label, image) {
  if (!image) return;
  content.push({ type: 'text', text: label });
  content.push({
    type: 'image',
    source: { type: 'base64', media_type: image.mimeType, data: image.base64 },
  });
}

function extractWithGemini_(images) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  var model = props.getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;

  var parts = [];
  [['Odometer photo:', images.odometer], ['Pump photo:', images.pump]].forEach(function (p) {
    if (!p[1]) return;
    parts.push({ text: p[0] });
    parts.push({ inline_data: { mime_type: p[1].mimeType, data: p[1].base64 } });
  });
  parts.push({
    text: VISION_PROMPT + '\nRespond with JSON exactly like: ' +
      '{"odometer": 123456, "gallons": 11.234, "price_per_gallon": 3.499, "total": 39.31}',
  });

  var res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) +
      ':generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      muteHttpExceptions: true,
    }
  );
  var json = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error('HTTP ' + res.getResponseCode() + ': ' +
      ((json.error && json.error.message) || res.getContentText().slice(0, 200)));
  }
  var candidate = json.candidates && json.candidates[0];
  var text = candidate && candidate.content && candidate.content.parts &&
    candidate.content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('empty response');
  return normalizeReading_(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function provider_() {
  var p = (PropertiesService.getScriptProperties().getProperty('PROVIDER') || 'ocr')
    .trim().toLowerCase();
  return PROVIDER_LABELS[p] ? p : 'ocr';
}

function emptyReading_() {
  return { odometer: null, gallons: null, price_per_gallon: null, total: null };
}

function normalizeReading_(obj) {
  var r = emptyReading_();
  Object.keys(r).forEach(function (k) { r[k] = toNumber_(obj && obj[k]); });
  if (r.odometer != null) r.odometer = Math.round(r.odometer);
  return r;
}

function toNumber_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
}

function decodeDataUrl_(dataUrl) {
  if (!dataUrl) return null;
  var m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  var bytes = Utilities.base64Decode(m[2]);
  return { mimeType: m[1], base64: m[2], blob: Utilities.newBlob(bytes, m[1], 'photo') };
}

// ---------------------------------------------------------------------------
// Editor test: put some of your old photos in a "test" folder inside the photos
// folder (names containing "odo" are treated as odometer shots, the rest as pump
// shots), then run this and check View → Logs. Runs every reader you have a key for.
// ---------------------------------------------------------------------------

function testReaders() {
  var props = PropertiesService.getScriptProperties();
  var parent = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
  var it = parent.getFoldersByName('test');
  if (!it.hasNext()) throw new Error('Create a folder named "test" inside "' + FOLDER_NAME + '".');
  var files = it.next().getFiles();
  var readers = { OCR: extractWithOcr_ };
  if (props.getProperty('GEMINI_API_KEY')) readers.Gemini = extractWithGemini_;
  if (props.getProperty('ANTHROPIC_API_KEY')) readers.Claude = extractWithClaude_;

  while (files.hasNext()) {
    var file = files.next();
    if (!/^image\//.test(file.getMimeType())) continue;
    var blob = file.getBlob();
    var image = {
      mimeType: blob.getContentType(),
      base64: Utilities.base64Encode(blob.getBytes()),
      blob: blob,
    };
    var isOdo = /odo/i.test(file.getName());
    var images = { odometer: isOdo ? image : null, pump: isOdo ? null : image };
    Object.keys(readers).forEach(function (name) {
      try {
        var r = readers[name](images);
        console.log(file.getName() + ' [' + name + '] ' + JSON.stringify(r));
      } catch (e) {
        console.log(file.getName() + ' [' + name + '] ERROR ' + e.message);
      }
    });
  }
}
