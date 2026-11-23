import { test } from "node:test";
import assert from "node:assert/strict";
import { speedToKmh, monthWindows, winterOf, parseIemAsos, parseHadsRaw, hadsRows, detectUnit, eccchourlyRows, ecccDailyRows, snotelWindRows, statsOf, summaryTable } from "../scripts/archive/wind-backfill.js";

const ctx = { fetchedAt: "2026-11-23T20:00:00.000Z", runId: "wind-hist-test" };

test("speedToKmh converts explicitly and refuses unknown units", () => {
  assert.equal(speedToKmh(10, "km/h"), 10);
  assert.ok(Math.abs(speedToKmh(10, "kt") - 18.52) < 1e-9);
  assert.ok(Math.abs(speedToKmh(10, "mph") - 16.09344) < 1e-9);
  assert.equal(speedToKmh(10, "m/s"), 36);
  assert.throws(() => speedToKmh(10, "furlongs"), /unknown wind unit/);
  assert.throws(() => speedToKmh(10, undefined), /unknown wind unit/);
});

test("monthWindows clips to the range, end exclusive", () => {
  const w = monthWindows("2023-10-01", "2026-11-22");
  assert.equal(w.length, 38);
  assert.deepEqual(w[0], { month: "2023-10", from: "2023-10-01", to: "2023-11-01" });
  assert.deepEqual(w.at(-1), { month: "2026-11", from: "2026-11-01", to: "2026-11-23" });
  assert.deepEqual(monthWindows("2024-01-10", "2024-01-12"), [{ month: "2024-01", from: "2024-01-10", to: "2024-01-13" }]);
  assert.throws(() => monthWindows("2024-02-01", "2024-01-01"), /bad date range/);
});

test("winterOf labels October to September", () => {
  assert.equal(winterOf("2023-10"), "2023-24");
  assert.equal(winterOf("2024-03"), "2023-24");
  assert.equal(winterOf("2026-11"), "2026-27");
});

const KTRK = { id: "KTRK", lat: 39.32, lon: -120.14, elev: 1798, name: "Truckee-Tahoe" };
test("parseIemAsos: knots to km/h; a blank METAR gust is NOT calm and writes no gust row; calm has no direction", () => {
  const csv = ["station,valid,sknt,gust,drct", "TRK,2025-01-10 00:00,10.00,M,250.00", "TRK,2025-01-10 00:20,18.00,28.00,270.00", "TRK,2025-01-10 00:40,0.00,M,0.00", "TRK,2025-01-10 01:00,M,M,M"].join("\n");
  const { rows } = parseIemAsos(csv, KTRK, ctx);
  const at = (t, v) => rows.filter((r) => r.valid_end === `${t}:00.000Z` && r.variable === v);
  assert.equal(at("2025-01-10T00:00", "wind_speed_mean")[0].value, 18.52);
  assert.equal(at("2025-01-10T00:00", "wind_gust_max").length, 0);
  assert.equal(at("2025-01-10T00:00", "wind_dir_mean")[0].value, 250);
  assert.equal(at("2025-01-10T00:20", "wind_gust_max")[0].value, 51.86);
  assert.equal(at("2025-01-10T00:40", "wind_speed_mean")[0].value, 0);      // a real calm is a real 0
  assert.equal(at("2025-01-10T00:40", "wind_dir_mean").length, 0);
  assert.equal(rows.filter((r) => r.valid_end.startsWith("2025-01-10T01:00")).length, 0); // all missing: no row, never 0
  assert.ok(rows.every((r) => r.station_id === "iem:KTRK" && r.model === "iem-asos" && r.elevation_m === 1798 && r.period_label === "obs" && r.source === "wind-obs"));
});
test("parseIemAsos: window clip and loud header error", () => {
  const csv = "station,valid,sknt,gust,drct\nTRK,2025-01-10 00:00,10,M,250\nTRK,2025-01-11 00:00,10,M,250";
  assert.equal(parseIemAsos(csv, KTRK, { ...ctx, toMs: Date.parse("2025-01-11T00:00:00Z") }).records, 1);
  assert.throws(() => parseIemAsos("Error: no such station", KTRK, ctx), /header unexpected/);
});
test("parseIemAsos: an implausible speed is rejected and counted, not written", () => {
  const { rows, rejected } = parseIemAsos("station,valid,sknt,gust,drct\nTRK,2025-01-10 00:00,500,M,250", KTRK, ctx);
  assert.equal(rows.filter((r) => r.variable === "wind_speed_mean").length, 0);
  assert.equal(rejected.length, 1);
});

