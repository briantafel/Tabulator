import { test } from "node:test";
import assert from "node:assert/strict";
import { HOURLY, responseToRows, toBlocks } from "../scripts/archive/ensembles.js";

const hours = Array.from({ length: 6 }, (_, i) => `2026-01-03T${String(i + 1).padStart(2, "0")}:00`);
const flat = (v) => hours.map(() => v);

test("toBlocks adds the SLR predictors as 6-hour means", () => {
  const [b] = toBlocks(hours, {
    snowfall: flat(1), precipitation: flat(1), temperature_2m: flat(-5), freezing_level_height: flat(1500),
    wind_speed_10m: flat(10), relative_humidity_2m: flat(90), wind_direction_10m: flat(270),
    temperature_700hPa: [-12, -12, -13, -13, -14, -14], wind_speed_700hPa: flat(40),
    wind_direction_700hPa: [350, 350, 350, 10, 10, 10], relative_humidity_700hPa: flat(95),
  });
  const v = Object.fromEntries(b.values.map(([k, x]) => [k, x]));
  assert.equal(v.temp_700_mean, -13);
  assert.equal(v.temp_700_min, -14);
  assert.equal(v.rh_700_mean, 95);
  assert.equal(v.wind_dir_10m_mean, 270);
  // 350° and 10° average to north, not to 180°.
  assert.ok(v.wind_dir_700_mean < 0.5 || v.wind_dir_700_mean > 359.5, `got ${v.wind_dir_700_mean}`);
});

test("a series the model lacks gives no value, never zero", () => {
  const [b] = toBlocks(hours, { snowfall: flat(0), precipitation: flat(0) });
  const v = Object.fromEntries(b.values.map(([k, x]) => [k, x]));
  assert.equal(v.snow, 0);
  assert.equal(v.temp_700_mean, null);
  assert.equal(v.wind_dir_700_mean, null);
});

test("responseToRows reads hPa names and members; skips 'undefined' units", () => {
  const hourly = { time: hours };
  const units = {};
  for (const v of HOURLY) {
    units[v] = { snowfall: "cm", precipitation: "mm", temperature_2m: "°C", freezing_level_height: "m",
      wind_speed_10m: "km/h", relative_humidity_2m: "%", wind_direction_10m: "°", temperature_700hPa: "°C",
      wind_speed_700hPa: "km/h", wind_direction_700hPa: "°", relative_humidity_700hPa: "%" }[v];
    for (const m of ["", "_member01"]) hourly[`${v}${m}`] = flat(v.includes("direction") ? 200 : 5);
  }
  units.relative_humidity_700hPa = "undefined"; // a model that does not offer it
  const out = responseToRows({ latitude: 40, longitude: -111, hourly, hourly_units: units },
    { resort: { id: "alta" }, model: "gfs025", elevation: 2900, fetchedAt: "2026-01-03T00:00:00Z", runId: "r" });
  assert.equal(out.members, 2);
  assert.deepEqual(out.unavailable, ["relative_humidity_700hPa"]);
  const vars = new Set(out.rows.map((r) => r.variable));
  for (const v of ["temp_700_mean", "wind_speed_700_mean", "wind_dir_700_mean", "rh_2m_mean"]) assert.ok(vars.has(v), v);
  assert.ok(!vars.has("rh_700_mean"));
});

test("a wrong unit for a new variable still fails loudly", () => {
  const hourly = { time: hours, temperature_700hPa: flat(-10), temperature_700hPa_member01: flat(-10) };
  assert.throws(() => responseToRows({ hourly, hourly_units: { temperature_700hPa: "°F" } },
    { resort: { id: "alta" }, model: "gfs025", fetchedAt: "x", runId: "r" }), /°F/);
});

import { zonedWallEnd } from "../scripts/archive/common.js";

test("a night period ends at 06:00 local across both DST changes", () => {
  // Spring forward 2025-03-09 (Denver): 18:00 MST → 06:00 MDT is 11 real hours.
  assert.equal(zonedWallEnd("2025-03-08", 18, 12, "America/Denver"), "2025-03-09T12:00:00.000Z");
  // Fall back 2025-11-02: 18:00 MDT → 06:00 MST is 13 real hours.
  assert.equal(zonedWallEnd("2025-11-01", 18, 12, "America/Denver"), "2025-11-02T13:00:00.000Z");
  assert.equal(zonedWallEnd("2025-01-10", 6, 6, "America/Denver"), "2025-01-10T19:00:00.000Z");
});
