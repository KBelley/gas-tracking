/**
 * Fuel economy math, shared by the Apps Script backend and the phone app (so it
 * shows instantly, even offline). Edit in shared/ only; `npm run sync` copies it.
 */

/**
 * Distance since the previous fill. Fuel economy (L/100 km) and $/km only on full
 * fills: all litres (and dollars) put in since the previous FULL fill, including
 * this one, over the km driven since then. Uses odometer order, so backfilled
 * entries work too.
 * @param {Array<{odometer:number, litres:number, total:number, full:boolean}>} entries
 * @return {{distance: number|'', economy: number|'', perKm: number|''}}
 */
function computeStats_(entries, odometer, litres, total, full) {
  var earlier = entries
    .filter(function (e) { return e.odometer < odometer; })
    .sort(function (a, b) { return a.odometer - b.odometer; });
  var stats = { distance: '', economy: '', perKm: '' };
  if (!earlier.length) return stats;

  stats.distance = odometer - earlier[earlier.length - 1].odometer;
  if (!full) return stats;

  var litresSince = litres;
  var dollarsSince = total || 0;
  for (var i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i].full) {
      var km = odometer - earlier[i].odometer;
      stats.economy = Math.round(litresSince / km * 100 * 10) / 10;
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
