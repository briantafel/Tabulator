import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotTimes, jstStamp, stationRows, pickStations } from "../scripts/archive/amedas.js";

test("AMeDAS snapshots are 6-hourly on 00/06/12/18 UTC and named in JST", () => {
  const t = snapshotTimes(new Date("2026-11-11T13:30:00Z"), 1);
  assert.deepEqual(t.map((d) => d.toISOString()), ["2026-11-11T12:00:00.000Z", "2026-11-11T06:00:00.000Z",
    "2026-11-11T00:00:00.000Z", "2026-11-10T18:00:00.000Z"]);
  assert.equal(jstStamp(new Date("2026-11-11T00:00:00Z")), "20261111090000");
  // too fresh: the 12 UTC snapshot is skipped at 12:20
  assert.equal(snapshotTimes(new Date("2026-11-11T12:20:00Z"), 1)[0].toISOString(), "2026-11-11T06:00:00.000Z");
});

test("AMeDAS rows: flagged or missing values write nothing; 6 h windows end at the snapshot", () => {
  const at = new Date("2026-11-11T06:00:00Z");
  const rows = stationRows("12345", { snow: [42, 0], snow6h: [8, 0], snow24h: [12, 1], temp: [-3.2, 0] },
    { lat: 42.9, lon: 140.7, alt: 176 }, at, { fetchedAt: "f", runId: "r" });
  assert.deepEqual(rows.map((r) => r.variable), ["snow_depth", "new_snow_6h", "temp"]); // snow24h flag 1 dropped
  assert.equal(rows[1].valid_start, "2026-11-11T00:00:00.000Z");
  assert.equal(rows[1].elevation_m, 176);
});

test("AMeDAS picks only Japanese resorts and converts [deg, min]", () => {
  const table = { "19116": { lat: [42, 54.0], lon: [140, 45.0], alt: 176, enName: "Kutchan" } };
  const p = pickStations(table, [{ id: "niseko", latlon: [42.86, 140.69] }, { id: "alta", latlon: [40.59, -111.64] }]);
  assert.equal(p.length, 1);
  assert.equal(p[0].near[0].code, "19116");
  assert.ok(p[0].near[0].km < 10);
});
