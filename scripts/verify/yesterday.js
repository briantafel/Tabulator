#!/usr/bin/env node
/* What actually fell, fetched live (no upload): SNOTEL daily SWE + depth,
 * CoCoRaHS 24 h new snow + water, resort-reported new snow (OnTheSnow),
 * with each station's resort, distance and elevation. Prints one compact
 * JSON line per row ("ROW {...}") for the last few days, for quick
 * "how did we do yesterday?" checks from a sandbox that can't reach these
 * sources. Public observations only. Added 2026-11-19. */
import { readFile } from "node:fs/promises";

const root = new URL("../..", import.meta.url).pathname;
const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const app = resorts.filter((r) => !r.archiveOnly);
const since = Date.now() - 4 * 864e5;
const KEEP = new Set(["swe", "snow_depth", "new_snow_24h", "precip_24h", "reported_daily_snow"]);
for (const name of ["snotel", "cocorahs", "onthesnow"]) {
  const mod = await import(`../archive/${name}.js`);
  const rows = [];
  try {
    await mod.collect({ resorts: app, sink: { write: (r) => rows.push(r), count: 0 }, rawDir: `/tmp/y/${name}`,
      fetchedAt: new Date().toISOString(), runId: "yesterday", log: (s) => console.error(s), elevations: {} });
  } catch (e) { console.error(`${name} failed: ${e.message}`); }
  for (const r of rows) {
    const t = Date.parse(r.valid_end ?? r.valid_start ?? 0);
    const keep = r.kind === "mapping" || (KEEP.has(r.variable) && t >= since &&
      (r.source !== "snotel" || r.period_label === "daily"));
    if (!keep) continue;
    console.log("ROW " + JSON.stringify({ s: r.source, k: r.kind, r: r.resort_id, st: r.station_id, v: r.variable,
      x: r.value, vs: r.valid_start, ve: r.valid_end, el: r.elevation_m, tier: r.tier ?? null, txt: r.value_text ?? null }));
  }
  console.error(`${name}: ${rows.length} rows`);
}
