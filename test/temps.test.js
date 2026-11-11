import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyFromHourly, blendResort } from "../scripts/temps/lib.js";
import { applyTemps, coldLow, stripWithOurTemps } from "../src/lib/temps.js";
import { score } from "../src/lib/scoring.js";
import { vetoOf, cornDay } from "../src/lib/rank.js";

const F = (f) => ((f - 32) * 5) / 9;
const hours = (date, fn) => Array.from({ length: 24 }, (_, h) => [`${date}T${String(h).padStart(2, "0")}:00`, fn(h)]);

test("dailyFromHourly: high, day low, lift-hours low (08–16 inclusive)", () => {
  // Coldest at 05:00 (−20), lift hours bottom out at 08:00 (−12), warmest 14:00.
  const series = hours("2026-12-01", (h) => (h === 5 ? -20 : h === 8 ? -12 : h === 14 ? -2 : -8));
  const d = dailyFromHourly(series.map((x) => x[0]), series.map((x) => x[1]))["2026-12-01"];
  assert.deepEqual(d, { hi: -2, lo: -20, liftLo: -12 });
});

test("dailyFromHourly: a partial day is absent, missing lift hours give no liftLo", () => {
  const part = hours("2026-12-01", () => -5).slice(0, 12);
  assert.deepEqual(dailyFromHourly(part.map((x) => x[0]), part.map((x) => x[1])), {});
  const gap = hours("2026-12-02", (h) => (h === 10 ? null : -5));
  const d = dailyFromHourly(gap.map((x) => x[0]), gap.map((x) => x[1]))["2026-12-02"];
  assert.equal(d.liftLo, null);
  assert.equal(d.lo, -5);
});

test("blendResort: weights per lead, correction only where promoted, missing model re-normalised", () => {
  const perModel = {
    ecmwf_ifs025: { "2026-12-02": { hi: 0, lo: -10, liftLo: -6 } },
    gem_seamless: { "2026-12-02": { hi: 2, lo: -12, liftLo: -8 } },
    // gfs absent that day: dropped, not zero
  };
  const params = {
    weights: { hi: { 1: { ecmwf_ifs025: 0.5, gem_seamless: 0.25, gfs_seamless: 0.25 } },
               lo: { 1: { ecmwf_ifs025: 0.25, gem_seamless: 0.5, gfs_seamless: 0.25 } } },
    high_bias: { "gem_seamless|alta": 2 }, promote: { hi: { 1: true } },
  };
  const [d] = blendResort(perModel, { resortId: "alta", issueDate: "2026-12-01", params });
  // hi: (0.5·0 + 0.25·(2−2)) / 0.75 = 0; lo: (0.25·−10 + 0.5·−12) / 0.75 = −11.3
  assert.deepEqual(d, { date: "2026-12-02", hi: 0, lo: -11.3, liftLo: -7.3, models: 2 });
  const notPromoted = blendResort(perModel, { resortId: "alta", issueDate: "2026-12-01",
    params: { ...params, promote: { hi: { 1: false } } } });
  assert.equal(notPromoted[0].hi, 0.7); // (0 + 0.25·2) / 0.75, no correction
});

const resort = (days) => ({ id: "alta", name: "Alta", days });
const day = (date, o) => ({ date, snow: 10, tempMax: F(20), tempMin: F(-14), windMax: 10, periods: [], ...o });

test("cold veto reads the lift-hours low; switch off keeps the old day low", () => {
  const feed = { resorts: [resort([day("2026-12-02"), day("2026-12-03")])] };
  // Snow-Forecast says −14 °F overnight: vetoed today.
  assert.equal(vetoOf(score(feed.resorts[0], 0, 1, {})), "cold");
  // Our model: −14 °F at 5 am, but −4 °F at the coldest lift hour → not vetoed.
  const temps = { resorts: { alta: { days: [
    { date: "2026-12-02", hi: F(18), lo: F(-14), liftLo: F(-4) },
    { date: "2026-12-03", hi: F(16), lo: F(-12), liftLo: F(-2) }] } } };
  const on = applyTemps(feed, temps);
  const s = score(on.resorts[0], 0, 1, {});
  assert.equal(vetoOf(s), null);
  assert.ok(Math.abs(s.loNight - F(-14)) < 1e-9);
  // −12 °F during lift hours: vetoed.
  const cold = applyTemps(feed, { resorts: { alta: { days: [{ date: "2026-12-02", hi: F(0), lo: F(-20), liftLo: F(-12) }] } } });
  assert.equal(vetoOf(score(cold.resorts[0], 0, 1, {})), "cold");
});

test("a day our model lacks keeps Snow-Forecast and its day low (stricter, never looser)", () => {
  const feed = { resorts: [resort([day("2026-12-02")])] };
  const on = applyTemps(feed, { resorts: { alta: { days: [{ date: "2026-12-09", hi: 0, lo: -5, liftLo: -3 }] } } });
  assert.equal(on.resorts[0].days[0].tempSource, undefined);
  assert.equal(coldLow(on.resorts[0].days[0]), F(-14));
});

test("spring corn reads the overnight low, not the lift-hours low", () => {
  // Late March: warm afternoon, refreezes overnight (25 °F) but lift hours never drop below 34 °F.
  const r = { hi: F(45), lo: F(34), loNight: F(25), spring: true };
  assert.equal(cornDay(r), true);
  assert.equal(vetoOf({ ...r, wind: 10 }), null);
  // Without loNight (switch off) it behaves as before: lo is the night low.
  assert.equal(cornDay({ hi: F(45), lo: F(34), spring: true }), false);
});

test("weather strip: keeps the sky, shows our high and lift-hours low", () => {
  const wx = [{ date: "2026-12-02", short: "Snow", hi: 30, lo: 10 }, { date: "2026-12-03", short: "Sunny", hi: 31, lo: 12 }];
  const days = [{ date: "2026-12-02", tempMax: -5, tempMin: -15, liftMin: -10, tempSource: "model" }];
  const toF = (c) => Math.round((c * 9) / 5 + 32);
  assert.deepEqual(stripWithOurTemps(wx, days, toF), [
    { date: "2026-12-02", short: "Snow", hi: 23, lo: 14 }, wx[1]]);
});
