const test = require('node:test');
const assert = require('node:assert');
const { parseSpeech_ } = require('../shared/parse.js');

const cases = [
  ['labels after numbers', '48,213 miles 11.2 gallons 41.97 dollars',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['dollar sign', '48213 miles 11.2 gallons $41.97',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['labels before numbers', 'odometer 48213 gallons 11 point 2 total $41.97',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['dollars and cents', '52,004 miles 10.5 gallons 36 dollars and 72 cents',
    { odometer: 52004, gallons: 10.5, price_per_gallon: 3.497, total: 36.72 }],
  ['dollars then cents without the word', '52004 miles 10.5 gallons 36 dollars 72',
    { odometer: 52004, gallons: 10.5, price_per_gallon: 3.497, total: 36.72 }],
  ['price per gallon instead of total', '48213 miles 11.2 gallons at 3.49 a gallon',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.49, total: 39.09 }],
  ['no labels at all', '48213 11.2 41.97',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['no labels, all three pump numbers in any order', '48213 39.31 3.499 11.234',
    { odometer: 48213, gallons: 11.234, price_per_gallon: 3.499, total: 39.31 }],
  ['only odometer and gallons', '48213 miles 11.2 gallons',
    { odometer: 48213, gallons: 11.2, price_per_gallon: null, total: null }],
  ['just a follow-up for one missing value', '12.3 gallons',
    { odometer: null, gallons: 12.3, price_per_gallon: null, total: null }],
  ['nothing numeric', 'hello there',
    { odometer: null, gallons: null, price_per_gallon: null, total: null }],

  // Spoken number words, digits said one at a time, and distance mistaken for money.
  ...[
    'two-hundred-eighty thousand five-hundred kilometers',
    'two hundred eighty thousand five hundred kilometers',
    'two hundred and eighty thousand five hundred kilometres',
    'two eight zero five zero zero kilometers',
    '2-8-0-5-0-0 kilometers',
    '280-500 km',
    '2 8 0 5 0 0 km',
    '$280,500 kilometers',
    '$280,500',
  ].map((said) => [`odometer: "${said}"`, said, { odometer: 280500, gallons: null, price_per_gallon: null, total: null }]),
  ['number words for everything', 'forty eight thousand two hundred thirteen miles eleven point two gallons forty one dollars ninety seven cents',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['digit-by-digit odometer with other values', 'four eight two one three miles 11.2 gallons $41.97',
    { odometer: 48213, gallons: 11.2, price_per_gallon: 3.747, total: 41.97 }],
  ['"oh" on its own is not a zero', 'oh I put in 12 gallons',
    { odometer: null, gallons: 12, price_per_gallon: null, total: null }],
];

for (const [name, input, expected] of cases) {
  test(`speech: ${name}`, () => assert.deepStrictEqual(parseSpeech_(input), expected));
}
