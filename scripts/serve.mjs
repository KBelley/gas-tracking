// Dependency-free static server for the phone app in docs/.
// Port 3020 is this project's reserved port (~/.claude/ports.json); don't change it.
//
//   npm run serve          serve the app
//   npm run serve:mock     also run a fake in-memory API at /mock/exec (token "dev"),
//                          and print a setup link, so the whole app can be tried
//                          without deploying Apps Script
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3020;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const root = join(projectRoot, 'docs');
const mock = process.argv.includes('--mock');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const { computeStats_ } = createRequire(import.meta.url)(join(projectRoot, 'shared', 'stats.js'));
const rows = [];

function mockApi(req) {
  if (req.token !== 'dev') return { ok: false, error: 'unauthorized' };
  if (req.action === 'status') {
    return { ok: true, status: { provider: 'Mock', history: rows.slice(-30) } };
  }
  if (req.action === 'save') {
    const e = req.entry;
    if (rows.some((r) => r.id === e.id)) return { ok: true, result: { duplicate: true } };
    if (e.odometer == null || e.litres == null) return { ok: false, error: 'Odometer and litres are required.' };
    const stats = computeStats_(rows, e.odometer, e.litres, e.total, e.full);
    rows.push({ id: e.id, date: e.date, odometer: e.odometer, litres: e.litres, total: e.total, full: e.full });
    rows.sort((a, b) => a.odometer - b.odometer);
    console.log('[mock] saved', JSON.stringify({ ...e, photos: e.photos ? 'yes' : 'no' }), JSON.stringify(stats));
    return { ok: true, result: stats };
  }
  if (req.action === 'extract') {
    return { ok: true, reading: { odometer: 280500, litres: 45.198, cents_per_litre: 159.9, total: 72.27, readBy: 'Mock' } };
  }
  return { ok: false, error: 'unknown action' };
}

let networkDown = false; // mock only: simulate no signal by dropping every request

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);

  if (mock && path === '/mock/network') {
    networkDown = url.searchParams.get('down') === '1';
    res.end(`network ${networkDown ? 'down' : 'up'}`);
    return;
  }
  if (networkDown) {
    req.socket.destroy();
    return;
  }

  if (mock && path === '/mock/exec' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const out = mockApi(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  const file = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Gas Log app: http://localhost:${PORT}/`);
  if (mock) {
    const api = encodeURIComponent(`http://localhost:${PORT}/mock/exec`);
    console.log(`Mock API setup link: http://localhost:${PORT}/#api=${api}&token=dev`);
  }
});
