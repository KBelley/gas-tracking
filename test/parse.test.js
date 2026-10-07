const test = require('node:test');
const assert = require('node:assert');
const { parseOdometer_, parsePump_, toCents_ } = require('../shared/parse.js');

test('odometer: picks the total, not trip/range/temp/clock', () => {
  const text = 'ODO 280,500 km\nTRIP A 312.4\nRANGE 487 km\n12°C\n10:42';
  assert.strictEqual(parseOdometer_(text), 280500);
});

test('odometer: no label, ignores decimals and short numbers', () => {
  assert.strictEqual(parseOdometer_('48213\nTRIP 12345.6\n68'), 48213);
});

test('odometer: decimal trip value is not read as part of a whole number', () => {
  assert.strictEqual(parseOdometer_('12345.6'), null);
});

test('odometer: space as thousands separator', () => {
  assert.strictEqual(parseOdometer_('280 500'), 280500);
});

test('odometer: nothing readable', () => {
  assert.strictEqual(parseOdometer_('P R N D'), null);
  assert.strictEqual(parseOdometer_(''), null);
});

const PUMP = { litres: 45.198, cents_per_litre: 159.9, total: 72.27 };

test('pump: labels on their own lines above the numbers', () => {
  assert.deepStrictEqual(parsePump_('SALE\n$ 72.27\nLITRES\n45.198\nPRICE ¢/L\n159.9'), PUMP);
});

test('pump: labels on the same line', () => {
  assert.deepStrictEqual(parsePump_('TOTAL $ 72.27\nVOLUME L 45.198\nPRICE ¢/L 159.9'), PUMP);
});

test('pump: price shown in dollars per litre is converted to cents', () => {
  assert.deepStrictEqual(parsePump_('TOTAL 72.27\nLITRES 45.198\n$/L 1.599'), PUMP);
});

test('pump: labels under the numbers falls back to the multiplication check', () => {
  assert.deepStrictEqual(parsePump_('72.27\nSALE\n45.198\nLITRES\n159.9\nPRICE'), PUMP);
});

test('pump: no labels at all, extra noise numbers', () => {
  assert.deepStrictEqual(parsePump_('PUMP 7\n72.27\n45.198\n159.9\nREGULAR 87\n0.10'), PUMP);
});

test('pump: one value missing is filled from the other two', () => {
  assert.deepStrictEqual(parsePump_('LITRES 40.000\nPRICE ¢/L 150.0'), { litres: 40, cents_per_litre: 150, total: 60 });
});

test('pump: unreadable', () => {
  assert.deepStrictEqual(parsePump_('THANK YOU'), { litres: null, cents_per_litre: null, total: null });
});

test('price: dollars become cents, cents stay cents', () => {
  assert.strictEqual(toCents_(1.599), 159.9);
  assert.strictEqual(toCents_(159.9), 159.9);
  assert.strictEqual(toCents_(null), null);
});
