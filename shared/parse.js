/**
 * Turns OCR text and spoken transcripts into fill-up numbers.
 *
 * Edit this file in shared/ only: `npm run sync` copies it into src/ (Apps Script)
 * and docs/shared/ (phone app). Pure functions, no platform APIs, so the same file
 * runs in Apps Script, the browser and Node tests.
 */

// Metric fill-ups: kilometres, litres, price in cents per litre (as Canadian pumps
// show it, e.g. 159.9), total in dollars. total ≈ litres × cents ÷ 100.

// Plausible ranges for a passenger-car fill-up, used to reject noise.
var PUMP_LIMITS = {
  litres: [0.5, 250],
  cents: [50, 500],
  total: [0.5, 1000],
};
var TYPICAL_CENTS = [100, 250]; // breaks ties between litres and price
var TOTAL_TOLERANCE = 0.05; // dollars

/**
 * Prices can be said or shown in dollars (1.599) or cents (159.9) per litre. Anything
 * under 20 is dollars, so it's converted to cents.
 */
function toCents_(price) {
  if (price == null) return null;
  return price < 20 ? round_(price * 100, 1) : price;
}

/**
 * Finds the odometer reading: the largest 4–7 digit whole number that isn't on a
 * trip, range, economy, temperature or clock line.
 */
function parseOdometer_(text) {
  if (!text) return null;
  var lines = String(text).toUpperCase().split(/\r?\n/);
  var skip = /TRIP|RANGE|MPG|L\/100|KM\/L|AVG|°|\bDTE\b|\d:\d\d/;
  var preferred = [];
  var others = [];

  lines.forEach(function (line) {
    if (skip.test(line)) return;
    // "123,456" and "123 456" are one number on a dash display.
    var cleaned = line.replace(/(\d)[,\s](?=\d{3}\b)/g, '$1');
    var matches = cleaned.match(/(^|[^\d.])(\d{4,7})(?!\d)(?![.,]\d)/g) || [];
    matches.forEach(function (m) {
      var n = parseInt(m.replace(/\D/g, ''), 10);
      if (/ODO|\bKM\b|MILES|\bMI\b/.test(line)) preferred.push(n);
      else others.push(n);
    });
  });

  var pool = preferred.length ? preferred : others;
  return pool.length ? Math.max.apply(null, pool) : null;
}

/**
 * Finds litres, price (¢/L) and total sale on a pump display. Uses the labels next
 * to the numbers first, then falls back to finding three numbers where
 * litres × price ÷ 100 ≈ total.
 */
function parsePump_(text) {
  if (!text) return result_(null, null, null);

  var lines = String(text).toUpperCase().split(/\r?\n/).map(function (l) {
    return l.trim();
  });
  var numbersByLine = lines.map(decimalsIn_);

  var labeled = {
    total: findLabeled_(lines, numbersByLine, /SALE|TOTAL|AMOUNT|DOLLARS|\bPAY\b/, null),
    cents: toCents_(findLabeled_(lines, numbersByLine, /PRICE|¢|CENTS|PER\s*L|\/\s*L\b|\$\s*\/\s*L/, null)),
    litres: findLabeled_(lines, numbersByLine, /LIT(?:RE|ER)|\bL\b|VOLUME/, /PER\s*L|\/\s*L\b|PRICE|¢/),
  };
  if (!inRange_(labeled.total, PUMP_LIMITS.total)) labeled.total = null;
  if (!inRange_(labeled.cents, PUMP_LIMITS.cents)) labeled.cents = null;
  if (!inRange_(labeled.litres, PUMP_LIMITS.litres)) labeled.litres = null;

  if (labeled.total != null && labeled.cents != null && labeled.litres != null &&
      consistent_(labeled.litres, labeled.cents, labeled.total)) {
    return result_(labeled.litres, labeled.cents, labeled.total);
  }

  // Fallback: any three numbers that multiply out. Labeled values constrain the
  // search when we have them.
  var all = [];
  numbersByLine.forEach(function (nums) {
    nums.forEach(function (n) { if (all.indexOf(n) < 0) all.push(n); });
  });
  var best = findTriple_(all, labeled);
  if (best) return result_(best.litres, best.cents, best.total);

  return withDerived_(result_(labeled.litres, labeled.cents, labeled.total));
}

function decimalsIn_(line) {
  // "1,234.56" → 1234.56; a lone comma decimal "3,499" stays ambiguous, so treat
  // commas followed by exactly 3 digits and a dot as thousands separators only.
  var cleaned = line.replace(/(\d),(\d{3}\.)/g, '$1$2');
  var matches = cleaned.match(/\d+\.\d{1,3}/g) || [];
  return matches.map(parseFloat);
}

