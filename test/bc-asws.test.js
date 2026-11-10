import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUnits, parseStations, parseTime, parseWide, pickStations } from "../scripts/archive/bc-asws.js";

const station = (id, lat, lon, elev, status = "Active") => ({
  type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { LOCATION_ID: id, LOCATION_NAME: `${id} name`, ELEVATION: elev, STATUS: status, LATITUDE: lat, LONGITUDE: lon },
});

test("parseStations reads the WFS layer and refuses one that lost its fields", () => {
  const feats = Array.from({ length: 25 }, (_, i) => station(`9Z${String(i).padStart(2, "0")}P`, 50 + i / 100, -118, 1800));
  const s = parseStations({ features: feats });
  assert.equal(s.length, 25);
  assert.deepEqual(s[0], { id: "9Z00P", name: "9Z00P name", lat: 50, lon: -118, elevation_m: 1800, active: true });
  const broken = feats.map((f) => ({ ...f, properties: { NAME: "x" } }));
  assert.throws(() => parseStations({ features: broken }), /lost field LOCATION_ID/);
});

test("pickStations: Canadian resorts only, within 30 km, nearest first, active only", () => {
  const stations = [
    { id: "NEAR", lat: 51.0, lon: -118.1, active: true },
    { id: "FAR", lat: 52.0, lon: -118.16, active: true },
    { id: "DEAD", lat: 51.0, lon: -118.17, active: false },
  ];
  const resorts = [
    { id: "revelstoke", region: "Canada", latlon: [51, -118.16] },
    { id: "alta", region: "Utah", nws: [40.58, -111.63] },
  ];
  const picks = pickStations(stations, resorts);
  assert.deepEqual(picks.map((p) => [p.resort, p.station.id]), [["revelstoke", "NEAR"]]);
});

test("parseTime: UTC wall time, anything else is loud", () => {
  assert.equal(parseTime("2026-10-01 05:00"), "2026-10-01T05:00:00.000Z");
  assert.throws(() => parseTime("Oct 1 2026"), /unreadable/);
});

test("parseWide: wanted stations and window only; blank is missing, not zero; faults dropped", async () => {
  const lines = [
    "DATE(UTC),1A01P Yellowhead Lake,2A06P Mount Revelstoke,3B01P Other",
    "2026-10-01 00:00,0,12,5",
    "2026-10-01 01:00,0,,5",
    "2026-10-01 02:00,0,99999,5",
    "2026-10-01 03:00,0,14,5",
  ];
  const wanted = new Map([["2A06P", { id: "2A06P", lat: 51, lon: -118, elevation_m: 1900 }], ["9X99P", {}]]);
  const rows = [];
  const res = await parseWide(lines, "SW", { wanted, from: "2026-10-01T00:30:00.000Z", fetchedAt: "f", runId: "r", onRow: (r) => rows.push(r) });
  assert.deepEqual(rows.map((r) => [r.valid_start, r.value, r.variable, r.unit]), [["2026-10-01T03:00:00.000Z", 14, "swe", "mm"]]);
  assert.equal(res.faults, 1);
  assert.deepEqual(res.missingStations, ["9X99P"]);
  assert.equal(res.last, "2026-10-01T03:00:00.000Z");
  await assert.rejects(parseWide(["TIME,1A01P x"], "SW", { wanted, onRow() {} }), /expected DATE\(UTC\)/);
});

test("checkUnits catches SWE that arrived in the wrong unit", () => {
  assert.doesNotThrow(() => checkUnits("SW", Array.from({ length: 100 }, (_, i) => i * 10)));
  assert.throws(() => checkUnits("SW", Array.from({ length: 100 }, () => 9000)), /units may have changed/);
});
