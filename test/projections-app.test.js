import { test } from "node:test";
import assert from "node:assert/strict";
import { extendFeed, bandAround, isFresh } from "../src/lib/projections.js";
import { score } from "../src/lib/scoring.js";

const NOW = Date.parse("2026-11-03T20:00:00Z");
const sfDays = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]
  .map((date, i) => ({ date, snow: [0, 2, 10, 20, 4, 0][i], tempMax: -2, tempMin: -9, windMax: 20, freezeMin: 1500 }));
const feed = () => ({
  dates: sfDays.map((d) => d.date),
  resorts: [{ id: "alta", name: "Alta", days: sfDays }, { id: "nowhere", name: "Nowhere", days: sfDays }],
  projections: {
    generatedAt: "2026-11-03T18:00:00Z",
    resorts: {
      alta: {
        spread: { "2026-11-06": { p10: 5, p25: 10, p50: 15, p75: 22, p90: 30 } },
        days: ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"].map((date) => ({
          date, snow: { p10: 1, p25: 3, p50: 6, p75: 10, p90: 15 }, tempMax: 1, tempMin: -6, windMax: 70,
        })),
      },
    },
  },
});

test("bands centre on Snow-Forecast's number and never go below zero or exclude it", () => {
  assert.deepEqual(bandAround(20, { p10: 5, p25: 10, p50: 15, p75: 22, p90: 30 }), { p10: 10, p25: 15, p75: 27, p90: 35 });
  assert.deepEqual(bandAround(0, { p10: 0, p25: 1, p50: 4, p75: 8, p90: 12 }), { p10: 0, p25: 0, p75: 4, p90: 8 });
  assert.equal(bandAround(null, { p50: 1 }), null);
});

test("projected days are appended after SF's last date, up to day 10, flagged", () => {
  const f = extendFeed(feed(), NOW);
  assert.equal(f.dates.length, 10);
  assert.deepEqual(f.sfDates, sfDays.map((d) => d.date));
  const alta = f.resorts.find((r) => r.id === "alta");
  assert.equal(alta.days.length, 6 + 4);           // 11-08 overlaps SF; 11-13 is past day 10
  assert.equal(alta.days[6].date, "2026-11-09");
  assert.equal(alta.days[6].projected, true);
  assert.equal(alta.days[6].snow, 6);
  assert.deepEqual(alta.days[3].range, { p10: 10, p25: 15, p75: 27, p90: 35 });
  // A resort without projections keeps its six days.
  assert.equal(f.resorts.find((r) => r.id === "nowhere").days.length, 6);
});

test("stale or missing projections leave the feed as it was", () => {
  const stale = feed(); stale.projections.generatedAt = "2026-11-01T00:00:00Z";
  assert.equal(extendFeed(stale, NOW).dates.length, 6);
  assert.equal(isFresh(stale.projections, NOW), false);
  const none = feed(); delete none.projections;
  assert.equal(extendFeed(none, NOW).resorts[0].days.length, 6);
});

test("totals, markers and rank stand on forecast days only", () => {
  const f = extendFeed(feed(), NOW);
  const alta = f.resorts.find((r) => r.id === "alta");
  const s = score(alta, 0, 9, {});
  assert.equal(s.total, 36);           // 0+2+10+20+4+0 — SF only
  assert.equal(s.projected, 24);       // four projected days × 6 cm
  assert.equal(s.wind, 20);            // the 70 km/h projected wind does not raise the marker
  assert.equal(s.hi, -2);
  const plain = score(sfDays.length && { id: "x", days: sfDays }, 0, 5, {});
  assert.equal(plain.projected, null);
  assert.equal(plain.total, 36);
});

import { projectedTotalRange } from "../src/lib/projections.js";
test("projected totals are added up member by member, models weighted equally", () => {
  const pm = { dates: ["d1", "d2"], models: { a: [[0, 0], [10, 10]], b: [[5, 5]] } };
  const r = projectedTotalRange(pm, ["d1", "d2"]);
  // Totals 0 and 20 (weight 1/4 each) and 10 (weight 1/2): the median is 10.
  assert.ok(r.p25 >= 0 && r.p25 <= 10 && r.p75 >= 10 && r.p75 <= 20 && r.p90 <= 20);
  assert.equal(projectedTotalRange(pm, ["zz"]), null);
  assert.equal(projectedTotalRange(null, ["d1"]), null);
});

test("SF rolled forward a day before projections were rebuilt: still 10 days", () => {
  // Today's real case (2026-11-11): SF 11-11..11-16, projections built off the
  // 11-10..11-15 run, so 11-16 overlaps. With spare days built, 10 survive.
  const sf = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
  const pdates = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"];
  const day = (date) => ({ date, snow: 0 });
  const pd = (date) => ({ date, snow: { p10: 0, p25: 0, p50: 1, p75: 2, p90: 3 } });
  const f = extendFeed({
    dates: sf,
    resorts: [{ id: "a", days: sf.map(day) }],
    projections: { generatedAt: new Date(NOW).toISOString(), resorts: { a: { days: pdates.map(pd) } } },
  }, NOW);
  assert.equal(f.dates.length, 10);
  assert.equal(f.dates.at(-1), "2026-11-20");
  assert.equal(f.resorts[0].days.length, 10);   // the spare 11-21 is trimmed
});

test("a resort with no projections is flagged, not silently cut to six days", () => {
  const f = extendFeed(feed(), NOW);
  const nowhere = f.resorts.find((r) => r.id === "nowhere");
  assert.equal(nowhere.projMissing, true);
  assert.equal(nowhere.days.length, 6);
  assert.equal(f.resorts.find((r) => r.id === "alta").projMissing, undefined);
});

test("a carried-forward entry older than STALE_HOURS is dropped per resort (2026-11-11)", () => {
  const x = feed();
  x.projections.resorts.alta.issuedAt = "2026-11-02T06:00:00Z"; // 38 h before NOW
  const alta = extendFeed(x, NOW).resorts.find((r) => r.id === "alta");
  assert.equal(alta.projMissing, true);
  assert.equal(alta.days.length, 6);
  x.projections.resorts.alta.issuedAt = "2026-11-02T10:00:00Z"; // 34 h: still fresh
  assert.equal(extendFeed(x, NOW).resorts.find((r) => r.id === "alta").days.length, 10);
});
