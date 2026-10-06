/**
 * MPG math, shared by the Apps Script backend and the phone app (so MPG shows
 * instantly, even offline). Edit in shared/ only; `npm run sync` copies it.
 */

/**
 * Miles since the previous fill. MPG and $/mile only on full fills: miles since the
 * previous FULL fill divided by all gallons (and dollars) put in since then,
 * including this fill. Uses odometer order, so backfilled entries work too.
 * @param {Array<{odometer:number, gallons:number, total:number, full:boolean}>} entries
 */
function computeStats_(entries, odometer, gallons, total, full) {
  var earlier = entries
    .filter(function (e) { return e.odometer < odometer; })
    .sort(function (a, b) { return a.odometer - b.odometer; });
  var stats = { miles: '', mpg: '', perMile: '' };
  if (!earlier.length) return stats;

  stats.miles = odometer - earlier[earlier.length - 1].odometer;
  if (!full) return stats;

  var gallonsSince = gallons;
  var dollarsSince = total || 0;
  for (var i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i].full) {
      var miles = odometer - earlier[i].odometer;
      stats.mpg = Math.round(miles / gallonsSince * 10) / 10;
      stats.perMile = dollarsSince ? Math.round(dollarsSince / miles * 1000) / 1000 : '';
      return stats;
    }
    gallonsSince += earlier[i].gallons || 0;
    dollarsSince += earlier[i].total || 0;
  }
  return stats; // no earlier full fill to measure from
}

if (typeof module !== 'undefined') {
  module.exports = { computeStats_: computeStats_ };
}
