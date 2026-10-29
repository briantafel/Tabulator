#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One-time: the last two winters of model forecasts and SNOTEL truth,
 * so accuracy analysis can start now instead of after this season.
 *
 *   node scripts/archive/backfill-models.js <outDir>
 *
 * 1. Open-Meteo Previous Runs API — what ECMWF and GFS forecast for each
 *    past hour from the runs 0–7 days before it. Hourly snowfall,
 *    precipitation and temperature at every resort, Nov–Apr of 2024-25 and
 *    2025-26, stored as 6-hour blocks per lead time. Raw responses kept.
 * 2. SNOTEL daily history for the stations near each US resort, same two
 *    winters.
 *
 * Writes <outDir>/<yyyy-mm>/<source>.ndjson.gz by valid month, for
 * to_parquet.py, and raw responses under <outDir>/raw/.
 *
 * PACED ON PURPOSE. Open-Meteo's free tier counts a request with many
 * variables and a long date range as many calls, against an hourly and a
 * daily limit. Each request here is one resort, one model, one winter,
 * 24 series; they go out ~25 s apart so the run stays under the hourly
 * limit. Expect a bit over an hour.
 * ------------------------------------------------------------------ */

import { readFile, mkdir } from "node:fs/promises";
import { coordsOf, fetchText, rowSink, saveRaw, sleep } from "./common.js";
import { toBlocks } from "./ensembles.js";
import { dataToRows, pickStations } from "./snotel.js";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
if (!outDir) { console.error("usage: backfill-models.js <outDir>"); process.exit(2); }

const WINTERS = [["2024-11-01", "2025-04-30"], ["2025-11-01", "2026-04-30"]];
const MODELS = ["ecmwf_ifs025", "gfs_seamless"];
const VARS = ["snowfall", "precipitation", "temperature_2m"];
const LEADS = [0, 1, 2, 3, 4, 5, 6, 7];
const OM = "https://previous-runs-api.open-meteo.com/v1/forecast";
const SNOTEL = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const OM_DELAY_MS = 25000;
const PV = "om-prev-1";
const runId = "backfill-models";
const fetchedAt = new Date().toISOString();
const log = (s) => console.error(s);

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
let elevations = {};
try {
  const f = JSON.parse(await readFile(`${root}public/forecast.json`, "utf8"));
  elevations = Object.fromEntries(f.resorts.map((r) => [r.id, r.elevation?.mid]));
} catch { /* no forecast file — Open-Meteo picks its own elevation */ }

const sinks = new Map();
async function sinkFor(source, iso) {
  const key = `${iso.slice(0, 7)}/${source}`;
  if (!sinks.has(key)) sinks.set(key, await rowSink(`${outDir}/${key}.ndjson.gz`));
  return sinks.get(key);
}
async function write(source, rows) {
  for (const r of rows) (await sinkFor(source, r.valid_start)).write(r);
}

/** One Previous Runs response → rows. A series is `<var>` (lead 0) or
 *  `<var>_previous_day<N>`. Lead time is not a column; issued_at is set to
 *  valid_start minus N days (approximate) and period_label keeps the
 *  source's own label, so the lead is exact in one and usable in the other. */
export function previousRunsToRows(json, { resort, model, elevation }) {
  const h = json.hourly;
  if (!h?.time?.length) throw new Error("no hourly.time in response");
  const want = { snowfall: "cm", precipitation: "mm", temperature_2m: "°C" };
  for (const [k, u] of Object.entries(json.hourly_units ?? {})) {
    const base = k.replace(/_previous_day\d+$/, "");
    if (want[base] && u !== "undefined" && u !== want[base]) throw new Error(`${k} came back in ${u}, expected ${want[base]}`);
  }
  const byLead = new Map();
  for (const [key, series] of Object.entries(h)) {
    const m = key.match(/^([a-z0-9_]+?)(?:_previous_day(\d+))?$/);
    if (!m || !VARS.includes(m[1])) continue;
    if (json.hourly_units?.[key] === "undefined") continue;
    const lead = m[2] ? Number(m[2]) : 0;
    if (!byLead.has(lead)) byLead.set(lead, {});
    // toBlocks reads Open-Meteo's own variable names.
    byLead.get(lead)[m[1]] = series;
  }
  if (![...byLead.keys()].some((l) => l > 0)) throw new Error("no _previous_dayN series — the response shape may have changed");
  const rows = [];
  for (const [lead, series] of byLead) {
    for (const b of toBlocks(h.time, series)) {
      for (const [variable, value, unit] of b.values) {
        if (value == null) continue;
        rows.push({
          source: "open-meteo-previous-runs", kind: "forecast", resort_id: resort.id, tier: "mid",
          elevation_m: elevation ?? json.elevation ?? null, lat: json.latitude, lon: json.longitude,
          issued_at: new Date(Date.parse(b.valid_start) - lead * 86400e3).toISOString(),
          fetched_at: fetchedAt, valid_start: b.valid_start, valid_end: b.valid_end,
          period_label: lead ? `previous_day${lead}` : "previous_day0",
          variable, value, unit, model, run_id: runId, parser_version: PV,
        });
      }
    }
  }
  return rows;
}

