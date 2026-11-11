/* Build public/temps.json: our temperature for every app resort, days 0–10.
 *
 *   node scripts/temps/build.js [publicDir]
 *
 * Runs in the archive workflow (twice a day) after the collection. Fetches
 * Open-Meteo's forecast API — hourly 2 m temperature for ECMWF, GEM and GFS,
 * the same model ids the model was fitted on (Previous Runs) — at each
 * resort's Snow-Forecast mid elevation. One request per resort (all three
 * models in it), 56 requests a run.
 *
 * Parameters come from public/temp-model.json, written from the verify run's
 * temp-model.json after it is read and approved (scripts/model/temps.py).
 * Without it: equal weights, no correction, `validated: false`.
 *
 * Loud: exits non-zero when fewer than 90% of resorts got data, so the run
 * page shows it; the app keeps Snow-Forecast for any resort-day without ours.
 */

import { readFile, writeFile } from "node:fs/promises";
import { coordsOf, fetchText, sleep } from "../archive/common.js";
import { MODELS, DAYS, dailyFromHourly, blendResort } from "./lib.js";

const root = new URL("../..", import.meta.url).pathname;
const pub = process.argv[2] ?? `${root}public`;
const readJson = async (p, f) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return f; } };

const resorts = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8")).resorts.filter((r) => !r.archiveOnly);
const elevations = await readJson(`${root}src/data/sf-elevations.json`, {});
const params = await readJson(`${pub}/temp-model.json`, null);
const localDate = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const out = {
  generatedAt: new Date().toISOString(),
  version: params?.version ?? "equal-weights",
  validated: !!params,
  units: { temp: "C" },
  models: MODELS,
  method: "weighted mean of hourly model temperature at the Snow-Forecast mid elevation; liftLo = coldest 08:00–16:00 local",
  resorts: {},
};
const failed = [];
for (const r of resorts) {
  const c = coordsOf(r);
  if (!c) { failed.push(`${r.id}: no coordinates`); continue; }
  const q = new URLSearchParams({
    latitude: c[0], longitude: c[1], hourly: "temperature_2m", models: MODELS.join(","),
    forecast_days: String(DAYS + 1), timezone: r.tz, timeformat: "iso8601",
  });
  if (elevations[r.id]) q.set("elevation", String(elevations[r.id]));
  try {
    const { status, text } = await fetchText(`https://api.open-meteo.com/v1/forecast?${q}`, { retries: 2, delayMs: 4000 });
    if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 160)}`);
    const j = JSON.parse(text);
    const perModel = {};
    for (const m of MODELS) {
      const unit = j.hourly_units?.[`temperature_2m_${m}`];
      if (unit && unit !== "°C") throw new Error(`${m} temperature in ${unit}`);
      const series = j.hourly?.[`temperature_2m_${m}`];
      if (series) perModel[m] = dailyFromHourly(j.hourly.time, series);
    }
    const days = blendResort(perModel, { resortId: r.id, issueDate: localDate(r.tz), params });
    if (!days.length) throw new Error("no complete days");
    out.resorts[r.id] = { elevation: elevations[r.id] ?? null, days: days.slice(0, DAYS) };
  } catch (e) {
    failed.push(`${r.id}: ${e.message}`);
  }
  await sleep(300);
}
await writeFile(`${pub}/temps.json`, JSON.stringify(out) + "\n");
const ok = Object.keys(out.resorts).length;
console.error(`temps: ${ok}/${resorts.length} resorts (${out.validated ? out.version : "UNVALIDATED equal weights"})`);
for (const f of failed) console.error(`  ✗ ${f}`);
if (ok < 0.9 * resorts.length) process.exit(1);