/**
 * Returns the number on a label's line, or failing that the line after it, or the
 * line before it (some pumps print the label under the digits).
 */
function findLabeled_(lines, numbersByLine, label, exclude) {
  for (var i = 0; i < lines.length; i++) {
    if (!label.test(lines[i])) continue;
    if (exclude && exclude.test(lines[i])) continue;
    var candidates = [numbersByLine[i], numbersByLine[i + 1], numbersByLine[i - 1]];
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] && candidates[c].length) return candidates[c][0];
    }
  }
  return null;
}

function findTriple_(nums, labeled) {
  var best = null;
  for (var i = 0; i < nums.length; i++) {
    for (var j = 0; j < nums.length; j++) {
      for (var k = 0; k < nums.length; k++) {
        if (i === j || j === k || i === k) continue;
        var l = nums[i], c = toCents_(nums[j]), t = nums[k];
        if (!inRange_(l, PUMP_LIMITS.litres) || !inRange_(c, PUMP_LIMITS.cents) ||
            !inRange_(t, PUMP_LIMITS.total)) continue;
        if (!consistent_(l, c, t)) continue;
        var score = Math.abs(l * c / 100 - t);
        // Agreeing with a labeled value beats a slightly closer product.
        if (labeled.litres === l) score -= 1;
        if (labeled.cents === c) score -= 1;
        if (labeled.total === t) score -= 1;
        if (!inRange_(c, TYPICAL_CENTS)) score += 0.5;
        if (!best || score < best.score) best = { litres: l, cents: c, total: t, score: score };
      }
    }
  }
  return best;
}

function consistent_(litres, cents, total) {
  return Math.abs(litres * cents / 100 - total) <= TOTAL_TOLERANCE;
}

/** With two of litres / price / total known, works out the third. */
function withDerived_(r) {
  var l = r.litres, c = r.cents_per_litre, t = r.total;
  if (l != null && c != null && t == null) r.total = round_(l * c / 100, 2);
  else if (l != null && t != null && c == null) r.cents_per_litre = round_(t / l * 100, 1);
  else if (c != null && t != null && l == null) r.litres = round_(t / c * 100, 3);
  return r;
}

function inRange_(n, range) {
  return n != null && n >= range[0] && n <= range[1];
}

