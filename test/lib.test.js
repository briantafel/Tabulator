/* Pure-logic checks. No browser, no network. Run: node --test test/ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { score, flags } from "../src/lib/scoring.js";
import { snowTxt, tempTxt, windTxt, toCm, toC } from "../src/lib/units.js";
import { buildUrl, shapeDays, RESORTS } from "../src/lib/openMeteo.js";
import { TODAY_IDX, WARM_LIMIT, COLD_LIMIT, WIND_LIMIT } from "../src/lib/constants.js";
import { fromIso, shortDate } from "../src/lib/dates.js";
import { makeFixture, EXPECTED_DAYS } from "./fixture.js";

test("resort list is intact and well-formed", () => {
  assert.equal(RESORTS.length, 23);
  for (const r of RESORTS) {
    assert.ok(r.id && r.name && r.region, `${r.name} missing a field`);
    assert.ok(r.lat >= -90 && r.lat <= 90, `${r.name} latitude out of range`);
    assert.ok(r.lon >= -180 && r.lon <= 180, `${r.name} longitude out of range`);
    assert.ok(r.elev > 0 && r.elev < 5000, `${r.name} elevation implausible`);
  }
  assert.equal(new Set(RESORTS.map((r) => r.id)).size, 23, "duplicate resort id");
});

test("request carries every resort and the load-bearing past_days", () => {
  const url = new URL(buildUrl());
  assert.equal(url.searchParams.get("latitude").split(",").length, 23);
  assert.equal(url.searchParams.get("longitude").split(",").length, 23);
  assert.equal(url.searchParams.get("elevation").split(",").length, 23);
  assert.equal(url.searchParams.get("past_days"), "3");
  assert.equal(url.searchParams.get("forecast_days"), "16");
  assert.equal(url.searchParams.get("temperature_unit"), "fahrenheit");
  assert.match(url.searchParams.get("daily"), /snowfall_sum/);
});

test("shapeDays maps the daily arrays one-to-one", () => {
  const days = shapeDays(makeFixture()[0]);
  assert.equal(days.length, EXPECTED_DAYS);
  assert.ok("snow" in days[0] && "hi" in days[0] && "lo" in days[0] && "wind" in days[0]);
});

test("today sits at index 3 in the combined series", () => {
  const days = shapeDays(makeFixture(new Date("2026-08-20T12:00:00Z"))[0]);
  assert.equal(days[TODAY_IDX].date, "2026-08-20");
});

test("score sums the window and reads `before` from the three prior days", () => {
  const resort = { name: "Test", all: shapeDays(makeFixture()[0]) };
  const s = score(resort, TODAY_IDX, TODAY_IDX + 3);

  assert.equal(s.win.length, 4, "inclusive window");
  const manual = resort.all.slice(TODAY_IDX, TODAY_IDX + 4).reduce((a, d) => a + d.snow, 0);
  assert.ok(Math.abs(s.total - manual) < 1e-9);

  const priorManual = resort.all.slice(TODAY_IDX - 3, TODAY_IDX).reduce((a, d) => a + d.snow, 0);
  assert.ok(Math.abs(s.before - priorManual) < 1e-9, "`before` is the base you land on");

  assert.ok(Math.abs(s.cumulative.at(-1) - s.total) < 1e-9, "curve ends at the total");
  assert.equal(s.cumulative.length, s.win.length);
});

test("score clamps `before` at the start of the series", () => {
  const resort = { name: "Test", all: shapeDays(makeFixture()[0]) };
  assert.equal(score(resort, 0, 2).before, 0, "nothing before day zero");
});

test("warning flags fire exactly at the thresholds", () => {
  assert.equal(flags({ hi: WARM_LIMIT, lo: 10, wind: 0 }).warm, true);
  assert.equal(flags({ hi: WARM_LIMIT - 1, lo: 10, wind: 0 }).warm, false);
  assert.equal(flags({ hi: 20, lo: COLD_LIMIT, wind: 0 }).cold, true);
  assert.equal(flags({ hi: 20, lo: COLD_LIMIT + 1, wind: 0 }).cold, false);
  assert.equal(flags({ hi: 20, lo: 10, wind: WIND_LIMIT }).wind, true);
  assert.equal(flags({ hi: 20, lo: 10, wind: WIND_LIMIT - 1 }).wind, false);
});

test("unit conversion and display formatting", () => {
  assert.equal(snowTxt(0, false), "0");
  assert.equal(snowTxt(0.01, false), "0", "sub-threshold reads as zero, not 0.0");
  assert.equal(snowTxt(5.25, false), "5.3");
  assert.equal(snowTxt(12.4, false), "12", "double digits lose the decimal");
  assert.equal(snowTxt(10, true), Math.round(toCm(10)).toString());

  assert.equal(tempTxt(null, false), "—");
  assert.equal(tempTxt(32, false), "32");
  assert.equal(tempTxt(32, true), Math.round(toC(32)).toString());

  assert.equal(windTxt(null, false), "—");
  assert.equal(windTxt(35, false), "35");
});

test("dates are midday-anchored so offsets can't shunt the day", () => {
  assert.equal(fromIso("2026-08-20").getHours(), 12);
  assert.ok(shortDate("2026-08-20").length > 0);
});

test("ranking puts the deepest resort first", () => {
  const raw = makeFixture().map((x, i) => ({ ...RESORTS[i], all: shapeDays(x) }));
  const ranked = raw.map((r) => score(r, TODAY_IDX, TODAY_IDX + 3)).sort((a, b) => b.total - a.total);
  assert.equal(ranked.length, 23);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].total >= ranked[i].total, "sorted descending by snow");
  }
});
