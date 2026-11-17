import { test } from "node:test";
import assert from "node:assert/strict";
import { slrAt, dayNewSnowCm, dayFlags, summarise, pickPrimary } from "../scripts/season/season.js";
import { parseDaily, waterYearStart } from "../scripts/season/build.js";

const SLR = { a: 11.558, b: -0.368, clamp: [5, 25], median_observed_slr: 13 };

test("SLR follows the pooled fit and its clamp", () => {
  assert.equal(slrAt(0, SLR), 11.558);
  assert.equal(slrAt(-50, SLR), 25);
  assert.equal(slrAt(null, SLR), 13);
});

test("new snow comes from SWE gain, never from a missing reading", () => {
  const a = { sweMm: 100, tmaxC: -4, tminC: -10 };
  assert.equal(dayNewSnowCm(a, { ...a, sweMm: 110 }, SLR), (10 * slrAt(-7, SLR)) / 10);
  assert.equal(dayNewSnowCm(a, { ...a, sweMm: 95 }, SLR), 0, "settling or melt is no new snow");
  assert.equal(dayNewSnowCm({ sweMm: null }, { sweMm: 110 }, SLR), null, "missing is unknown, not zero");
  assert.equal(dayNewSnowCm(a, { sweMm: 110, tmaxC: 6, tminC: 2 }, SLR), 0, "a warm day's water is rain");
});

test("the gauge stands in when the pillow is missing", () => {
  const prev = { sweMm: null, precipMm: 200 };
  const day = { sweMm: null, precipMm: 205, tmaxC: -5, tminC: -9 };
  assert.ok(dayNewSnowCm(prev, day, SLR) > 0);
});

test("surface flags", () => {
  const prev = { precipMm: 100 };
  assert.deepEqual(dayFlags(prev, { tmaxC: 4, tminC: -5, precipMm: 100, depthCm: 50 }, 0),
    { warm: true, freezeThaw: true, rainOnSnow: false, dump: false });
  assert.equal(dayFlags(prev, { tmaxC: 5, tminC: 1, precipMm: 105, depthCm: 50 }, 0).rainOnSnow, true);
  assert.equal(dayFlags(prev, { tmaxC: -5, tminC: -9, precipMm: 100 }, 20).dump, true);
});

function season(n, f) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
    return { date: d, ...f(i) };
  });
}

test("summary: totals, last dump and what the surface has been through since", () => {
  // 20 days: steady cold, one big storm on day 10 (+20 mm water), then
  // three warm, freeze-thaw days.
  const s = season(20, (i) => ({
    sweMm: 100 + (i >= 10 ? 20 : 0), depthCm: 80 + (i >= 10 ? 30 : 0),
    precipMm: 300 + (i >= 10 ? 20 : 0),
    tmaxC: i >= 15 && i < 18 ? 4 : -6, tminC: i >= 15 && i < 18 ? -4 : -12,
    sweMedMm: 100, depthMedCm: 100,
  }));
  const r = summarise(s, { slr: SLR });
  assert.equal(r.asOf, "2026-11-20");
  assert.equal(r.swePctMedian, 120);
  assert.equal(r.depthPctMedian, 110);
  assert.equal(r.lastDump, "2026-11-11");
  assert.equal(r.daysSinceDump, 9);
  assert.deepEqual(r.sinceDump, { warmDays: 3, freezeThaw: 3, rainOnSnow: 0 });
  assert.ok(r.new14Cm > 15);
  assert.equal(r.new7Cm, 0);
});

test("a window with under half its days known is null, not a small number", () => {
  const s = season(10, (i) => ({ sweMm: i < 7 ? null : 100 + i, tmaxC: -5, tminC: -10 }));
  assert.equal(summarise(s, { slr: SLR }).new7Cm, null);
});

test("the highest station with a current reading speaks for the resort", () => {
  const p = pickPrimary([
    { id: "a", elevationM: 2500, summary: { depthCm: null, sweMm: null } },
    { id: "b", elevationM: 2400, summary: { depthCm: 90, sweMm: 200 } },
    { id: "c", elevationM: 2000, summary: { depthCm: 60, sweMm: 150 } },
  ]);
  assert.equal(p.id, "b");
});

test("AWDB daily JSON parses to metric, medians included", () => {
  const json = [{
    stationTriplet: "1308:UT:SNTL",
    data: [
      { stationElement: { elementCode: "WTEQ", storedUnitCode: "in" }, values: [{ date: "2026-11-16", value: 4, median: 2 }] },
      { stationElement: { elementCode: "SNWD", storedUnitCode: "in" }, values: [{ date: "2026-11-16", value: 30, median: 20 }] },
      { stationElement: { elementCode: "TMAX", storedUnitCode: "degF" }, values: [{ date: "2026-11-16", value: 32 }] },
    ],
  }];
  const stats = { medians: 0 };
  const m = parseDaily(json, new Map(), stats);
  const d = m.get("1308:UT:SNTL").get("2026-11-16");
  assert.equal(d.sweMm, 101.6);
  assert.equal(d.sweMedMm, 50.8);
  assert.equal(d.depthCm, 76.2);
  assert.equal(d.tmaxC, 0);
  assert.equal(stats.medians, 2);
});

test("the water year starts Oct 1", () => {
  assert.equal(waterYearStart(new Date("2026-11-17T00:00:00Z")), "2026-10-01");
  assert.equal(waterYearStart(new Date("2027-02-01T00:00:00Z")), "2026-10-01");
});