function round_(n, places) {
  var f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

function result_(litres, cents, total) {
  return { litres: litres, cents_per_litre: cents, total: total };
}

/**
 * Reads a spoken entry such as "280,500 km, 45.2 litres, 72.31 dollars" or
 * "odometer 280500 litres 45 point 2 price 159.9". Labels can come before or after
 * the numbers; unlabeled numbers are sorted out by size and litres × price ≈ total.
 * Returns only what it heard, plus a missing pump value worked out from the other two.
 */
function parseSpeech_(transcript) {
  var out = { odometer: null, litres: null, cents_per_litre: null, total: null };
  if (!transcript) return out;

  var text = normalizeSpeech_(transcript);

  var tokens = [];
  var re = /\d+(?:\.\d+)?/g;
  var m;
  while ((m = re.exec(text))) {
    tokens.push({ value: parseFloat(m[0]), start: m.index, end: m.index + m[0].length, isInt: m[0].indexOf('.') < 0 });
  }
  if (!tokens.length) return out;

  // Do labels come before the numbers ("litres 45.2") or after ("45.2 litres")?
  var labelFirst = labelOf_(text.slice(0, tokens[0].start), true) != null;

  var unlabeled = [];
  tokens.forEach(function (t, i) {
    // The label nearest the number wins: the last one before it, or the first after it.
    var context = labelFirst
      ? text.slice(i ? tokens[i - 1].end : 0, t.start)
      : text.slice(t.end, i + 1 < tokens.length ? tokens[i + 1].start : text.length);
    var label = labelOf_(context, labelFirst);
    if (label && out[label] == null) out[label] = t.value;
    else unlabeled.push(t);
  });

  // A "total" far too big to be a fill-up is really the odometer (e.g. the speech
  // engine wrote "$280,500" for a spoken distance).
  if (out.odometer == null && out.total != null && out.total > PUMP_LIMITS.total[1] &&
      Math.round(out.total) === out.total && out.total >= 1000) {
    out.odometer = out.total;
    out.total = null;
  }

  // Unlabeled: a big whole number is the odometer, the rest fill pump slots.
  unlabeled = unlabeled.filter(function (t) {
    if (out.odometer == null && t.isInt && t.value >= 1000) {
      out.odometer = t.value;
      return false;
    }
    return true;
  });
  out.cents_per_litre = toCents_(out.cents_per_litre);
  assignPumpValues_(out, unlabeled.map(function (t) { return t.value; }));

  withDerived_(out);
  if (out.odometer != null) out.odometer = Math.round(out.odometer);
  return out;
}

/**
 * Puts a transcript into a form the number matcher can read:
 *   "two hundred eighty thousand five hundred"  → "280500"
 *   "two eight zero five zero zero" / "2-8-0-5-0-0" / "280-500" → "280500"
 *   "eleven point two" / "11 point 2"           → "11.2"
 *   "280,500"                                   → "280500"
 *   "$280,500 km"                               → "280500 km" (a distance, not money)
 *   "$41.97" / "41 dollars and 97 cents"        → "41.97 dollars"
 */
function normalizeSpeech_(transcript) {
  var text = String(transcript).toLowerCase()
    .replace(/([a-z])-(?=[a-z])/g, '$1 '); // "eighty-five" → "eighty five"
  text = wordsToDigits_(text);
  return text
    // Digits said one at a time come back joined by dashes or spaces: join them up.
    .replace(/(?<![\d.,])\d+(?:\s*-\s*\d+)+(?![\d.])/g, function (m) { return m.replace(/[\s-]/g, ''); })
    .replace(/(?<![\d.,])\d(?:\s+\d){3,}(?![\d.])/g, function (m) { return m.replace(/\s/g, ''); })
    .replace(/(\d)\s+point\s+(\d)/g, '$1.$2')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    // A dollar sign in front of a distance is the speech engine guessing wrong.
    .replace(/\$\s*(\d+(?:\.\d+)?)(?=\s*(?:km\b|kilomet|mile|mi\b))/g, '$1')
    .replace(/(\d+)\s*dollars?\s*(?:and\s*)?(\d{1,2})\s*cents?/g, function (_, d, c) {
      return d + '.' + (c.length === 1 ? '0' + c : c) + ' dollars';
    })
    .replace(/(\d+)\s*dollars?\s+(\d{2})\b(?!\s*(?:lit|l\b|gal|mile|km|kilomet|cent|\.\d))/g, '$1.$2 dollars')
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 dollars');
}

var NUMBER_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
var SCALE_WORDS = { hundred: 100, thousand: 1000, million: 1000000 };

/**
 * Replaces runs of number words with digits. A run of single digits ("two eight
 * zero") is read digit by digit; anything else is read as one number ("two hundred
 * eighty thousand five hundred"). "and" inside a number ("two hundred and five") is
 * allowed. "oh" only counts as zero inside a digit-by-digit run.
 */
function wordsToDigits_(text) {
  var words = text.split(/(\s+)/); // keep the spaces so the text can be rebuilt
  var out = [];
  var run = [];

  function isNumberWord(w) { return NUMBER_WORDS.hasOwnProperty(w) || SCALE_WORDS.hasOwnProperty(w); }

  function flush() {
    if (!run.length) return;
    var allDigits = run.every(function (w) { return NUMBER_WORDS.hasOwnProperty(w) && NUMBER_WORDS[w] < 10; });
    if (allDigits && run.length > 1) {
      out.push(run.map(function (w) { return NUMBER_WORDS[w]; }).join(''));
    } else if (run.length === 1 && run[0] === 'oh') {
      out.push('oh'); // just "oh", not a number
    } else {
      // "forty one ninety seven" is two numbers (41 97): a word that can't extend
      // the last one (a second tens word, or anything after a units digit) starts a
      // new number.
      var groups = [];
      var total = 0, current = 0, started = false;
      run.forEach(function (w) {
        if (SCALE_WORDS[w] === 100) {
          current = (current || 1) * 100;
        } else if (SCALE_WORDS[w]) {
          total += (current || 1) * SCALE_WORDS[w];
          current = 0;
        } else {
          var v = NUMBER_WORDS[w];
          var below = current % 100;
          if (total === 0 && current >= 1 && current <= 9 && v >= 10) {
            // "one fifty nine" (a price, 159) or "one nineteen" (119): a single digit
            // followed by a tens or teens word stands for hundreds.
            current = current * 100 + v;
            started = true;
            return;
          }
          if (started && below !== 0 && (v >= 10 || below % 10 !== 0)) {
            groups.push(total + current);
            total = 0;
            current = 0;
          }
          current += v;
        }
        started = true;
      });
      groups.push(total + current);
      out.push(groups.join(' '));
    }
    run = [];
  }

  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (/^\s+$/.test(w)) {
      if (!run.length) out.push(w);
      continue;
    }
    var bare = w.replace(/[.,!?]+$/, '');
    var trailing = w.slice(bare.length);
    var next = (words[i + 2] || '').replace(/[.,!?]+$/, '');
    if (isNumberWord(bare)) {
      run.push(bare);
      if (trailing) { flush(); out.push(trailing + ' '); }
    } else if (bare === 'and' && run.length && isNumberWord(next) &&
        SCALE_WORDS.hasOwnProperty(run[run.length - 1])) {
      // "two hundred and five": the "and" is part of the number
    } else {
      if (run.length) { flush(); out.push(' '); }
      out.push(w);
    }
  }
  flush();
  return out.join('').replace(/\s+/g, ' ').trim();
}

