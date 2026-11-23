import { test } from "node:test";
import assert from "node:assert/strict";
import { toKmh, swobRows, nwsRows, km, parsePkWnd } from "../scripts/archive/wind-obs.js";

const ctx = { fetchedAt: "2026-11-23T14:07:00.000Z", runId: "r" };
const swob = (p, g = [-118.17, 50.99, 445]) => ({ id: "x", geometry: { coordinates: g }, properties: { "msc_id-value": "1176749", "stn_nam-value": "REVELSTOKE AIRPORT AUTO", "date_tm-value": "2026-11-23T14:00:00.000Z", ...p } });

test("toKmh converts known units and refuses unknown ones", () => {
  assert.equal(toKmh(10, "km/h"), 10);
  assert.equal(toKmh(10, "m/s"), 36);
  assert.ok(Math.abs(toKmh(10, "kt") - 18.52) < 1e-9);
  assert.equal(toKmh(10, "wmoUnit:km_h-1"), 10);
  assert.throws(() => toKmh(10, "furlongs/fortnight"), /unknown wind unit/);
});

test("swobRows: 10-minute mean, gust and direction; km/h; window ends at the observation", () => {
  const rows = swobRows(swob({
    avg_wnd_spd_10m_pst10mts: 12, "avg_wnd_spd_10m_pst10mts-uom": "km/h", max_wnd_spd_10m_pst10mts: 31, "max_wnd_spd_10m_pst10mts-uom": "km/h",
    avg_wnd_dir_10m_pst10mts: 250, "avg_wnd_dir_10m_pst10mts-uom": "deg", "stn_elev-value": 445.116 }), ctx);
  assert.deepEqual(rows.map((r) => [r.variable, r.value, r.unit]), [["wind_speed_mean", 12, "km/h"], ["wind_gust_max", 31, "km/h"], ["wind_dir_mean", 250, "deg"]]);
  assert.equal(rows[0].station_id, "eccc:1176749");
  assert.equal(rows[0].elevation_m, 445);
  assert.equal(rows[0].valid_end, "2026-11-23T14:00:00.000Z");
  assert.equal(rows[0].valid_start, "2026-11-23T13:50:00.000Z");
});

test("swobRows: missing is no row, never 0; bad quality flag is dropped; implausible value is loud", () => {
  assert.equal(swobRows(swob({ avg_wnd_spd_10m_pst10mts: null, "avg_wnd_spd_10m_pst10mts-uom": "km/h" }), ctx).length, 0);
  assert.equal(swobRows(swob({ max_wnd_spd_10m_pst10mts: 40, "max_wnd_spd_10m_pst10mts-uom": "km/h", "max_wnd_spd_10m_pst10mts-qa": -10 }), ctx).length, 0);
  assert.throws(() => swobRows(swob({ max_wnd_spd_10m_pst10mts: 900, "max_wnd_spd_10m_pst10mts-uom": "km/h" }), ctx), /implausible/);
  assert.throws(() => swobRows(swob({ avg_wnd_spd_10m_pst10mts: 5 }), ctx), /unknown wind unit/); // no unit stated
});

test("nwsRows: speed, gust (blank gust writes no row) and direction", () => {
  const f = { properties: { timestamp: "2026-11-23T14:05:00+00:00", windSpeed: { value: 18, unitCode: "wmoUnit:km_h-1" }, windGust: { value: null, unitCode: "wmoUnit:km_h-1" }, windDirection: { value: 200, unitCode: "wmoUnit:degree_(angle)" } } };
  const rows = nwsRows(f, { id: "SLIDE", name: "SLIDE MOUNTAIN", elev: 2941, lat: 39.3, lon: -119.9 }, ctx);
  assert.deepEqual(rows.map((r) => [r.variable, r.value]), [["wind_speed_mean", 18], ["wind_dir_mean", 200]]);
  assert.equal(rows[0].station_id, "nws:SLIDE");
  assert.equal(rows[0].elevation_m, 2941);
});

test("km: Slide Mountain station is about 1.5 km from the Mt Rose point", () => {
  assert.ok(km([39.314, -119.886], [39.30, -119.89]) < 3);
});

test("parsePkWnd: hhmm and mm-only peaks, rolled back when they would be after the report; no remark, no row", () => {
  assert.deepEqual(parsePkWnd("KCPW 231453Z 25015G30KT RMK AO2 PK WND 28045/1456 SLP", "2026-11-23T15:00:00Z"), { dir: 280, kt: 45, time: "2026-11-23T14:56:00.000Z" });
  assert.equal(parsePkWnd("RMK PK WND 28045/56", "2026-11-23T15:53:00Z").time, "2026-11-23T14:56:00.000Z"); // 15:56 would be after the report: previous hour
  assert.equal(parsePkWnd("RMK PK WND 28045/2350", "2026-11-23T00:53:00Z").time, "2026-11-22T23:50:00.000Z"); // previous day
  assert.equal(parsePkWnd("KJAC 231453Z 25015KT RMK AO2", "2026-11-23T15:00:00Z"), null);
  assert.equal(parsePkWnd("", "2026-11-23T15:00:00Z"), null);
  assert.equal(parsePkWnd(undefined, "2026-11-23T15:00:00Z"), null);
  assert.throws(() => parsePkWnd("RMK PK WND 99945/1456", "2026-11-23T15:00:00Z"), /implausible/);
});

test("nwsRows: PK WND remark becomes its own wind_peak_gust row (km/h), never merged with windGust", () => {
  const f = { properties: { timestamp: "2026-11-23T15:00:00+00:00", rawMessage: "KCPW 231500Z 25015KT RMK PK WND 28045/1456", windSpeed: { value: 28, unitCode: "wmoUnit:km_h-1" }, windGust: { value: null, unitCode: "wmoUnit:km_h-1" }, windDirection: { value: null, unitCode: "wmoUnit:degree_(angle)" } } };
  const rows = nwsRows(f, { id: "KCPW", name: "Wolf Creek Pass", elev: 3584 }, ctx);
  const pk = rows.find((r) => r.variable === "wind_peak_gust");
  assert.equal(pk.value, 83.34);
  assert.equal(pk.valid_end, "2026-11-23T14:56:00.000Z");
  assert.equal(rows.some((r) => r.variable === "wind_gust_max"), false);
});
