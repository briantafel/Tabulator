#!/usr/bin/env node
/* Shape the SAMPLE forecast so the ranking argues for itself.
 *
 * Brian's spec, verbatim: "the recommended resort should receive less
 * snowfall that one other with frigid temps and howling winds. It should
 * receive the same amount of snow as another resort with very warm temps.
 * But the recommended resort has stable temps and light wind. No concerns."
 *
 * Every resort gets a CONSTANT daily rate rather than a shaped four-day
 * block. That matters: the window is a control, and a relationship that only
 * holds at four days is not a demonstration, it is a coincidence. With flat
 * rates the ordering is identical at two days and at six.
 *
 * The rates below are also all DIFFERENT — "there are a lot of results with
 * the same amount of snowfall. That's confusing." — except for the one pair
 * that is meant to be identical.
 *
 *   node scripts/shape-demo.mjs [forecast.json] [history.json]
 */
import { readFile, writeFile } from "node:fs/promises";
const IN = (i) => i * 2.54, F = (f) => ((f - 32) * 5) / 9, MPH = (m) => m * 1.60934;

const fPath = process.argv[2] ?? "public/forecast.json";
const hPath = process.argv[3] ?? "public/history.json";
const f = JSON.parse(await readFile(fPath, "utf8"));
const h = JSON.parse(await readFile(hPath, "utf8"));

/* Inches PER DAY, °F, mph. */
const CAST = {
  // The pick. Not the most snow, not the least — the only one with nothing
  // wrong with it, and the best base underneath.
  telluride:        { rate: 6.5, hi: 25, lo: 12, wind: 10 },
  // The most snow on the board by a distance, and it still loses. Deliberately
  // just INSIDE both deal breakers — -9F against a -10 veto, 42mph against 45
  // — because a vetoed resort sorts dead last and the whole demonstration
  // ends up ten rows below the fold where nobody sees it. Brian: "Move Alta's
  // numbers." Now it sits second, right under the pick, visibly beaten on the
  // balance rather than disqualified out of sight.
  alta:             { rate: 10,  hi:  5, lo: -9, wind: 42 },
  // EXACTLY the pick's snowfall, decided entirely on temperature.
  heavenly:         { rate: 6.5, hi: 38, lo: 30, wind: 12 },
};
/* Everyone else: a spread, no two alike, all below the pick. */
const REST = [5.5, 5.1, 4.8, 4.4, 4.1, 3.8, 3.4, 3.1, 2.8, 2.4, 2.1, 1.8,
              1.5, 1.3, 1.1, 0.9, 0.7, 0.5, 0.3, 0.2];

let i = 0;
for (const r of f.resorts) {
  const c = CAST[r.id];
  const rate = c ? c.rate : REST[i++ % REST.length];
  for (const d of r.days) {
    d.snow = +IN(rate).toFixed(2);
    if (c) {
      d.tempMax = +F(c.hi).toFixed(2);
      d.tempMin = +F(c.lo).toFixed(2);
      d.windMax = +MPH(c.wind).toFixed(2);
    }
  }
}

/* A real base under the pick — it is one of the four things the ranking
   weighs, and the demo should show it counting for something. */
const start = f.resorts[0].days[0].date;
for (let k = 1; k <= 3; k++) {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - k);
  const key = d.toISOString().slice(0, 10);
  h.days[key] = h.days[key] || {};
  h.days[key].telluride = +(IN(10) / 3).toFixed(2);
  h.days[key].heavenly = +(IN(3) / 3).toFixed(2);
  h.days[key].alta = +(IN(6) / 3).toFixed(2);
}

await writeFile(fPath, JSON.stringify(f, null, 1));
await writeFile(hPath, JSON.stringify(h, null, 1));
console.error(`shaped ${f.resorts.length} resorts`);
