const test = require('node:test');
const assert = require('node:assert');
const { parseSpeech_ } = require('../shared/parse.js');

const r = (odometer, litres, cents_per_litre, total) => ({ odometer, litres, cents_per_litre, total });
const FULL = r(280500, 45.2, 159.9, 72.27);

const cases = [
  ['labels after numbers', '280,500 km 45.2 litres 72.27 dollars', FULL],
  ['dollar sign', '280500 kilometers 45.2 litres $72.27', FULL],
  ['labels before numbers', 'odometer 280500 litres 45 point 2 total $72.27', FULL],
  ['price instead of total', '280500 km 45.2 litres at 159.9 a litre', FULL],
  ['price said in dollars', '280500 km 45.2 litres 1.599 per litre', FULL],
  ['price said as "one fifty-nine point nine"', '280500 km 45.2 litres one fifty-nine point nine cents', FULL],
  ['price said digit by digit', '280500 km 45.2 litres one five nine point nine cents', FULL],
  ['"L" as the litre label', '280500 km 45.2 L $72.27', FULL],
  ['dollars and cents', '280500 km 45.2 litres 72 dollars and 27 cents', FULL],
  ['dollars then cents without the word', '280500 km 45.2 litres 72 dollars 27', FULL],
  ['no labels at all', '280500 45.2 72.27', FULL],
  ['no labels, all three pump numbers in any order', '280500 72.27 159.9 45.2', FULL],
  ['only odometer and litres', '280500 km 45.2 litres', r(280500, 45.2, null, null)],
  ['just a follow-up for one missing value', '45.2 litres', r(null, 45.2, null, null)],
  ['nothing numeric', 'hello there', r(null, null, null, null)],

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
  ].map((said) => [`odometer: "${said}"`, said, r(280500, null, null, null)]),
  ['number words for everything',
    'two hundred eighty thousand five hundred kilometres forty five point two litres seventy two dollars twenty seven cents', FULL],
  ['"oh" on its own is not a zero', 'oh I put in 45.2 litres', r(null, 45.2, null, null)],
];

for (const [name, input, expected] of cases) {
  test(`speech: ${name}`, () => assert.deepStrictEqual(parseSpeech_(input), expected));
}
