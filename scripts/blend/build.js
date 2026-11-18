/* Build public/blend-forecast.json from today's Open-Meteo forecast pass.
 *
 *   node scripts/blend/build.js <collectOutDir> <publicDir>
 *
 * Needs public/blend.json (judged blend-v1 parameters: public models only,
 * promoted by promote-temps.yml) and public/slr.json. Without either, or
 * with fewer than 90 % of the app's resorts built, it fails loudly and
 * writes nothing — the app then simply shows no gray mark.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resortDays, localDate } from "./lib.js";
import { splitModels } from "../archive/om-forecast.js";

const [outDir, pub] = process.argv.slice(2);
if (!outDir || !pub) { console.error("usage: build.js <collectOutDir> <publicDir>"); process.exit(2); }
const root = new URL("../..", import.meta.url).pathname;
const log = (s) => console.error(s);
const readJson = async (p, d) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return d; } };
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const params = await readJson(`${pub}/blend.json`, null);
const slr = await readJson(`${pub}/slr.json`, null);
/* Calibrated bands (bands.py), only when judged and promoted; else none — the
   app then falls back to the ensemble-spread band. */
const bandsDoc = await readJson(`${pub}/bands.json`, null);
const bands = bandsDoc?.promote === true && bandsDoc.version === "bands-v1" ? bandsDoc : null;
if (!params?.weights || !params?.factors) { log("✗ public/blend.json missing or not a judged blend — nothing built"); process.exit(1); }
if (!slr?.a || !slr?.b) { log("✗ public/slr.json missing — nothing built"); process.exit(1); }
const manifest = await readJson(`${outDir}/manifest.json`, {});
const fetchedAt = manifest.fetchedAt ?? new Date().toISOString();

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const app = resorts.filter((r) => !r.archiveOnly);
const out = { generatedAt: new Date().toISOString(), fetchedAt, version: params.version ?? "blend-v1", slr: slr.version,
  bands: bands ? bands.version : null,
  models: Object.keys(params.weights[Object.keys(params.weights)[0]] ?? {}),
  note: "Our forecast: blend-v1 water (ECMWF, GFS, GEM; corrected, lead-weighted) × our snow-to-liquid ratio. cm.",
  resorts: {} };
const missed = [];
for (const r of app) {
  const p = `${outDir}/raw/open-meteo-forecast/${r.id}.json.gz`;
  if (!(await exists(p))) { missed.push(r.id); continue; }
  try {
    const json = JSON.parse(gunzipSync(await readFile(p)).toString("utf8"));
    const days = resortDays({ time: json.hourly.time, byModel: splitModels(json), tz: r.tz, region: r.region,
      issueDate: localDate(Date.parse(fetchedAt), r.tz), params, slr, resortId: r.id, bands });
    if (days.length) out.resorts[r.id] = { days };
    else missed.push(`${r.id} (no complete days)`);
  } catch (e) { missed.push(`${r.id} (${e.message})`); }
}
const n = Object.keys(out.resorts).length;
log(`blend-forecast: ${n}/${app.length} resorts${missed.length ? `; missing: ${missed.join(", ")}` : ""}`);
if (n < 0.9 * app.length) { log("✗ coverage under 90 % — not written"); process.exit(1); }
await writeFile(`${pub}/blend-forecast.json`, JSON.stringify(out) + "\n");
