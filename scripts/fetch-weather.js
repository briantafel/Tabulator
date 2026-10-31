#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Fetches the National Weather Service forecast for every US resort and
 * writes public/weather.json — the daily row in the resort sheet.
 *
 * ON THE MOUNTAIN, NOT THE TOWN. NWS is not a place-name API: you hand
 * /points/{lat},{lon} a coordinate and it answers for the ~2.5km grid cell
 * that coordinate falls in. Each resort's `nws` point in resorts.json sits
 * mid-slope. The forecast response reports the elevation of the grid cell it
 * describes, and this script checks it against the base elevation that the
 * Snow-Forecast scrape reads off the resort's own page: a cell below the
 * base is a valley or a town, and that resort is rejected rather than shown.
 *
 * Same manners as the other scrapes: one request at a time, an honest
 * User-Agent (NWS asks for a contact), and FAIL LOUDLY — a run where too few
 * resorts come back exits non-zero so the Action goes red.
 *
 * Run after the forecast scrape, which it reads for the elevations.
 * ------------------------------------------------------------------ */

import { readFile, writeFile } from "node:fs/promises";
import { ECCC, ecccPeriods, ecccAlerts, pointBox } from "./eccc.js";

const API = "https://api.weather.gov";
const UA = "Tabulator/1.0 (personal ski-trip planner; github.com/briantafel/Tabulator)";
const DELAY_MS = 1000;
const RETRIES = 3;
const MIN_OK_RATIO = 0.8;
/* A grid cell averages 2.5km of terrain, so on a narrow mountain it can sit a
   little under the lifts' bottom station and still be the mountain. This is
   how far under the base it may sit before it reads as the valley. */
const BASE_SLACK_M = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL("..", import.meta.url).pathname;

/* NWS's gridpoint endpoints return a 500 now and then that clears on a
   retry; that is ordinary for this API, not a failure worth a red run. */
async function getJson(url) {
  let last;
  for (let a = 0; a <= RETRIES; a++) {
    if (a) await sleep(DELAY_MS * 2 * a);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { last = e; }
  }
  throw new Error(`${url}: ${last.message}`);
}

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const forecast = JSON.parse(await readFile(`${root}public/forecast.json`, "utf8"));
const elevation = Object.fromEntries(forecast.resorts.map((r) => [r.id, r.elevation ?? {}]));

const wanted = resorts.filter((r) => Array.isArray(r.nws));
const out = {};
const failed = [];
let misplaced = 0;

for (const [i, r] of wanted.entries()) {
  if (i) await sleep(DELAY_MS);
  const [lat, lon] = r.nws;
  try {
    const point = await getJson(`${API}/points/${lat},${lon}`);
    const url = point?.properties?.forecast;
    if (!url) throw new Error("no forecast URL for this point");
    await sleep(DELAY_MS);
    const fc = await getJson(url);
    const props = fc?.properties ?? {};

    const gridM = typeof props.elevation?.value === "number" ? Math.round(props.elevation.value) : null;
    const base = elevation[r.id]?.bot;
    if (gridM != null && typeof base === "number" && gridM < base - BASE_SLACK_M) {
      misplaced++;
      throw new Error(`grid cell is at ${gridM}m, below the ${base}m base — that is the valley, not the mountain; move the point uphill`);
    }

    const periods = (props.periods ?? []).map((p) => ({
      name: p.name,
      isDaytime: p.isDaytime,
      temperature: p.temperatureUnit === "C" ? Math.round((p.temperature * 9) / 5 + 32) : p.temperature,
      shortForecast: p.shortForecast,
      /* The full sentence — "New snow accumulation of 4 to 8 inches
         possible." The radar read-out quotes conditions from it; the resort
         sheet still reads only shortForecast. */
      detailedForecast: p.detailedForecast,
      startTime: p.startTime,
    }));
    if (!periods.length) throw new Error("forecast has no periods");

    /* Winter storm watches and warnings for this point. Optional: a failure
       here costs the resort its alerts, never its forecast. */
    let alerts = [];
    try {
      await sleep(DELAY_MS);
      const al = await getJson(`${API}/alerts/active?point=${lat},${lon}`);
      alerts = (al?.features ?? [])
        .map((f) => f.properties ?? {})
        .filter((a) => /winter|snow|blizzard|ice|avalanche/i.test(a.event ?? ""))
        .map((a) => ({ event: a.event, headline: a.headline, onset: a.onset, ends: a.ends ?? a.expires }));
    } catch (e) {
      console.error(`${r.id.padEnd(16)} alerts skipped — ${e.message}`);
    }

    const rel = point.properties.relativeLocation?.properties;
    out[r.id] = {
      point: [lat, lon],
      gridElevationM: gridM,
      near: rel ? `${rel.city}, ${rel.state}` : null,
      // The forecast office that covers this mountain — which Area Forecast
      // Discussion the radar read-out reads. Looked up, never guessed.
      office: point.properties.gridId ?? null,
      periods,
      alerts,
    };
    console.error(`${r.id.padEnd(16)} ok  grid ${gridM ?? "?"}m  (base ${base ?? "?"}m, top ${elevation[r.id]?.top ?? "?"}m)`);
  } catch (e) {
    failed.push(`${r.id}: ${e.message}`);
    console.error(`${r.id.padEnd(16)} FAILED — ${e.message}`);
  }
}

