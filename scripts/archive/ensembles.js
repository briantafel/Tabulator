/* ------------------------------------------------------------------ *
 * Open-Meteo ensembles: every member of two global ensembles, for every
 * resort, out to 16 days.
 *
 * The spread between members is the archive's confidence signal from day
 * one, before any history exists to measure Snow-Forecast's own errors.
 *
 * Open-Meteo answers hourly. The raw JSON (hourly, every member) is kept;
 * the archive rows are 6-hour blocks (00/06/12/18 UTC), which is ~6x
 * smaller and loses little for snow totals. A block is written only when
 * all six of its hours are present: a partial sum would read as less snow.
 *
 * Each request passes the resort's Snow-Forecast mid-tier elevation, so
 * Open-Meteo downscales temperature (and so snow vs rain) to the same
 * height the spine forecast is for.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "om-ens-2"; // 2: SLR predictors
const URL_BASE = "https://ensemble-api.open-meteo.com/v1/ensemble";
export const MODELS = ["ecmwf_ifs025", "gfs025"];
export const BASE_HOURLY = ["snowfall", "precipitation", "temperature_2m", "freezing_level_height", "wind_speed_10m"];
/* Snow-to-liquid predictors, added 2026-11-10 (claude/us-snow-research-plan.md:
   700 hPa temperature + wind explain most SLR variance at Alta; direction
   matters for orographic lift). A model that lacks one answers "undefined"
   and it is skipped like freezing level is for ECMWF. If Open-Meteo rejects
   the whole request, collect() retries with BASE_HOURLY so a run is never
   lost to these extras. */
export const SLR_HOURLY = ["relative_humidity_2m", "wind_direction_10m", "temperature_700hPa",
  "wind_speed_700hPa", "wind_direction_700hPa", "relative_humidity_700hPa"];
export const HOURLY = [...BASE_HOURLY, ...SLR_HOURLY];
const UNITS = { snowfall: "cm", precipitation: "mm", temperature_2m: "°C", freezing_level_height: "m", wind_speed_10m: "km/h",
  relative_humidity_2m: "%", wind_direction_10m: "°", temperature_700hPa: "°C", wind_speed_700hPa: "km/h",
  wind_direction_700hPa: "°", relative_humidity_700hPa: "%" };
const BLOCK_H = 6;
const DELAY_MS = 2000;   // responses are large; 0.4s apart dropped connections (2026-10-29)
const MIN_OK_RATIO = 0.8;

/** Hourly series → 6-hour blocks. `time` is ISO in UTC without a zone.
 *  An hour's value describes the hour ENDING at its timestamp (Open-Meteo's
 *  "preceding hour sum"), so it belongs to the block that contains t − 1h. */
export function toBlocks(time, series) {
  const blocks = new Map();
  time.forEach((t, i) => {
    const ms = Date.parse(`${t}Z`) - 3600e3;
    const start = Math.floor(ms / (BLOCK_H * 3600e3)) * BLOCK_H * 3600e3;
    if (!blocks.has(start)) blocks.set(start, []);
    blocks.get(start).push(i);
  });
  const out = [];
  for (const [start, idx] of blocks) {
    if (idx.length !== BLOCK_H) continue;
    const vals = (name) => idx.map((i) => series[name]?.[i]);
    const full = (a) => a.every((v) => typeof v === "number" && Number.isFinite(v));
    const sum = (a) => (full(a) ? Number(a.reduce((x, y) => x + y, 0).toFixed(3)) : null);
    const min = (a) => (full(a) ? Math.min(...a) : null);
    const max = (a) => (full(a) ? Math.max(...a) : null);
    const mean = (a) => (full(a) ? Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)) : null);
    /* Mean direction of the wind vectors, weighted by speed; 0–360. */
    const dirMean = (d, sp) => {
      if (!full(d) || !full(sp)) return null;
      let u = 0, v = 0;
      d.forEach((deg, i) => { const r = (deg * Math.PI) / 180; u += sp[i] * Math.sin(r); v += sp[i] * Math.cos(r); });
      if (Math.hypot(u, v) < 1e-9) return null; // calm: no direction
      return Number((((Math.atan2(u, v) * 180) / Math.PI + 360) % 360).toFixed(1));
    };
    out.push({
      valid_start: new Date(start).toISOString(),
      valid_end: new Date(start + BLOCK_H * 3600e3).toISOString(),
      values: [
        ["snow", sum(vals("snowfall")), "cm"],
        ["precip", sum(vals("precipitation")), "mm"],
        ["temp_min", min(vals("temperature_2m")), "C"],
        ["temp_max", max(vals("temperature_2m")), "C"],
        ["freezing_level_min", min(vals("freezing_level_height")), "m"],
        ["wind_speed_max", max(vals("wind_speed_10m")), "km/h"],
        ["rh_2m_mean", mean(vals("relative_humidity_2m")), "%"],
        ["wind_dir_10m_mean", dirMean(vals("wind_direction_10m"), vals("wind_speed_10m")), "deg"],
        ["temp_700_mean", mean(vals("temperature_700hPa")), "C"],
        ["temp_700_min", min(vals("temperature_700hPa")), "C"],
        ["wind_speed_700_mean", mean(vals("wind_speed_700hPa")), "km/h"],
        ["wind_dir_700_mean", dirMean(vals("wind_direction_700hPa"), vals("wind_speed_700hPa")), "deg"],
        ["rh_700_mean", mean(vals("relative_humidity_700hPa")), "%"],
      ],
    });
  }
  return out;
}

