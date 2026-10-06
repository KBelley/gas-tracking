const test = require('node:test');
const assert = require('node:assert');
const { computeStats_ } = require('../shared/stats.js');

test('MPG across full, full, partial, full fills', () => {
  const entries = [];
  const add = (odometer, gallons, total, full) => {
    const s = computeStats_(entries, odometer, gallons, total, full);
    entries.push({ odometer, gallons, total, full });
    return s;
  };
  assert.deepStrictEqual(add(10000, 12, 42, true), { miles: '', mpg: '', perMile: '' });
  assert.deepStrictEqual(add(10300, 10, 35, true), { miles: 300, mpg: 30, perMile: 0.117 });
  assert.deepStrictEqual(add(10450, 5, 17.5, false), { miles: 150, mpg: '', perMile: '' });
  // 400 miles on 5 + 8 gallons; $17.50 + $28 over 400 miles
  assert.deepStrictEqual(add(10700, 8, 28, true), { miles: 250, mpg: 30.8, perMile: 0.114 });

  // Backfilled entry between existing ones measures from the full fill before it.
  assert.deepStrictEqual(computeStats_(entries, 10200, 7, 24, true), { miles: 200, mpg: 28.6, perMile: 0.12 });
});

test('no earlier full fill means no MPG yet', () => {
  const entries = [{ odometer: 1000, gallons: 5, total: 20, full: false }];
  assert.deepStrictEqual(computeStats_(entries, 1200, 8, 30, true), { miles: 200, mpg: '', perMile: '' });
});