test("parseHadsRaw and hadsRows: SHEF missing is dropped, UP peak becomes the gust, mph converts once the unit is known", () => {
  const csv = ["station,valid,USIRGZ,UDIRGZ,UPIRGZ,TAIRGZ", "HLLC1,2025-01-10 00:00,5.0,200,12.0,31.0", "HLLC1,2025-01-10 00:15,,,, 30.0", "HLLC1,2025-01-10 01:00,-9999,-9999,-9999,29.0", "HLLC1,2025-01-10 02:00,0,0,3,28.0"].join("\n");
  const raw = parseHadsRaw(csv);
  assert.deepEqual(raw.cols, { speed: "USIRGZ", dir: "UDIRGZ", gust: null, peak: "UPIRGZ" });
  const { rows } = hadsRows(raw.records, { id: "HLLC1", lat: 39.1, lon: -120.4, elev: 1597, name: "HELL HOLE" }, { ...ctx, unit: "mph" });
  assert.deepEqual(rows.map((r) => [r.variable, r.value, r.valid_end.slice(11, 16)]), [["wind_speed_mean", 8.05, "00:00"], ["wind_gust_max", 19.31, "00:00"], ["wind_dir_mean", 200, "00:00"], ["wind_speed_mean", 0, "02:00"], ["wind_gust_max", 4.83, "02:00"]]);
  assert.equal(rows[0].station_id, "hads:HLLC1");
  assert.throws(() => hadsRows(raw.records, { id: "X" }, { ...ctx, unit: "bogus" }), /unknown wind unit/);
  assert.equal(parseHadsRaw("Error, no results found for query!").empty, true);
});

test("detectUnit finds the one unit the ratios sit on, and refuses otherwise", () => {
  assert.equal(detectUnit(Array(20).fill(1.61)).unit, "mph");
  assert.equal(detectUnit(Array(20).fill(1.85)).unit, "kt");
  assert.throws(() => detectUnit(Array(20).fill(2.4)), /no known unit/);
  assert.throws(() => detectUnit([1.6, 1.6]), /inconclusive/);
});

const REV = { id: "1176745", name: "REVELSTOKE A", lat: 50.99, lon: -118.2, elev: 445, tz: "PST" };
test("eccchourlyRows: km/h kept, direction tens of degrees x10, calm has no direction, flagged nonsense is loud", () => {
  const f = (p) => ({ properties: { UTC_DATE: "2025-01-10 07:00:00", ...p } });
  const a = eccchourlyRows(f({ WIND_SPEED: 14, WIND_DIRECTION: 25 }), REV, ctx);
  assert.deepEqual(a.rows.map((r) => [r.variable, r.value, r.unit]), [["wind_speed_mean", 14, "km/h"], ["wind_dir_mean", 250, "deg"]]);
  assert.equal(a.rows[0].valid_end, "2025-01-10T07:00:00.000Z");
  assert.equal(a.rows[0].model, "eccc-climate-hourly");
  const calm = eccchourlyRows(f({ WIND_SPEED: 0, WIND_DIRECTION: 0 }), REV, ctx);
  assert.deepEqual(calm.rows.map((r) => [r.variable, r.value]), [["wind_speed_mean", 0]]);
  assert.equal(eccchourlyRows(f({ WIND_SPEED: null, WIND_DIRECTION: null }), REV, ctx).rows.length, 0);
  assert.throws(() => eccchourlyRows(f({ WIND_SPEED: 10, WIND_DIRECTION: 250 }), REV, ctx), /tens of degrees/);
});

