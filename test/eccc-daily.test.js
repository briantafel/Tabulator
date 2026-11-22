import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUnits, coverage, dailyRows, dayWindow, dms, parseStations, pickStations } from "../scripts/archive/eccc-daily.js";

const feat = (id, lat, lon, elev, first = "1990-01-01 00:00:00", last = "2026-11-20 00:00:00", tz = "PST") => ({
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { CLIMATE_IDENTIFIER: id, STATION_NAME: `${id} n`, LATITUDE: 0, LONGITUDE: 0,
    ELEVATION: String(elev), TIMEZONE: tz, DLY_FIRST_DATE: first, DLY_LAST_DATE: last },
});

test("dms: packed degrees-minutes-seconds (real station values), plain degrees pass through", () => {
  assert.ok(Math.abs(dms(485500000) - 48.916667) < 1e-5); // CHEMAINUS BARE POINT
  assert.ok(Math.abs(dms(-1234200000) + 123.7) < 1e-5);
  assert.equal(dms(50.09), 50.09);
});

test("parseStations: geometry first, packed DMS as fallback, string elevation, loud when a field is gone or a position leaves Canada", () => {
  const s = parseStations([feat("A", 50.09, -122.95, 1835.0)]);
  assert.deepEqual([s[0].lat, s[0].lon, s[0].elevation_m, s[0].tz, s[0].first, s[0].last], [50.09, -122.95, 1835, "PST", "1990-01-01", "2026-11-20"]);
  const noGeom = { properties: { ...feat("B", 0, 0, 10).properties, LATITUDE: 485500000, LONGITUDE: -1234200000 } };
  const b = parseStations([noGeom])[0];
  assert.ok(Math.abs(b.lat - 48.916667) < 1e-5 && Math.abs(b.lon + 123.7) < 1e-5);
  assert.throws(() => parseStations([{ properties: { ...noGeom.properties, LATITUDE: 20000000, LONGITUDE: -1000000 } }]), /outside Canada/);
  assert.throws(() => parseStations([{ properties: { CLIMATE_IDENTIFIER: "A" } }]), /lost field/);
});

test("pickStations: Canadian resorts, within 35 km, active in the window, nearest plus highest", () => {
  const st = parseStations([
    feat("LOW", 50.09, -122.95, 650), feat("HIGH", 50.12, -122.90, 1835), feat("FAR", 52, -122.95, 2000),
    feat("DEAD", 50.09, -122.94, 700, "1950-01-01 00:00:00", "1999-12-31 00:00:00"),
  ]);
  const resorts = [{ id: "whistler", region: "Canada", latlon: [50.093, -122.95] }, { id: "alta", region: "Utah", nws: [40.58, -111.63] }];
  const picks = pickStations(st, resorts, { from: "2024-11-01", to: "2025-04-30" });
  assert.deepEqual(picks.map((p) => p.station.id).sort(), ["HIGH", "LOW"]);
});

test("dayWindow: a local standard-time day becomes 24 UTC hours; unknown zone is loud", () => {
  assert.deepEqual(dayWindow("2025-01-14 00:00:00", "PST"), ["2025-01-14T08:00:00.000Z", "2025-01-15T08:00:00.000Z"]);
  assert.deepEqual(dayWindow("2025-01-14 00:00:00", "EST"), ["2025-01-14T05:00:00.000Z", "2025-01-15T05:00:00.000Z"]);
  assert.throws(() => dayWindow("2025-01-14 00:00:00", "XYZ"), /unknown station time zone/);
});

test("dailyRows: null is no row, zero is a row, trace flag kept, out-of-range dropped and counted", () => {
  const st = { id: "A", lat: 50, lon: -123, elevation_m: 1835, tz: "PST" };
  const { rows, faults } = dailyRows([
    { LOCAL_DATE: "2025-01-14 00:00:00", TOTAL_SNOW: 0, TOTAL_SNOW_FLAG: "T", TOTAL_PRECIPITATION: null, SNOW_ON_GROUND: 140, MAX_TEMPERATURE: -3.2, MIN_TEMPERATURE: -9 },
    { LOCAL_DATE: "2025-01-15 00:00:00", TOTAL_SNOW: 999, TOTAL_PRECIPITATION: 12.4 },
  ], st, { fetchedAt: "x", runId: "r" });
  assert.equal(faults, 1);
  const by = (v, d) => rows.find((r) => r.variable === v && r.valid_start.startsWith(d));
  assert.equal(by("total_snow", "2025-01-14").value, 0);
  assert.equal(by("total_snow", "2025-01-14").value_text, "T");
  assert.equal(by("total_precip", "2025-01-14"), undefined);
  assert.equal(by("total_precip", "2025-01-15").value, 12.4);
  assert.equal(by("snow_depth", "2025-01-14").unit, "cm");
});

test("checkUnits: snow reported in mm instead of cm throws", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ variable: "total_snow", value: i }));
  assert.throws(() => checkUnits(rows), /units may have changed/);
});

test("coverage counts stations that reported anything, per resort", () => {
  const picks = [{ resort: "w", station: { id: "A" } }, { resort: "w", station: { id: "B" } }];
  assert.deepEqual(coverage(picks, [{ variable: "total_snow", station_id: "A", value: 1 }]).get("w"), { stations: 2, reporting: 1 });
});
