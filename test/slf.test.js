import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStations, measurementRows } from "../scripts/archive/slf.js";

const resorts = [{ id: "zermatt", latlon: [46.0, 7.73] }, { id: "alta", latlon: [40.59, -111.64] }];
const stations = [
  { code: "ZER2", label: "Zermatt", lat: 46.02, lon: 7.75, elevation: 2600, type: "SNOW_FLAT" },
  { code: "WIND1", label: "Wind", lat: 46.0, lon: 7.74, elevation: 3000, type: "WIND" },
  { code: "FAR", label: "Far", lat: 47.5, lon: 9.0, elevation: 1500, type: "SNOW_FLAT" },
];

test("SLF picks nearby snow stations only, and skips resorts far away", () => {
  const imis = pickStations(stations, resorts, "imis");
  assert.deepEqual(imis.map((p) => p.station.code), ["ZER2"]); // the WIND station is not a snow station
  const plots = pickStations(stations, resorts, "study-plot");
  assert.deepEqual(plots.map((p) => [p.resort, p.station.code]), [["zermatt", "WIND1"], ["zermatt", "ZER2"]]);
});

test("SLF measurements: null is no row; 24 h totals end at measure_date", () => {
  const rows = measurementRows({ station_code: "ZER2", measure_date: "2026-11-11T06:00:00Z", HS: 42, HN_1D: 12, HNW_1D: null },
    stations[0], "study-plot", { fetchedAt: "f", runId: "r" });
  assert.deepEqual(rows.map((r) => r.variable), ["snow_depth", "new_snow_24h"]);
  const hn = rows[1];
  assert.equal(hn.valid_start, "2026-11-10T06:00:00.000Z");
  assert.equal(hn.valid_end, "2026-11-11T06:00:00.000Z");
  assert.equal(hn.station_id, "study-plot:ZER2");
  assert.equal(hn.elevation_m, 2600);
  const imis = measurementRows({ measure_date: "2026-11-11T06:00:00Z", HN_1D: 5 }, stations[0], "imis", { fetchedAt: "f", runId: "r" });
  assert.equal(imis[0].variable, "hn_1d_model"); // modelled new snow never shares a name with the measured one
});
