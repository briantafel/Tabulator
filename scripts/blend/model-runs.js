/* Has any model the blend uses issued a run since the last blend? (2026-11-22, Brian: blend every ~3 h, timed to model updates.)
 *
 *   node scripts/blend/model-runs.js <prevBlendJson> <outJson>      -> prints new=true|false (and GITHUB_OUTPUT)
 *
 * The blend's three models issue a run every 6-12 h, so a blend every 3 h would mostly re-fetch the same runs. The workflow
 * wakes every 3 h and this decides whether there is anything to build. Each model's newest run (Open-Meteo's own
 * meta.json: last_run_initialisation_time) is compared with the ones stored in the last blend-forecast.json.
 * Fails open, never quiet: a model whose meta can't be read counts as NEW (a redundant blend costs minutes; a skipped
 * one shows a stale forecast), and the reason is printed. */
import { readFile, writeFile, appendFile } from "node:fs/promises";

export const META_MODELS = { ecmwf_ifs025: "ecmwf_ifs025", gfs: "ncep_gfs025", gem: "cmc_gem_gdps" };

/** prev/cur: {model: isoInit|null}. Returns {changed:[models], reasons:[...]}; null/missing current counts as changed. */
export function compare(prev, cur) {
  const changed = [], reasons = [];
  for (const m of Object.keys(META_MODELS)) {
    if (!cur?.[m]) { changed.push(m); reasons.push(`${m}: could not read its latest run, counted as new`); }
    else if (cur[m] !== prev?.[m]) { changed.push(m); reasons.push(`${m}: ${prev?.[m] ?? "none stored"} -> ${cur[m]}`); }
  }
  return { changed, reasons };
}

async function latest(id) {
  const r = await fetch(`https://api.open-meteo.com/data/${id}/static/meta.json`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const t = j.last_run_initialisation_time;   // unix seconds
  if (!Number.isFinite(t)) throw new Error("no last_run_initialisation_time");
  return new Date(t * 1000).toISOString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [prevPath, outPath] = process.argv.slice(2);
  let prev = {};
  try { prev = JSON.parse(await readFile(prevPath, "utf8")).modelRuns ?? {}; } catch { /* first run: everything is new */ }
  const cur = {};
  for (const [m, id] of Object.entries(META_MODELS)) {
    try { cur[m] = await latest(id); } catch (e) { cur[m] = null; console.error(`::warning::${m} (${id}): ${e.message}`); }
  }
  const { changed, reasons } = compare(prev, cur);
  console.error(reasons.length ? `new model runs:\n  ${reasons.join("\n  ")}` : "no model has a new run since the last blend");
  await writeFile(outPath, JSON.stringify(cur));
  const line = `new=${changed.length > 0}\n`;
  process.stdout.write(line);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
}