test("ecccDailyRows: SPEED_MAX_GUST (real probe values) is its own daily wind_gust_max; empty and '<' flagged values write nothing", () => {
  const d = (p) => ({ properties: { LOCAL_DATE: "2025-01-10 00:00:00", DIRECTION_MAX_GUST: 17, DIRECTION_MAX_GUST_FLAG: null, SPEED_MAX_GUST: 45, SPEED_MAX_GUST_FLAG: null, ...p } });
  const { rows } = ecccDailyRows(d({}), REV, ctx);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].variable, rows[0].value, rows[0].period_label, rows[0].model], ["wind_gust_max", 45, "daily", "eccc-climate-daily"]);
  assert.equal(rows[0].valid_start, "2025-01-10T08:00:00.000Z");   // local standard midnight, PST
  assert.equal(rows[0].valid_end, "2025-01-11T08:00:00.000Z");
  assert.equal(ecccDailyRows(d({ SPEED_MAX_GUST: null }), REV, ctx).rows.length, 0);
  assert.equal(ecccDailyRows(d({ SPEED_MAX_GUST: 31, SPEED_MAX_GUST_FLAG: "<" }), REV, ctx).rows.length, 0);
  assert.throws(() => ecccDailyRows(d({}), { ...REV, tz: "XYZ" }, ctx), /unknown time zone/);
});

test("snotelWindRows: mph from the response's own unit, local standard time to UTC, gust never below mean", () => {
  const el = (code, unit, values) => ({ stationElement: { elementCode: code, storedUnitCode: unit }, values });
  const json = [{ stationTriplet: "784:CA:SNTL", data: [
    el("WSPDV", "mph", [{ date: "2025-01-10 00:00", value: 10 }, { date: "2025-01-10 01:00", value: null }]),
    el("WSPDX", "mph", [{ date: "2025-01-10 00:00", value: 20 }]),
    el("WDIRV", "degree", [{ date: "2025-01-10 00:00", value: 270 }]) ] }];
  const st = { id: "784:CA:SNTL", lat: 39.3, lon: -120.4, elev: 2441, tzOffset: -8, name: "Independence Lake" };
  const { rows } = snotelWindRows(json, st, ctx);
  assert.deepEqual(rows.map((r) => [r.variable, r.value]), [["wind_speed_mean", 16.09], ["wind_gust_max", 32.19], ["wind_dir_mean", 270]]);
  assert.equal(rows[0].valid_end, "2025-01-10T08:00:00.000Z");
  assert.equal(rows[0].station_id, "snotel:784:CA:SNTL");
  assert.throws(() => snotelWindRows([{ data: [el("WSPDV", "furlongs", [{ date: "2025-01-10 00:00", value: 1 }])] }], st, ctx), /unknown wind unit/);
});

test("statsOf and summaryTable: gust share of speed hours", () => {
  const { rows } = parseIemAsos("station,valid,sknt,gust,drct\nTRK,2025-01-10 00:00,10,M,250\nTRK,2025-01-10 01:00,10,20,250", KTRK, ctx);
  const s = statsOf(rows);
  assert.deepEqual([s.speed_hours, s.gust_hours, s.by_var.wind_gust_max], [2, 1, 1]);
  const t = summaryTable([{ source: "iem-asos", station_id: "iem:KTRK", month: "2025-01", elev: 1798, ...s }]);
  assert.match(t, /\| iem-asos \| iem:KTRK \| 1798 \| 2024-25 \| 1 \| 5 \| 2 \| 1 \| 2 \| 50\.0% \|/);
});
