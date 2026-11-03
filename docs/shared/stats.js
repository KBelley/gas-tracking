/**
 * Fuel economy math, shared by the Apps Script backend and the phone app (so it
 * shows instantly, even offline). Edit in shared/ only; `npm run sync` copies it.
 */

// US miles per gallon from L/100 km: (100 km in miles) × (litres per US gallon).
var MPG_US_FACTOR = (100 / 1.609344) * 3.785411784; // ≈ 235.215

/**
 * Distance since the previous fill. Fuel economy (L/100 km, plus the same figure as US
 * MPG) and $/km only on full fills: all litres (and dollars) put in since the previous
 * FULL fill, including this one, over the km driven since then. Uses odometer order,
 * so backfilled entries work too.
 * @param {Array<{odometer:number, litres:number, total:number, full:boolean}>} entries
 * @return {{distance: number|'', economy: number|'', mpg: number|'', perKm: number|''}}
 */
function computeStats_(entries, odometer, litres, total, full) {
  var earlier = entries
    .filter(function (e) { return e.odometer < odometer; })
    .sort(function (a, b) { return a.odometer - b.odometer; });
  var stats = { distance: '', economy: '', mpg: '', perKm: '' };
  if (!earlier.length) return stats;

  stats.distance = odometer - earlier[earlier.length - 1].odometer;
  if (!full) return stats;

  var litresSince = litres;
  var dollarsSince = total || 0;
  for (var i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i].full) {
      var km = odometer - earlier[i].odometer;
      var per100 = litresSince / km * 100;
      stats.economy = Math.round(per100 * 10) / 10;
      stats.mpg = Math.round(MPG_US_FACTOR / per100 * 10) / 10;
      stats.perKm = dollarsSince ? Math.round(dollarsSince / km * 1000) / 1000 : '';
      return stats;
    }
    litresSince += earlier[i].litres || 0;
    dollarsSince += earlier[i].total || 0;
  }
  return stats; // no earlier full fill to measure from
}

if (typeof module !== 'undefined') {
  module.exports = { computeStats_: computeStats_ };
}
