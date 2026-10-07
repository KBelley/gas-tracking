const test = require('node:test');
const assert = require('node:assert');
const { computeStats_ } = require('../shared/stats.js');

test('L/100 km across full, full, partial, full fills', () => {
  const entries = [];
  const add = (odometer, litres, total, full) => {
    const s = computeStats_(entries, odometer, litres, total, full);
    entries.push({ odometer, litres, total, full });
    return s;
  };
  assert.deepStrictEqual(add(10000, 40, 64, true), { distance: '', economy: '', perKm: '' });
  // 40 L over 500 km = 8.0 L/100 km; $64 / 500 km
  assert.deepStrictEqual(add(10500, 40, 64, true), { distance: 500, economy: 8, perKm: 0.128 });
  assert.deepStrictEqual(add(10700, 15, 24, false), { distance: 200, economy: '', perKm: '' });
  // 15 + 25 L over 500 km since the last full fill
  assert.deepStrictEqual(add(11000, 25, 40, true), { distance: 300, economy: 8, perKm: 0.128 });

  // Backfilled entry between existing ones measures from the full fill before it.
  assert.deepStrictEqual(computeStats_(entries, 10400, 36, 57.6, true), { distance: 400, economy: 9, perKm: 0.144 });
});

test('no earlier full fill means no fuel economy yet', () => {
  const entries = [{ odometer: 1000, litres: 20, total: 32, full: false }];
  assert.deepStrictEqual(computeStats_(entries, 1400, 30, 48, true), { distance: 400, economy: '', perKm: '' });
});
