import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyFromHourly, blendDay, snowFrom, resortDays } from "../scripts/blend/lib.js";
import { splitModels, forecastToRows } from "../scripts/archive/om-forecast.js";
import { applyOurs, applySnowfall } from "../src/lib/ours.js";
import { parseFlags } from "../src/lib/flags.js";

const hours = (n, start = "2026-11-17T01:00") =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}Z`) + i * 3600e3).toISOString().slice(0, 16));

test("daily water sums hours dated by their start; temperature is precipitation-weighted", () => {
  const time = hours(48);   // hours ending 01:00 … → starts 00:00 Nov 17 … 23:00 Nov 18 UTC
  const p = time.map((_, i) => (i < 12 ? 1 : 0));               // 12 mm in the first 12 hours of Nov 17
  const t = time.map((_, i) => (i < 12 ? -4 : 10));
  const d = dailyFromHourly(time, { precipitation: p, temperature_2m: t }, "UTC");
  assert.deepEqual([...d.keys()], ["2026-11-17", "2026-11-18"]);
  assert.equal(d.get("2026-11-17").water, 12);
  assert.equal(d.get("2026-11-17").t, -4);                      // wet hours only, not the warm dry ones
  assert.equal(d.get("2026-11-18").t, 10);                      // dry day: plain mean
  // A missing hour drops the day; it is never counted as zero.
  const holes = dailyFromHourly(time, { precipitation: p.map((v, i) => (i === 3 ? null : v)), temperature_2m: t }, "UTC");
  assert.equal(holes.has("2026-11-17"), false);
});

test("blend: region factor, else pooled; weights re-normalised over the models present; nearest fitted lead", () => {
  const params = { weights: { 1: { a: 0.75, b: 0.25 }, 7: { a: 0.5, b: 0.5 } },
    factors: { "a|1|Utah": 2 }, pooled_factors: { "b|1": 0.5, "a|1": 1 } };
  // a: 10 × 2 (Utah) = 20; b: 8 × 0.5 = 4 → (0.75·20 + 0.25·4) / 1 = 16
  assert.equal(blendDay({ a: { water: 10, t: -6 }, b: { water: 8, t: -2 } }, { lead: 1, region: "Utah", params }).water, 16);
  // b missing → a alone, not a zero for b
  assert.equal(blendDay({ a: { water: 10, t: -6 } }, { lead: 1, region: "Utah", params }).water, 20);
  // lead 0 uses lead 1; lead 9 uses lead 7
  assert.equal(blendDay({ a: { water: 10, t: -6 } }, { lead: 0, region: "Utah", params }).water, 20);
  assert.equal(blendDay({ a: { water: 10, t: -6 }, b: { water: 10, t: -6 } }, { lead: 9, region: "X", params }).water, 10);
});

test("snow = water × SLR(T) ÷ 10; warm days are rain", () => {
  const line = { a: 11.558, b: -0.368, clamp: [5, 25] };
  assert.ok(Math.abs(snowFrom(10, -5, line) - 10 * (11.558 + 1.84) / 10) < 1e-9);
  assert.equal(snowFrom(10, 3, line), 0);
});

test("Open-Meteo multi-model response: split by suffix, rows per model, loud on a changed shape", () => {
  const time = hours(24, "2026-11-17T01:00");
  const json = { latitude: 40, longitude: -111, elevation: 2600,
    hourly_units: { precipitation_ecmwf_ifs025: "mm", temperature_2m_ecmwf_ifs025: "°C", precipitation_gem_seamless: "undefined" },
    hourly: { time, precipitation_ecmwf_ifs025: time.map(() => 0.5), temperature_2m_ecmwf_ifs025: time.map(() => -3),
      precipitation_gem_seamless: time.map(() => null) } };
  const s = splitModels(json);
  assert.deepEqual(Object.keys(s), ["ecmwf_ifs025"]);
  const rows = forecastToRows(json, { resort: { id: "alta" }, elevation: 2600, fetchedAt: "2026-11-17T07:10:00Z", runId: "r" });
  assert.ok(rows.some((r) => r.variable === "precip" && r.model === "ecmwf_ifs025" && r.value === 3));
  assert.equal(rows.filter((r) => r.variable === "temp").length, 24);
  assert.ok(rows.every((r) => r.source === "open-meteo-forecast" && r.issued_at === "2026-11-17T07:10:00Z"));
  assert.throws(() => splitModels({ hourly: { time, precipitation: time.map(() => 1) } }), /shape/);
});

test("resortDays: lead from the issue date, snow with the resort's SLR line", () => {
  const time = hours(72, "2026-11-17T01:00");
  const series = { precipitation: time.map(() => 0.5), temperature_2m: time.map(() => -5) };
  const params = { weights: { 1: { ecmwf_ifs025: 1 } }, factors: {}, pooled_factors: {} };
  const slr = { a: 11.558, b: -0.368, clamp: [5, 25] };
  const days = resortDays({ time, byModel: { ecmwf_ifs025: series }, tz: "UTC", region: "Utah",
    issueDate: "2026-11-17", params, slr, resortId: "alta" });
  assert.deepEqual(days.map((d) => [d.date, d.lead, d.water]), [["2026-11-17", 0, 12], ["2026-11-18", 1, 12], ["2026-11-19", 2, 12]]);
  assert.equal(days[0].snow, 16.1);   // 12 × 13.398 / 10
});

test("applyOurs: our snow on Snow-Forecast's days only, and never from a stale file", () => {
  const feed = { resorts: [{ id: "alta", days: [{ date: "2026-11-17", snow: 10 }, { date: "2026-11-23", snow: 6, projected: true }] }] };
  const blend = { fetchedAt: "2026-11-17T07:10:00Z", resorts: { alta: { days: [{ date: "2026-11-17", snow: 14 }, { date: "2026-11-23", snow: 9 }] } } };
  const now = Date.parse("2026-11-17T12:00:00Z");
  const out = applyOurs(feed, blend, now).resorts[0].days;
  assert.equal(out[0].ours, 14);
  assert.equal("ours" in out[1], false);
  assert.equal("ours" in applyOurs(feed, blend, now + 40 * 3600e3).resorts[0].days[0], false);
  assert.equal(applyOurs(feed, null), feed);
});

test("applySnowfall: our number replaces Snow-Forecast's, whole resorts only", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const feed = { resorts: [
    { id: "alta", days: [{ date: "2026-11-18", snow: 0, ours: 2 }, { date: "2026-11-19", snow: 7 }, { date: "2026-11-25", snow: 6, projected: true }] },
    { id: "park-city", days: [{ date: "2026-11-18", snow: 3 }, { date: "2026-11-19", snow: 5 }] },
    { id: "brighton", days: [{ date: "2026-11-18", snow: 1 }, { date: "2026-11-19", snow: 4 }] },
  ] };
  const blend = { fetchedAt: "2026-11-18T07:20:00Z", resorts: {
    alta: { days: [{ date: "2026-11-18", snow: 2 }, { date: "2026-11-19", snow: 21 }, { date: "2026-11-25", snow: 30 }] },
    brighton: { days: [{ date: "2026-11-18", snow: 3 }] },  // misses 11-19 → stays Snow-Forecast
  } };
  const out = applySnowfall(feed, blend, now);
  assert.equal(out.snowfall, "tabulator");
  const [alta, pc, brighton] = out.resorts;
  assert.deepEqual(alta.days.map((d) => d.snow), [2, 21, 6]);   // projected day untouched
  assert.deepEqual(alta.days.map((d) => d.sfSnow), [0, 7, undefined]);
  assert.equal("ours" in alta.days[0], false);
  assert.equal(alta.snowfall, "tabulator");
  assert.equal(pc, feed.resorts[1]);                              // not in the blend
  assert.equal(brighton, feed.resorts[2]);                        // partial coverage
  assert.equal(applySnowfall(feed, blend, now + 40 * 3600e3), feed); // stale → unchanged
  assert.equal(applySnowfall(feed, null, now), feed);
});

test("snowfall flag: known modes only, off by default", () => {
  assert.equal(parseFlags({}).snowfall, "off");
  assert.equal(parseFlags({ snowfall: "on" }).snowfall, "on");
  assert.equal(parseFlags({ snowfall: "yes" }).snowfall, "off");
});
