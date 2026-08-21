import { test } from "node:test";
import assert from "node:assert/strict";

import { RESORT_META as RESORTS, isStale } from "../src/lib/forecast.js";
import { score, before, flags, rainRisk } from "../src/lib/scoring.js";
import { snowTxt, snowUnit, snowWithUnit, tempTxt, windTxt, cmToIn, cToF, kmhToMph } from "../src/lib/units.js";
import { WARM_LIMIT, COLD_LIMIT, WIND_LIMIT, HORIZON_DAYS } from "../src/lib/constants.js";

/* ---------------------------- resort list ---------------------------- */

test("resort list is intact and well-formed", () => {
  assert.equal(RESORTS.length, 23);
  for (const r of RESORTS) {
    assert.ok(r.id && r.name && r.region, `${r.name} missing a field`);
    assert.ok(Array.isArray(r.slugs) && r.slugs.length, `${r.name} has no Snow-Forecast slug`);
    for (const s of r.slugs) assert.match(s, /^[A-Za-z][A-Za-z0-9-]*$/, `${r.name}: bad slug "${s}"`);
  }
  assert.equal(new Set(RESORTS.map((r) => r.id)).size, 23, "duplicate resort id");
  const slugs = RESORTS.flatMap((r) => r.slugs);
  assert.equal(new Set(slugs).size, slugs.length, "a slug is used by two resorts");
});

test("Palisades is one entry backed by both lift-connected faces", () => {
  const p = RESORTS.find((r) => r.id === "palisades");
  assert.deepEqual(p.slugs, ["Squaw-Valley", "Alpine-Meadows"]);
});

/* ------------------------------- units ------------------------------- */

test("metric mode does not render an inch mark", () => {
  // The bug carried over from the Open-Meteo build: snowTxt converted
  // correctly but every call site appended a literal `"`, so cm/°C mode
  // rendered centimetres with an inch mark.
  assert.equal(snowUnit(true), "cm");
  assert.equal(snowUnit(false), "″");
  assert.equal(snowWithUnit(25.4, true), "25cm");
  assert.equal(snowWithUnit(25.4, false), "10″");
  assert.ok(!snowWithUnit(25.4, true).includes("″"), "metric must never show an inch mark");
});

test("storage is metric and converts outward", () => {
  assert.equal(snowTxt(10, true), "10");         // 10cm stays 10
  assert.equal(snowTxt(2.54, false), "1.0");     // 2.54cm is one inch
  assert.equal(tempTxt(0, true), "0");
  assert.equal(tempTxt(0, false), "32");
  assert.equal(windTxt(100, true), "100");
  assert.equal(windTxt(100, false), "62");
  assert.equal(Math.round(cmToIn(2.54)), 1);
  assert.equal(cToF(100), 212);
  assert.equal(Math.round(kmhToMph(160.934)), 100);
});

test("nulls display as an em-dash rather than zero or NaN", () => {
  assert.equal(snowTxt(null, false), "—");
  assert.equal(snowWithUnit(null, false), "—");
  assert.equal(tempTxt(null, false), "—");
  assert.equal(windTxt(null, false), "—");
});

test("thresholds are metric and match the imperial intent", () => {
  // Stored metric because that is what the source serves, but these numbers
  // were chosen in F and mph. Assert closeness, not exact rounding — the
  // cold threshold lands a hair below zero and Math.round returns -0.
  const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
  near(cToF(WARM_LIMIT), 34);
  near(cToF(COLD_LIMIT), 0);
  near(kmhToMph(WIND_LIMIT), 35);
  assert.equal(HORIZON_DAYS, 6, "Snow-Forecast's free horizon");
});

/* ------------------------------ scoring ------------------------------ */

const day = (date, snow, tempMax = -5, tempMin = -12, windMax = 10, freezeMin = 1200) =>
  ({ date, snow, tempMax, tempMin, windMax, freezeMin });

const RESORT = {
  id: "alta", name: "Alta", region: "Utah",
  elevation: { top: 3373, mid: 2986, bot: 2600 },
  days: [
    day("2026-01-10", 5), day("2026-01-11", 12), day("2026-01-12", 0),
    day("2026-01-13", 3), day("2026-01-14", 8), day("2026-01-15", 1),
  ],
};

const HISTORY = {
  "2026-01-07": { alta: 2 },
  "2026-01-08": { alta: 4 },
  "2026-01-09": { alta: 6 },
};

test("score sums the window and tracks the running total", () => {
  const s = score(RESORT, 0, 2, HISTORY);
  assert.equal(s.total, 17);
  assert.deepEqual(s.cumulative, [5, 17, 17]);
  assert.equal(s.win.length, 3);
});

test("-3 days reads the three days before the window from history", () => {
  const s = score(RESORT, 0, 2, HISTORY);
  assert.equal(s.before, 12); // 2 + 4 + 6
});

test("-3 days is null, never zero, when history is short", () => {
  // A missing base and a bare mountain are the same number and opposite
  // decisions. Cold start must be distinguishable from no snow.
  assert.equal(before({ "2026-01-09": { alta: 6 } }, "alta", "2026-01-10"), null);
  assert.equal(before({}, "alta", "2026-01-10"), null);
  assert.equal(before(null, "alta", "2026-01-10"), null);
  assert.equal(score(RESORT, 0, 2, {}).before, null);
});

test("temp takes the window max, wind the max, freezing level the min", () => {
  const r = { ...RESORT, days: [day("2026-01-10", 0, -2, -20, 60, 900), day("2026-01-11", 0, 3, -8, 20, 2500)] };
  const s = score(r, 0, 1, {});
  assert.equal(s.hi, 3);
  assert.equal(s.lo, -20);
  assert.equal(s.wind, 60);
  assert.equal(s.freezeMin, 900);
});

test("flags fire on the metric thresholds", () => {
  assert.equal(flags({ hi: 2, lo: -5, wind: 10 }).warm, true);    // above 1C
  assert.equal(flags({ hi: 0, lo: -5, wind: 10 }).warm, false);
  assert.equal(flags({ hi: 0, lo: -20, wind: 10 }).cold, true);   // below -18C
  assert.equal(flags({ hi: 0, lo: -5, wind: 60 }).wind, true);    // above 56km/h
});

test("absent data raises no warning", () => {
  // A partial scrape must not dot every resort as dangerous.
  const f = flags({ hi: null, lo: null, wind: null });
  assert.deepEqual(f, { wind: false, warm: false, cold: false });
});

test("rain risk reads freezing level against the mid station", () => {
  // The thing Open-Meteo could only have inferred from max temp.
  assert.equal(rainRisk({ freezeMin: 3200, elevation: { mid: 2986 } }), true);
  assert.equal(rainRisk({ freezeMin: 1200, elevation: { mid: 2986 } }), false);
  assert.equal(rainRisk({ freezeMin: null, elevation: { mid: 2986 } }), false);
});

/* ----------------------------- staleness ----------------------------- */

test("a forecast older than a day is flagged stale", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  assert.equal(isStale("2026-01-10T06:00:00Z", now), false);
  assert.equal(isStale("2026-01-09T00:00:00Z", now), true);
  assert.equal(isStale(undefined, now), true);
  assert.equal(isStale("not a date", now), true);
});
