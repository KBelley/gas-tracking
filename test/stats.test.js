const test = require('node:test');
const assert = require('node:assert');
const { computeStats_ } = require('../shared/stats.js');

const none = { distance: '', economy: '', mpg: '', perKm: '' };

test('L/100 km and MPG across full, full, partial, full fills', () => {
  const entries = [];
  const add = (odometer, litres, total, full) => {
    const s = computeStats_(entries, odometer, litres, total, full);
    entries.push({ odometer, litres, total, full });
    return s;
  };
  assert.deepStrictEqual(add(10000, 40, 64, true), none);
  // 40 L over 500 km = 8.0 L/100 km = 29.4 MPG (US); $64 / 500 km
  assert.deepStrictEqual(add(10500, 40, 64, true), { distance: 500, economy: 8, mpg: 29.4, perKm: 0.128 });
  assert.deepStrictEqual(add(10700, 15, 24, false), { ...none, distance: 200 });
  // 15 + 25 L over 500 km since the last full fill
  assert.deepStrictEqual(add(11000, 25, 40, true), { distance: 300, economy: 8, mpg: 29.4, perKm: 0.128 });

  // Backfilled entry between existing ones measures from the full fill before it.
  assert.deepStrictEqual(computeStats_(entries, 10400, 36, 57.6, true), { distance: 400, economy: 9, mpg: 26.1, perKm: 0.144 });
});

test('MPG is the US-gallon conversion of L/100 km', () => {
  // 100 km on 10 L = 62.137 miles on 2.642 US gal = 23.5 MPG
  const s = computeStats_([{ odometer: 0, litres: 0, total: 0, full: true }], 100, 10, 15, true);
  assert.strictEqual(s.economy, 10);
  assert.strictEqual(s.mpg, 23.5);
});

test('no earlier full fill means no fuel economy yet', () => {
  const entries = [{ odometer: 1000, litres: 20, total: 32, full: false }];
  assert.deepStrictEqual(computeStats_(entries, 1400, 30, 48, true), { ...none, distance: 400 });
});
