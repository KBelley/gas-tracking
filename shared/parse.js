/**
 * Turns OCR text and spoken transcripts into fill-up numbers.
 *
 * Edit this file in shared/ only: `npm run sync` copies it into src/ (Apps Script)
 * and docs/shared/ (phone app). Pure functions, no platform APIs, so the same file
 * runs in Apps Script, the browser and Node tests.
 */

// Plausible ranges for a passenger-car fill-up, used to reject OCR noise.
var PUMP_LIMITS = {
  gallons: [0.2, 60],
  price: [1, 12],
  total: [0.5, 600],
};
var TOTAL_TOLERANCE = 0.05; // dollars

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
      if (/ODO|MILES|\bMI\b|\bKM\b/.test(line)) preferred.push(n);
      else others.push(n);
    });
  });

  var pool = preferred.length ? preferred : others;
  return pool.length ? Math.max.apply(null, pool) : null;
}

/**
 * Finds gallons, price per gallon and total sale on a pump display.
 * Uses the labels next to the numbers first, then falls back to finding three
 * numbers where gallons × price ≈ total.
 */
function parsePump_(text) {
  var empty = { gallons: null, price_per_gallon: null, total: null };
  if (!text) return empty;

  var lines = String(text).toUpperCase().split(/\r?\n/).map(function (l) {
    return l.trim();
  });
  var numbersByLine = lines.map(decimalsIn_);

  var labeled = {
    total: findLabeled_(lines, numbersByLine, /SALE|TOTAL|AMOUNT|DOLLARS|\bPAY\b/, null),
    price: findLabeled_(lines, numbersByLine, /PRICE|PER\s*GAL|\/\s*GAL|\$\s*\/\s*G|PER\s*G\b/, null),
    gallons: findLabeled_(lines, numbersByLine, /GALLON|\bGALS?\b|VOLUME/, /PER\s*GAL|\/\s*GAL|PRICE/),
  };
  if (!inRange_(labeled.total, PUMP_LIMITS.total)) labeled.total = null;
  if (!inRange_(labeled.price, PUMP_LIMITS.price)) labeled.price = null;
  if (!inRange_(labeled.gallons, PUMP_LIMITS.gallons)) labeled.gallons = null;

  if (labeled.total != null && labeled.price != null && labeled.gallons != null &&
      consistent_(labeled.gallons, labeled.price, labeled.total)) {
    return result_(labeled.gallons, labeled.price, labeled.total);
  }

  // Fallback: any three numbers that multiply out. Labeled values constrain the
  // search when we have them.
  var all = [];
  numbersByLine.forEach(function (nums) {
    nums.forEach(function (n) { if (all.indexOf(n) < 0) all.push(n); });
  });
  var best = findTriple_(all, labeled);
  if (best) return result_(best.gallons, best.price, best.total);

  // Last resort: fill a missing value from the other two.
  var g = labeled.gallons, p = labeled.price, t = labeled.total;
  if (g != null && p != null && t == null) t = round_(g * p, 2);
  else if (g != null && t != null && p == null) p = round_(t / g, 3);
  else if (p != null && t != null && g == null) g = round_(t / p, 3);
  return result_(g, p, t);
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
        var g = nums[i], p = nums[j], t = nums[k];
        if (!inRange_(g, PUMP_LIMITS.gallons) || !inRange_(p, PUMP_LIMITS.price) ||
            !inRange_(t, PUMP_LIMITS.total)) continue;
        if (!consistent_(g, p, t)) continue;
        var score = Math.abs(g * p - t);
        // Agreeing with a labeled value beats a slightly closer product.
        if (labeled.gallons === g) score -= 1;
        if (labeled.price === p) score -= 1;
        if (labeled.total === t) score -= 1;
        if (!best || score < best.score) best = { gallons: g, price: p, total: t, score: score };
      }
    }
  }
  return best;
}

function consistent_(g, p, t) {
  return Math.abs(g * p - t) <= TOTAL_TOLERANCE;
}

function inRange_(n, range) {
  return n != null && n >= range[0] && n <= range[1];
}

