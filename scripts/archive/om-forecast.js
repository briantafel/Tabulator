/* ------------------------------------------------------------------ *
 * Open-Meteo forecast API: the three deterministic models our blend is
 * fitted on (ECMWF IFS 0.25°, GFS, GEM), as issued, once a day.
 *
 * Brian, 2026-11-16: run the blend live (blend-v1 water × our SLR) so the
 * app can show our own number. Until now these models only arrived the
 * next day via the Previous Runs API, for scoring. This is the live copy,
 * archived exactly as fetched.
 *
 * One request per resort carries all three models (2 variables × 3 models,
 * 11 days: one weighted call on the free tier), so a pass is 56 calls.
 * With several models Open-Meteo suffixes each series with the model id
 * (`precipitation_ecmwf_ifs025`); the parser requires that and fails
 * loudly if the shape changes.
 * ------------------------------------------------------------------ */

import { toBlocks } from "./ensembles.js";
import { coordsOf, fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "om-fc-1";
export const URL_BASE = "https://api.open-meteo.com/v1/forecast";
export const MODELS = ["ecmwf_ifs025", "gfs_seamless", "gem_seamless"];
export const HOURLY = ["precipitation", "temperature_2m"];
export const FORECAST_DAYS = 11;
/* 2026-11-25: ask for yesterday too. The series used to start at 00:00 UTC, so for a resort west of Greenwich the local
   "today" began mid-evening of the previous day, had under 23 hours, and the blend dropped it (dailyFromHourly). From 00 to
   ~08 UTC the blend then had no number for the sheet's today and every anchored terrain map was refused and hidden.
   The extra day only completes that local day for the blend; the archive keeps exactly the rows it always had
   (trimToFetchDay), so nothing in the scoring tables changes. */
export const PAST_DAYS = 1;
const DELAY_MS = Number(process.env.OM_DELAY_MS) || 10000;
const MIN_OK_RATIO = 0.9;

/** One multi-model response → { model: { time, precipitation[], temperature_2m[] } }. */
export function splitModels(json, models = MODELS) {
  const h = json.hourly;
  if (!h?.time?.length) throw new Error("no hourly.time in response");
  const out = {};
  for (const model of models) {
    const series = {};
    for (const v of HOURLY) {
      const key = `${v}_${model}`;
      const unit = json.hourly_units?.[key];
      if (!Array.isArray(h[key]) || unit === "undefined") continue; // model doesn't offer it: no series, not zeros
      const want = v === "precipitation" ? "mm" : "°C";
      if (unit && unit !== want) throw new Error(`${key} came back in ${unit}, expected ${want}`);
      series[v] = h[key];
    }
    if (Object.keys(series).length) out[model] = series;
  }
  if (!Object.keys(out).length) throw new Error("no <variable>_<model> series — the response shape may have changed");
  return out;
}

/** The response as it was before PAST_DAYS: only hours from 00:00 UTC of the day it was fetched. The archive and the
 *  scoring tables must not change because the blend needs a fuller local day. */
export function trimToFetchDay(json, fetchedAt) {
  const t0 = Date.parse(`${String(fetchedAt).slice(0, 10)}T00:00:00Z`);
  const times = json.hourly?.time ?? [];
  const first = times.findIndex((t) => Date.parse(`${t}Z`) >= t0);
  if (first <= 0) return json;                       // nothing before the fetch day (or all of it): unchanged
  const hourly = {};
  for (const [k, v] of Object.entries(json.hourly)) hourly[k] = Array.isArray(v) ? v.slice(first) : v;
  return { ...json, hourly };
}

/** Archive rows: 6-hour blocks (like the ensembles and Previous Runs) plus one
 *  `temp` row per hour (the lift-hours low), issued_at = fetch time (the API
 *  doesn't say which run it served). */
export function forecastToRows(fullJson, { resort, elevation, fetchedAt, runId }) {
  const json = trimToFetchDay(fullJson, fetchedAt);
  const rows = [];
  const base = { source: "open-meteo-forecast", kind: "forecast", resort_id: resort.id, tier: "mid",
    elevation_m: elevation ?? json.elevation ?? null, lat: json.latitude, lon: json.longitude,
    issued_at: fetchedAt, fetched_at: fetchedAt, run_id: runId, parser_version: PARSER_VERSION };
  for (const [model, series] of Object.entries(splitModels(json))) {
    for (const b of toBlocks(json.hourly.time, series)) {
      for (const [variable, value, unit] of b.values) {
        if (value == null) continue;
        rows.push({ ...base, valid_start: b.valid_start, valid_end: b.valid_end, variable, value, unit, model });
      }
    }
    (series.temperature_2m ?? []).forEach((v, i) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return;
      const vs = new Date(`${json.hourly.time[i]}Z`).toISOString();
      rows.push({ ...base, valid_start: vs, valid_end: new Date(Date.parse(vs) + 3600e3).toISOString(),
        variable: "temp", value: v, unit: "C", model });
    });
  }
  return rows;
}

