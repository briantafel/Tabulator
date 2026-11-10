/* Build public/projections.json and public/calibration.json from one
 * archive run.
 *
 *   node scripts/projections/build.js <archiveOutDir> [publicDir]
 *
 * Reads the raw ensemble responses the archive collector just saved
 * (<out>/raw/open-meteo-ensemble/<resort>-<model>.json.gz), the app's own
 * Snow-Forecast file (public/forecast.json) and the previous calibration.
 * Writes both files; never touches anything else. A resort with no
 * ensemble data is simply absent — the app treats absent as "no
 * projection", never as zero snow. See lib.js for the reasoning.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  dailyByMember, pool, summarize, runEvidence, learn, correct, projectionDates, PROJECTION_DAYS, EWMA_ALPHA,
} from "./lib.js";

const MODELS = ["ecmwf_ifs025", "gfs025"];
const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
const pub = process.argv[3] ?? `${root}public`;
if (!outDir) { console.error("usage: build.js <archiveOutDir> [publicDir]"); process.exit(2); }

const log = (s) => console.error(s);
const exists = (p) => access(p).then(() => true, () => false);
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } };

const resorts = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8")).resorts
  .filter((r) => !r.archiveOnly); // projections feed the app; archiveOnly resorts are not in it
const forecast = await readJson(`${pub}/forecast.json`, null);
if (!forecast?.resorts?.length) { log("no public/forecast.json — nothing to calibrate against"); process.exit(1); }
if (forecast.synthetic) { log("forecast.json is sample data — refusing to learn from it"); process.exit(1); }
const sfById = Object.fromEntries(forecast.resorts.map((r) => [r.id, r]));
const prevCal = await readJson(`${pub}/calibration.json`, { resorts: {} });

const generatedAt = new Date().toISOString();
const projections = { generatedAt, sfGeneratedAt: forecast.generatedAt, days: PROJECTION_DAYS,
  units: { snow: "cm", temp: "C", wind: "km/h" }, models: MODELS, resorts: {} };
const calibration = { updatedAt: generatedAt, method: `EWMA α=${EWMA_ALPHA} of per-run medians; wind = SF ÷ ensemble, temp = SF − ensemble`,
  // Resorts missing from this run keep what they had learned.
  resorts: { ...(prevCal.resorts ?? {}) } };

let built = 0, skipped = [];
for (const resort of resorts) {
  const sf = sfById[resort.id];
  const tz = resort.tz;
  if (!sf || !tz) { skipped.push(`${resort.id}: ${!sf ? "not in forecast.json" : "no tz"}`); continue; }

  const byModel = {};
  for (const model of MODELS) {
    const p = `${outDir}/raw/open-meteo-ensemble/${resort.id}-${model}.json.gz`;
    if (!(await exists(p))) continue;
    try {
      byModel[model] = dailyByMember(JSON.parse(gunzipSync(await readFile(p)).toString("utf8")), tz);
    } catch (e) { log(`  ✗ ${resort.id}/${model}: ${e.message}`); }
  }
  if (!Object.keys(byModel).length) { skipped.push(`${resort.id}: no ensemble data`); continue; }

  const pooled = pool(byModel);
  const summary = new Map([...pooled].map(([d, p]) => [d, summarize(p)]));

  // Learn: this run's SF-vs-ensemble gap, folded into the running correction.
  const ev = runEvidence(sf.days, summary);
  const cal = learn(prevCal.resorts?.[resort.id], ev);
  calibration.resorts[resort.id] = { ...cal, lastRun: ev };

  // Project: the days after Snow-Forecast's horizon, corrected.
  const sfDates = sf.days.map((d) => d.date);
  const dates = projectionDates(sfDates, summary);
  if (!dates.length) { skipped.push(`${resort.id}: no ensemble days past ${sfDates.at(-1)}`); continue; }

  /* Per-member snow for the projected dates, kept so the app can add a trip's
     days up member by member — summing daily percentiles would overstate the
     range. Rounded to 0.1 cm; ~80 members × 4 days per resort. */
  const members = {};
  for (const [model, perMember] of Object.entries(byModel)) {
    members[model] = [...perMember.values()].map((perDay) => dates.map((d) => {
      const v = perDay.get(d)?.snow; return v == null ? null : Math.round(v * 10) / 10;
    }));
  }

  /* The ensemble's snow spread on Snow-Forecast's own days, so the app can
     draw likely/possible bands around SF's number for days 1–6. Spread only:
     the app centres it on SF's value, never on the ensemble median. */
  const spread = {};
  for (const date of sfDates) {
    const s = summary.get(date)?.snow;
    if (s) spread[date] = s;
  }

  projections.resorts[resort.id] = {
    days: dates.map((date) => ({ date, ...correct(summary.get(date), cal) })),
    spread,
    members,
  };
  built++;
}

await writeFile(`${pub}/projections.json`, JSON.stringify(projections));
await writeFile(`${pub}/calibration.json`, `${JSON.stringify(calibration, null, 1)}\n`);
log(`projections: ${built}/${resorts.length} resorts`);
for (const s of skipped) log(`  · ${s}`);
if (!built) process.exit(1);