/** One Open-Meteo response → archive rows. Member 0 is the control run,
 *  which Open-Meteo returns under the bare variable name. */
export function responseToRows(json, { resort, model, elevation, fetchedAt, runId }) {
  const h = json.hourly;
  if (!h?.time?.length) throw new Error("no hourly.time in response");
  /* A model that does not offer a variable answers with the unit string
     "undefined" (2026-10-29: the ECMWF ensemble has no freezing level). That
     variable is skipped — missing is no row — rather than failing the rest. */
  const unavailable = new Set();
  for (const [v, u] of Object.entries(UNITS)) {
    const got = json.hourly_units?.[v];
    if (got === "undefined") { unavailable.add(v); continue; }
    if (got && got !== u) throw new Error(`${v} came back in ${got}, expected ${u}`);
  }

  const members = new Map(); // member number → { variable: series }
  for (const [key, series] of Object.entries(h)) {
    const m = key.match(/^([A-Za-z0-9_]+?)(?:_member(\d+))?$/);
    if (!m || !HOURLY.includes(m[1]) || unavailable.has(m[1])) continue;
    const n = m[2] ? Number(m[2]) : 0;
    if (!members.has(n)) members.set(n, {});
    members.get(n)[m[1]] = series;
  }
  if (members.size < 2) throw new Error(`only ${members.size} member(s) found — the response shape may have changed`);

  const [lat, lon] = [json.latitude, json.longitude];
  const rows = [];
  for (const [member, series] of members) {
    for (const b of toBlocks(h.time, series)) {
      for (const [variable, value, unit] of b.values) {
        if (value == null) continue;
        rows.push({
          source: "open-meteo-ensemble", kind: "forecast", resort_id: resort.id, tier: "mid",
          elevation_m: elevation ?? json.elevation ?? null, lat, lon,
          fetched_at: fetchedAt, valid_start: b.valid_start, valid_end: b.valid_end,
          variable, value, unit, model, member, run_id: runId, parser_version: PARSER_VERSION,
        });
      }
    }
  }
  return { rows, members: members.size, unavailable: [...unavailable] };
}

export async function collect({ resorts, elevations, sink, rawDir, fetchedAt, runId, log }) {
  let ok = 0, tried = 0;
  const failures = [];
  const unavailable = {}; // model → variables it does not offer
  const extrasRefused = {}; // model → Open-Meteo's 400 text for the SLR variables
  for (const resort of resorts) {
    const c = coordsOf(resort);
    if (!c) { failures.push(`${resort.id}: no coordinates`); continue; }
    const elevation = elevations[resort.id] ?? null;
    for (const model of MODELS) {
      tried++;
      const query = (hourly) => {
        const q = new URLSearchParams({
          latitude: c[0], longitude: c[1], models: model, hourly: hourly.join(","),
          forecast_days: "16", timezone: "GMT", timeformat: "iso8601",
        });
        if (elevation) q.set("elevation", String(elevation));
        return `${URL_BASE}?${q}`;
      };
      try {
        let { status, text } = await fetchText(query(HOURLY), { retries: 3, delayMs: 5000 });
        if (status === 400) {
          // The SLR extras were refused: keep the run, say so loudly.
          log(`  ✗ open-meteo ${resort.id}/${model} refused the SLR variables (${text.slice(0, 160)}) — retrying without them`);
          extrasRefused[model] = text.slice(0, 160);
          ({ status, text } = await fetchText(query(BASE_HOURLY), { retries: 3, delayMs: 5000 }));
        }
        if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
        await saveRaw(`${rawDir}/${resort.id}-${model}.json.gz`, text);
        const out = responseToRows(JSON.parse(text), { resort, model, elevation, fetchedAt, runId });
        out.rows.forEach((r) => sink.write(r));
        if (out.unavailable.length) unavailable[model] = out.unavailable;
        ok++;
      } catch (e) {
        failures.push(`${resort.id}/${model}: ${e.message}`);
        log(`  ✗ open-meteo ${resort.id}/${model} — ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
  }
  log(`open-meteo-ensemble: ${ok}/${tried} requests`);
  for (const [m, vars] of Object.entries(unavailable)) log(`  · ${m} does not offer: ${vars.join(", ")}`);
  for (const [m, why] of Object.entries(extrasRefused)) failures.push(`${m}: SLR variables refused — ${why}`);
  return { ok: tried > 0 && ok / tried >= MIN_OK_RATIO, requests: ok, tried, failures, unavailable, extrasRefused };
}