/* ---- Canada: Environment and Climate Change Canada (see eccc.js) ----
   Same entry shape as the NWS ones, so nothing downstream needs to know.
   Kept out of the NWS success ratio: a bad night at one agency should not
   decide whether the other's forecasts are written. */
const canadian = resorts.filter((r) => r.eccc && Array.isArray(r.latlon));
let ecccOk = 0;
for (const r of canadian) {
  await sleep(DELAY_MS);
  try {
    const page = await getJson(`${ECCC}/collections/citypageweather-realtime/items/${r.eccc.site}?f=json&lang=en`);
    const periods = ecccPeriods(page, r.tz);
    if (!periods.length) throw new Error(`no forecast periods for ${r.eccc.site}`);
    let alerts = [];
    try {
      await sleep(DELAY_MS);
      const al = await getJson(`${ECCC}/collections/weather-alerts/items?f=json&lang=en&bbox=${pointBox(r.latlon)}`);
      alerts = ecccAlerts(al?.features);
    } catch (e) {
      console.error(`${r.id.padEnd(16)} alerts skipped — ${e.message}`);
    }
    out[r.id] = {
      point: r.latlon,
      source: "eccc",
      near: `${r.eccc.name} (Environment Canada)`,
      office: null,
      periods,
      alerts,
    };
    ecccOk++;
    console.error(`${r.id.padEnd(16)} ok  Environment Canada, ${r.eccc.name} (${r.eccc.site}), ${alerts.length} winter alert(s)`);
  } catch (e) {
    console.error(`${r.id.padEnd(16)} FAILED (Environment Canada) — ${e.message}`);
  }
}

const ok = Object.keys(out).length - ecccOk;
if (failed.length) {
  console.error(`\n${failed.length} failed:`);
  for (const f of failed) console.error(`  ${f}`);
}

/* Too few back means NWS itself is having a bad night: leave the last good
   file alone rather than ship a thinner one. Enough back, and the file is
   written even if a point or two failed — those resorts simply have no row
   until the next run. */
if (ok / wanted.length < MIN_OK_RATIO) {
  console.error(`\nonly ${ok}/${wanted.length} resorts — public/weather.json left as it was`);
  process.exit(1);
}

await writeFile(`${root}public/weather.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: "api.weather.gov + api.weather.gc.ca",
  note: "US resorts: National Weather Service, for a point on each mountain. Canadian resorts: Environment and Climate Change Canada, for the nearest forecast town; alerts for the resort's own point.",
  resorts: out,
}, null, 1));
console.error(`\nwrote public/weather.json — ${ok}/${wanted.length} US resorts, ${ecccOk}/${canadian.length} Canadian`);

/* A point in the valley is a mistake in resorts.json, not a bad night at
   NWS, so it turns the run red on its own until the point is moved. */
if (misplaced) process.exit(1);
