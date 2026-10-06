// Draws the app icons (a white fuel pump on blue) as PNGs with no dependencies.
// Output goes to docs/icons/ and is committed; rerun with `npm run icons`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(fileURLToPath(new URL('..', import.meta.url)), 'docs', 'icons');
const BG = [31, 111, 235];
const FG = [255, 255, 255];

// Shapes in a 0..1 square, sized to stay inside the maskable safe zone (center 80%).
// Each is [x0, y0, x1, y1, color, cornerRadius].
const SHAPES = [
  [0.30, 0.24, 0.58, 0.78, FG, 0.04], // pump body
  [0.35, 0.30, 0.53, 0.44, BG, 0.02], // display window
  [0.26, 0.74, 0.62, 0.80, FG, 0.01], // base
  [0.58, 0.36, 0.66, 0.40, FG, 0.01], // hose out
  [0.64, 0.36, 0.68, 0.64, FG, 0.02], // hose down
  [0.64, 0.60, 0.74, 0.64, FG, 0.01], // hose to nozzle
  [0.70, 0.30, 0.74, 0.64, FG, 0.02], // nozzle
];

function inRounded(x, y, [x0, y0, x1, y1, , r]) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const ss = 4; // supersampling for smooth edges
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          let color = BG;
          for (const shape of SHAPES) if (inRounded(x, y, shape)) color = shape[4];
          acc[0] += color[0]; acc[1] += color[1]; acc[2] += color[2];
        }
      }
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(acc[c] / (ss * ss));
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), render(size));
  console.log(`wrote icons/icon-${size}.png`);
}