var SPEECH_LABELS = {
  cents_per_litre: /per\s*(?:lit(?:re|er)|l\b)|\ba\s+lit(?:re|er)|\/\s*l\b|cents?\b|¢|price/g,
  litres: /(?<!per\s{0,3}|\ba\s{1,3}|\/\s{0,3})(?:lit(?:re|er)s?\b|\bl\b)/g,
  odometer: /\bkm\b|kilomet\w*|clicks|odometer|\bodo\b|mile\w*|\bmi\b/g,
  total: /dollar\w*|buck\w*|total|\bsale\b|paid|cost|spent/g,
};

/**
 * Which field a stretch of spoken text names, if any. Takes the last label in the
 * stretch when labels come before numbers, otherwise the first.
 */
function labelOf_(context, useLast) {
  var found = null;
  Object.keys(SPEECH_LABELS).forEach(function (field) {
    var re = SPEECH_LABELS[field];
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(context))) {
      var pos = m.index;
      if (!found || (useLast ? pos > found.pos : pos < found.pos)) found = { field: field, pos: pos };
    }
  });
  return found ? found.field : null;
}

/**
 * Puts unlabeled numbers into the empty pump slots. Tries every arrangement and
 * keeps the best: all values in plausible ranges, litres × price ≈ total if all
 * three are known, otherwise spoken order (litres, then total, then price).
 */
function assignPumpValues_(out, values) {
  var slots = ['litres', 'total', 'cents_per_litre'].filter(function (s) { return out[s] == null; });
  if (!slots.length || !values.length) return;
  var limits = { litres: PUMP_LIMITS.litres, cents_per_litre: PUMP_LIMITS.cents, total: PUMP_LIMITS.total };
  var best = null;

  (function permute(used, assignment, slotIndex, orderPenalty) {
    if (slotIndex === slots.length || used.length === values.length) {
      var trial = { litres: out.litres, cents_per_litre: out.cents_per_litre, total: out.total };
      Object.keys(assignment).forEach(function (k) { trial[k] = assignment[k]; });
      var score = orderPenalty;
      for (var k in assignment) if (!inRange_(assignment[k], limits[k])) score += 100;
      // A typical price breaks ties between arrangements that multiply out equally.
      if (assignment.cents_per_litre != null && !inRange_(assignment.cents_per_litre, TYPICAL_CENTS)) score += 5;
      if (trial.litres != null && trial.cents_per_litre != null && trial.total != null) {
        score += consistent_(trial.litres, trial.cents_per_litre, trial.total) ? -50 : 20;
      }
      score -= Object.keys(assignment).length * 10; // prefer using more of what was said
      if (!best || score < best.score) best = { score: score, assignment: assignment };
      return;
    }
    // Leave this slot empty...
    permute(used, assignment, slotIndex + 1, orderPenalty);
    // ...or fill it with any unused value.
    values.forEach(function (v, i) {
      if (used.indexOf(i) >= 0) return;
      var next = {};
      for (var k in assignment) next[k] = assignment[k];
      next[slots[slotIndex]] = slots[slotIndex] === 'cents_per_litre' ? toCents_(v) : v;
      permute(used.concat(i), next, slotIndex + 1, orderPenalty + Math.abs(i - used.length));
    });
  })([], {}, 0, 0);

  if (best) Object.keys(best.assignment).forEach(function (k) { out[k] = best.assignment[k]; });
}

// Lets Node load this file for tests; Apps Script and browsers ignore it.
if (typeof module !== 'undefined') {
  module.exports = {
    parseOdometer_: parseOdometer_, parsePump_: parsePump_, parseSpeech_: parseSpeech_,
    normalizeSpeech_: normalizeSpeech_, toCents_: toCents_,
  };
}