function round_(n, places) {
  var f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

function result_(g, p, t) {
  return { gallons: g, price_per_gallon: p, total: t };
}

/**
 * Reads a spoken entry such as "48,213 miles, 11.2 gallons, 41.97 dollars" or
 * "odometer 48213 gallons 11 point 2 total $41.97". Labels can come before or after
 * the numbers; unlabeled numbers are sorted out by size and gallons × price ≈ total.
 * Returns only what it heard, plus a missing pump value worked out from the other two.
 */
function parseSpeech_(transcript) {
  var out = { odometer: null, gallons: null, price_per_gallon: null, total: null };
  if (!transcript) return out;

  var text = String(transcript).toLowerCase()
    .replace(/(\d)\s+point\s+(\d)/g, '$1.$2')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+)\s*dollars?\s*(?:and\s*)?(\d{1,2})\s*cents?/g, function (_, d, c) {
      return d + '.' + (c.length === 1 ? '0' + c : c) + ' dollars';
    })
    .replace(/(\d+)\s*dollars?\s+(\d{2})\b(?!\s*(?:gal|mile|cent|\.\d))/g, '$1.$2 dollars')
    .replace(/\$\s*(\d+(?:\.\d+)?)/g, '$1 dollars');

  var tokens = [];
  var re = /\d+(?:\.\d+)?/g;
  var m;
  while ((m = re.exec(text))) {
    tokens.push({ value: parseFloat(m[0]), start: m.index, end: m.index + m[0].length, isInt: m[0].indexOf('.') < 0 });
  }
  if (!tokens.length) return out;

  // Do labels come before the numbers ("gallons 11.2") or after ("11.2 gallons")?
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

  // Unlabeled: a big whole number is the odometer, the rest fill pump slots.
  unlabeled = unlabeled.filter(function (t) {
    if (out.odometer == null && t.isInt && t.value >= 1000) {
      out.odometer = t.value;
      return false;
    }
    return true;
  });
  assignPumpValues_(out, unlabeled.map(function (t) { return t.value; }));

  var g = out.gallons, p = out.price_per_gallon, total = out.total;
  if (g != null && p != null && total == null) out.total = round_(g * p, 2);
  else if (g != null && total != null && p == null) out.price_per_gallon = round_(total / g, 3);
  else if (p != null && total != null && g == null) out.gallons = round_(total / p, 3);
  if (out.odometer != null) out.odometer = Math.round(out.odometer);
  return out;
}

var SPEECH_LABELS = {
  price_per_gallon: /per\s*gal\w*|\ba\s+gal\w*|\/\s*gal\w*|\beach\b|price/g,
  gallons: /(?<!per\s{0,3}|\ba\s{1,3}|\/\s{0,3})gal\w*/g,
  odometer: /mile\w*|\bmi\b|odometer|\bodo\b|\bkm\b|kilomet\w*/g,
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
 * keeps the best: all values in plausible ranges, gallons × price ≈ total if all
 * three are known, otherwise spoken order (gallons, then total, then price).
 */
function assignPumpValues_(out, values) {
  var slots = ['gallons', 'total', 'price_per_gallon'].filter(function (s) { return out[s] == null; });
  if (!slots.length || !values.length) return;
  var limits = { gallons: PUMP_LIMITS.gallons, price_per_gallon: PUMP_LIMITS.price, total: PUMP_LIMITS.total };
  var best = null;

  (function permute(used, assignment, slotIndex, orderPenalty) {
    if (slotIndex === slots.length || used.length === values.length) {
      var trial = { gallons: out.gallons, price_per_gallon: out.price_per_gallon, total: out.total };
      Object.keys(assignment).forEach(function (k) { trial[k] = assignment[k]; });
      var score = orderPenalty;
      for (var k in assignment) if (!inRange_(assignment[k], limits[k])) score += 100;
      // Gallons and price can swap without changing the product; a typical US gas
      // price breaks the tie.
      if (assignment.price_per_gallon != null && !inRange_(assignment.price_per_gallon, [2, 7])) score += 5;
      if (trial.gallons != null && trial.price_per_gallon != null && trial.total != null) {
        score += consistent_(trial.gallons, trial.price_per_gallon, trial.total) ? -50 : 20;
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
      next[slots[slotIndex]] = v;
      permute(used.concat(i), next, slotIndex + 1, orderPenalty + Math.abs(i - used.length));
    });
  })([], {}, 0, 0);

  if (best) Object.keys(best.assignment).forEach(function (k) { out[k] = best.assignment[k]; });
}

// Lets Node load this file for tests; Apps Script and browsers ignore it.
if (typeof module !== 'undefined') {
  module.exports = { parseOdometer_: parseOdometer_, parsePump_: parsePump_, parseSpeech_: parseSpeech_ };
}
