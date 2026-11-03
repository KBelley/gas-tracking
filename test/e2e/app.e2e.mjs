// End-to-end check of the phone app in a real (headless) browser, against the mock API.
// Run with: npm run test:e2e   (starts the mock server on port 3020 and Edge/Chrome itself)
// Set BROWSER to a chrome/msedge executable if it isn't found automatically.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const BASE = 'http://localhost:3020/';
const SETUP = BASE + '#api=' + encodeURIComponent(BASE + 'mock/exec') + '&token=dev';
const CDP_PORT = 9333;
const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) throw new Error('No Chrome or Edge found. Set BROWSER to its path.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? '— ' + detail : '');
};

// --- processes -------------------------------------------------------------
const server = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs'), '--mock'], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'gaslog-e2e-'));
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

// --- DevTools protocol -----------------------------------------------------
let ws, nextId = 1;
const waiting = new Map();
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r, { once: true }));
        ws.addEventListener('message', (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
        });
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('could not connect to the browser');
}
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return Promise.race([new Promise((r) => waiting.set(id, r)), sleep(5000).then(() => ({ error: 'timeout ' + method }))]);
}
async function js(expr) {
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (!res.result || res.result.exceptionDetails) throw new Error(JSON.stringify(res.result || res.error).slice(0, 400));
  return res.result.result.value;
}
async function waitFor(expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await js(expr)) return true; } catch {}
    await sleep(150);
  }
  return false;
}
const text = (id) => js(`document.getElementById('${id}').textContent`);
// Set SHOTS to a folder to save screenshots of key screens.
async function shot(name) {
  if (!process.env.SHOTS) return;
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(process.env.SHOTS, name + '.png'), Buffer.from(res.result.data, 'base64'));
}
const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(), true`);
async function offline(on) {
  await fetch(BASE + 'mock/network?down=' + (on ? 1 : 0)); // the server drops requests, like no signal
  await send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}
// Speak through a fake microphone: the next mic tap "hears" this.
const say = (words) => js(`window.__say = ${JSON.stringify(words)}; document.getElementById('mic').click(); true`);
// Put a generated JPEG into a photo input, as if picked from the gallery.
const pickPhoto = (selector) => js(`(async () => {
  const c = document.createElement('canvas'); c.width = 40; c.height = 30;
  c.getContext('2d').fillRect(0, 0, 40, 30);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.jpg', { type: 'image/jpeg' }));
  const input = document.querySelector(${JSON.stringify(selector)});
  input.files = dt.files; input.dispatchEvent(new Event('change'));
  return true;
})()`);
const pageSetup = `
  window.__errors = [];
  addEventListener('securitypolicyviolation', (e) => window.__errors.push('CSP ' + e.violatedDirective + ' ' + e.blockedURI));
  addEventListener('error', (e) => window.__errors.push(String(e.message)));
  window.SpeechRecognition = window.webkitSpeechRecognition = function () {
    const self = this;
    self.start = () => {
      setTimeout(() => self.onstart && self.onstart(), 10);
      setTimeout(() => {
        const res = [{ transcript: window.__say || '' }]; res.isFinal = true;
        self.onresult && self.onresult({ results: [res] });
        self.onend && self.onend();
      }, 60);
    };
    self.stop = () => self.onend && self.onend();
  };`;

async function logFillup(words, { full = true } = {}) {
  await js(`document.getElementById('full').checked = ${full}; true`);
  await say(words);
  await waitFor(`document.getElementById('odometer').value !== ''`);
  await click('#save');
  await waitFor(`!document.getElementById('saved').hidden`);
}

// --- the test --------------------------------------------------------------
try {
  await connect();
  for (let i = 0; i < 40 && !(await fetch(BASE).then((r) => r.ok, () => false)); i++) await sleep(150);
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: pageSetup });
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });

  // Setup link
  await send('Page.navigate', { url: SETUP });
  check('entry screen after setup link', await waitFor(`!document.getElementById('entry').hidden`));
  check('token removed from the address bar', await js(`location.hash === ''`));
  check('service worker ready', await waitFor(`navigator.serviceWorker.ready.then(() => true)`));
  await send('Page.reload');
  check('page controlled by the service worker', await waitFor(`!!navigator.serviceWorker.controller`));
  check('status loaded from the sheet', await waitFor(`document.getElementById('status').textContent.includes('Mock')`));

  // Voice entry and fuel economy
  await say('50,000 km 40 litres $64.00');
  await waitFor(`document.getElementById('odometer').value === '50000'`);
  const fields = await js(`['odometer','litres','total','price'].map((id) => document.getElementById(id).value).join(' ')`);
  check('voice fills odometer, litres, total and ¢/L', fields === '50000 40 64 160', fields);
  await click('#save');
  check('first fill-up synced', await waitFor(`document.getElementById('savedSync').textContent.includes('Saved to your sheet')`));
  await click('#done');

  await offline(true);
  await logFillup('odometer 50500 litres 40 point 0 total 64 dollars');
  check('offline: L/100 km shown right away', (await text('savedBig')) === '8.0 L/100 km', await text('savedBig'));
  check('offline: MPG shown too', (await text('savedDetail')).includes('29.4 MPG (US)'), await text('savedDetail'));
  check('offline: says it will sync later', await waitFor(`document.getElementById('savedSync').textContent.includes('when you have signal')`));
  await click('#done');
  await send('Page.reload');
  check('app opens with no signal', await waitFor(`!document.getElementById('entry').hidden`));
  check('badge: 1 waiting', await waitFor(`document.getElementById('syncBadge').textContent.includes('1 waiting')`));
  await offline(false);
  check('queued fill-up syncs when back online', await waitFor(`document.getElementById('syncBadge').hidden`, 10000));

  await send('Page.reload');
  await waitFor(`document.getElementById('status').textContent.includes('50,500')`);
  await logFillup('50700 15 24', { full: false });
  check('partial fill explained', (await text('savedDetail')).includes('Partial fill'));
  await click('#done');
  await logFillup('51000 km 25 litres 40 dollars');
  check('L/100 km spans the partial fill', (await text('savedBig')) === '8.0 L/100 km', await text('savedBig'));
  await click('#done');

  // History
  await click('#openHistory');
  check('history lists all 4 fill-ups', await waitFor(`document.querySelectorAll('#historyList .fill').length === 4`),
    String(await js(`document.querySelectorAll('#historyList .fill').length`)));
  const first = await js(`document.querySelector('#historyList .fill').textContent`);
  check('newest first, with L/100 km and MPG', first.includes('51,000 km') && first.includes('8.0 L/100 km · 29.4 MPG (US)'), first);
  const partial = await js(`document.querySelectorAll('#historyList .fill')[1].textContent`);
  check('partial fill marked in history', partial.includes('Partial fill'), partial);

  // Add photos to a past fill-up (online)
  await click('#historyList .fill button');
  check('add-photos screen opens', await waitFor(`!document.getElementById('attach').hidden`));
  check('it is for the right fill-up', (await text('attachSummary')).includes('51,000 km'), await text('attachSummary'));
  await pickPhoto('#attach-shot-odometer input');
  check('photo picked from gallery shows', await waitFor(`document.getElementById('attach-shot-odometer').classList.contains('has-photo')`));
  await click('#attachCheck');
  check('numbers compared with the photo', await waitFor(`!!document.querySelector('#attachCompare table')`));
  check('a difference is flagged', await js(`!!document.querySelector('#attachCompare td.bad')`));
  await shot('add-photos');
  await click('#attachSave');
  check('photos added to the sheet', await waitFor(`document.getElementById('historyMsg').textContent.includes('Photos added')`),
    await text('historyMsg'));
  check('history links the new photo', await waitFor(`document.querySelector('#historyList .fill').textContent.includes('Odometer photo ↗')`));
  const href = await js(`document.querySelector('#historyList .fill a').href`);
  check('photo link points to Google Drive', href.startsWith('https://drive.google.com/'), href);

  // Won't overwrite an existing photo unless asked
  await click('#historyList .fill button');
  await waitFor(`!document.getElementById('attach').hidden`);
  check('replace option shown when a photo exists', await js(`!document.getElementById('attachReplaceRow').hidden`));
  await pickPhoto('#attach-shot-odometer input');
  await waitFor(`!document.getElementById('attachSave').disabled`);
  await click('#attachSave');
  check('warns instead of overwriting', await waitFor(`document.getElementById('attachMsg').textContent.includes('already has')`));
  await click('#attachBack');

  // Add photos with no signal: waits, then syncs
  await offline(true);
  await waitFor(`!navigator.onLine`);
  await js(`document.querySelectorAll('#historyList .fill button')[2].click(), true`); // the 50,500 km fill-up
  await waitFor(`!document.getElementById('attach').hidden`);
  check('offline: checking numbers is disabled', await js(`document.getElementById('attachCheck').disabled`));
  await pickPhoto('#attach-shot-pump input');
  await waitFor(`!document.getElementById('attachSave').disabled`);
  await click('#attachSave');
  check('offline: photos wait on the phone', await waitFor(`document.getElementById('historyMsg').textContent.includes('when you have signal')`),
    await text('historyMsg'));
  check('offline: marked "Photos waiting to sync"', await waitFor(`document.getElementById('historyList').textContent.includes('Photos waiting to sync')`));
  await offline(false);
  check('photos sync when back online', await waitFor(`!document.getElementById('historyList').textContent.includes('Photos waiting to sync') && document.getElementById('syncBadge').hidden`, 12000));
  check('synced photo linked in history', await waitFor(`document.querySelectorAll('#historyList .fill')[2].textContent.includes('Pump photo ↗')`));
  check('message updates once the photos are in', await waitFor(`document.getElementById('historyMsg').textContent.includes('Photos added')`),
    await text('historyMsg'));
  await shot('history');

  // Security (leave the page first: a link that only changes the # part wouldn't reload it)
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: BASE + '#api=' + encodeURIComponent('https://evil.example/exec') + '&token=' + 'b'.repeat(64) });
  check('look-alike setup link refused', await waitFor(`!document.getElementById('setup').hidden && document.getElementById('setupMsg').textContent.includes('not used')`));
  check('refused link not saved', await js(`kvGet('config').then((c) => c.api.indexOf('evil') < 0)`));
  check('no page errors or CSP violations', (await js('window.__errors')).length === 0, JSON.stringify(await js('window.__errors')));
} catch (e) {
  check('test script error', false, e.stack);
} finally {
  browser.kill();
  server.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `${failed} FAILED` : `ALL ${results.length} PASSED`);
  process.exit(failed ? 1 : 0);
}
