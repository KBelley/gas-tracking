// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { parseOdometer_, parsePump_ } = require('../shared/parse.js');

test('odometer: picks the total, not trip/range/temp/clock', () => {
  const text = 'ODO 123,456 mi\nTRIP A 312.4\nRANGE 287 mi\n72°F\n10:42';
  assert.strictEqual(parseOdometer_(text), 123456);
});

test('odometer: no label, ignores decimals and short numbers', () => {
  assert.strictEqual(parseOdometer_('48213\nTRIP 12345.6\n68'), 48213);
});

test('odometer: decimal trip value is not read as part of a whole number', () => {
  assert.strictEqual(parseOdometer_('12345.6'), null);
});

test('odometer: space as thousands separator', () => {
  assert.strictEqual(parseOdometer_('87 654'), 87654);
});

test('odometer: nothing readable', () => {
  assert.strictEqual(parseOdometer_('P R N D'), null);
  assert.strictEqual(parseOdometer_(''), null);
});

test('pump: labels on their own lines above the numbers', () => {
  const text = 'TOTAL SALE\n$ 41.97\nGALLONS\n11.997\nPRICE PER GALLON\n3.499';
  assert.deepStrictEqual(parsePump_(text), { gallons: 11.997, price_per_gallon: 3.499, total: 41.97 });
});

test('pump: labels on the same line', () => {
  const text = 'SALE $ 52.10\nGALLONS 14.890\nPRICE/GAL 3.499';
  assert.deepStrictEqual(parsePump_(text), { gallons: 14.89, price_per_gallon: 3.499, total: 52.1 });
});

test('pump: labels under the numbers falls back to the multiplication check', () => {
  const text = '45.67\nSALE\n12.345\nGALLONS\n3.699\nPRICE PER GALLON';
  assert.deepStrictEqual(parsePump_(text), { gallons: 12.345, price_per_gallon: 3.699, total: 45.67 });
});

test('pump: no labels at all, extra noise numbers', () => {
  const text = 'PUMP 7\n38.42\n10.981\n3.499\nREGULAR 87\n0.10';
  assert.deepStrictEqual(parsePump_(text), { gallons: 10.981, price_per_gallon: 3.499, total: 38.42 });
});

test('pump: one value missing is filled from the other two', () => {
  const text = 'GALLONS 10.000\nPRICE PER GALLON 3.459';
  assert.deepStrictEqual(parsePump_(text), { gallons: 10, price_per_gallon: 3.459, total: 34.59 });
});

test('pump: unreadable', () => {
  assert.deepStrictEqual(parsePump_('THANK YOU'), { gallons: null, price_per_gallon: null, total: null });
});