let failures = 0;

// ---- 1. Open-Meteo previous runs -----------------------------------------
const hourly = VARS.flatMap((v) => LEADS.map((l) => (l ? `${v}_previous_day${l}` : v))).join(",");
const jobs = resorts.flatMap((r) => MODELS.flatMap((model) => WINTERS.map((w) => [r, model, w])));
log(`open-meteo previous runs: ${jobs.length} requests, ~${Math.round((jobs.length * OM_DELAY_MS) / 60000)} min`);
let omRows = 0, omOk = 0;
for (const [i, [resort, model, [start, end]]] of jobs.entries()) {
  const c = coordsOf(resort);
  if (!c) { log(`  · ${resort.id}: no coordinates`); continue; }
  const q = new URLSearchParams({ latitude: c[0], longitude: c[1], models: model, hourly,
    start_date: start, end_date: end, timezone: "GMT", timeformat: "iso8601" });
  if (elevations[resort.id]) q.set("elevation", String(elevations[resort.id]));
  try {
    const { status, text } = await fetchText(`${OM}?${q}`, { retries: 3, delayMs: 10000 });
    if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
    await saveRaw(`${outDir}/raw/open-meteo-previous-runs/${resort.id}-${model}-${start.slice(0, 4)}.json.gz`, text);
    const rows = previousRunsToRows(JSON.parse(text), { resort, model, elevation: elevations[resort.id] });
    await write("open-meteo-previous-runs", rows);
    omRows += rows.length; omOk++;
    log(`  ✓ ${i + 1}/${jobs.length} ${resort.id} ${model} ${start.slice(0, 4)}-${end.slice(2, 4)}: ${rows.length} rows`);
  } catch (e) {
    failures++;
    log(`  ✗ ${i + 1}/${jobs.length} ${resort.id} ${model} ${start.slice(0, 4)} — ${e.message}`);
    // A rejected request shape fails every request the same way; stop early rather than spend an hour on it.
    if (omOk === 0 && failures >= 3) { log("first three requests failed — stopping the Open-Meteo part"); break; }
  }
  await sleep(OM_DELAY_MS);
}

// ---- 2. SNOTEL daily history ----------------------------------------------
let snRows = 0;
try {
  const st = await fetchText(`${SNOTEL}/stations?stationTriplets=*:*:SNTL`);
  if (st.status !== 200) throw new Error(`stations HTTP ${st.status}`);
  const picks = pickStations(JSON.parse(st.text), resorts);
  const stationsById = new Map(picks.map((p) => [p.station.stationTriplet, p.station]));
  const ids = [...stationsById.keys()];
  for (const [start, end] of WINTERS) {
    for (let i = 0; i < ids.length; i += 20) {
      const q = new URLSearchParams({ stationTriplets: ids.slice(i, i + 20).join(","),
        elements: "SNWD,WTEQ,TOBS,PREC", duration: "DAILY", beginDate: start, endDate: end });
      const res = await fetchText(`${SNOTEL}/data?${q}`, { retries: 3 });
      if (res.status !== 200) throw new Error(`data HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      await mkdir(`${outDir}/raw/snotel-history`, { recursive: true });
      await saveRaw(`${outDir}/raw/snotel-history/${start.slice(0, 4)}-${i / 20}.json.gz`, res.text);
      const rows = dataToRows(JSON.parse(res.text), { stationsById, duration: "DAILY", fetchedAt, runId })
        .map((r) => ({ ...r, parser_version: "snotel-history-1" }));
      await write("snotel", rows);
      snRows += rows.length;
      await sleep(2000);
    }
  }
  log(`snotel history: ${ids.length} stations, ${snRows} readings`);
} catch (e) {
  failures++;
  log(`  ✗ snotel history — ${e.message}`);
}

for (const s of sinks.values()) await s.close();
log(`\nbackfill: open-meteo ${omOk}/${jobs.length} requests, ${omRows} rows; snotel ${snRows} rows`);
if (!omRows || !snRows || omOk / jobs.length < 0.9) process.exit(1);