export async function collect({ resorts: all, elevations, sink, rawDir, fetchedAt, runId, log, timing = {} }) {
  const { retryDelayMs = 5000, pauseMs = 30000, gapMs = DELAY_MS } = timing;   // timing only so tests need not wait
  const resorts = all.filter((r) => !r.archiveOnly);
  let ok = 0, tried = 0, stopped = false;
  const failures = [];
  const failedResorts = [];

  // One resort: true on success. A rate limit stops the whole run (stopped = true).
  async function one(resort, attempt) {
    const c = coordsOf(resort);
    if (!c) { failures.push(`${resort.id}: no coordinates`); return "fail"; }
    const elevation = elevations[resort.id] ?? null;
    const q = new URLSearchParams({
      latitude: c[0], longitude: c[1], models: MODELS.join(","), hourly: HOURLY.join(","),
      forecast_days: String(FORECAST_DAYS), past_days: String(PAST_DAYS), timezone: "GMT", timeformat: "iso8601",
    });
    if (elevation) q.set("elevation", String(elevation));
    try {
      const { status, text } = await fetchText(`${URL_BASE}?${q}`, { retries: 3, delayMs: retryDelayMs, retry429: false });
      if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      const rows = forecastToRows(json, { resort, elevation, fetchedAt, runId });
      await saveRaw(`${rawDir}/${resort.id}.json.gz`, text);
      rows.forEach((r) => sink.write(r));
      return "ok";
    } catch (e) {
      if (e.rateLimited) {
        failures.push(`RATE LIMITED at ${resort.id}: stopped`);
        log(`  ✗ open-meteo-forecast RATE LIMITED at ${resort.id} — stopping`);
        stopped = true;
        return "fail";                                // not retried: stop, do not hammer a rate limit
      }
      if (attempt === 1) { log(`  ! open-meteo-forecast ${resort.id} — ${e.message} (will retry once more at the end)`); return "retry"; }
      failures.push(`${resort.id}: ${e.message}`);
      log(`  ✗ open-meteo-forecast ${resort.id} — ${e.message}`);
      return "fail";
    }
  }

  for (const resort of resorts) {
    if (stopped) break;
    tried++;
    const r1 = await one(resort, 1);
    if (r1 === "ok") ok++; else if (r1 === "retry") failedResorts.push(resort);
    await sleep(gapMs);
  }
  // 2026-11-25: Open-Meteo connections time out now and then (a different 1–3 resorts per run), and a resort missing here
  // is missing from the blend and the terrain map. One more pass after a pause; only what still fails is reported.
  if (failedResorts.length && !stopped) {
    log(`open-meteo-forecast: ${failedResorts.length} resort(s) failed the first pass; retrying after ${pauseMs / 1000} s`);
    await sleep(pauseMs);
    for (const resort of failedResorts) {
      if (stopped) break;
      if ((await one(resort, 2)) === "ok") ok++;
      await sleep(gapMs);
    }
  }
  log(`open-meteo-forecast: ${ok}/${resorts.length} resorts`);
  return { ok: ok / Math.max(resorts.length, 1) >= MIN_OK_RATIO, requests: ok, tried, failures };
}
