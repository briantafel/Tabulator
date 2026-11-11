#!/usr/bin/env node
/* Run ONE archive source on its own and print what it would archive, without
 * uploading anything: node scripts/archive/try-source.js <module> [outDir].
 * For testing a new collector on GitHub's runners (the sandbox cannot reach
 * most sources) without running the whole archive or spending Open-Meteo
 * calls. Added 2026-11-11. */
import { readFile } from "node:fs/promises";
import { rowSink } from "./common.js";

const name = process.argv[2];
const out = process.argv[3] ?? "try-out";
if (!name) { console.error("usage: try-source.js <module> [outDir]"); process.exit(2); }
const mod = await import(`./${name}.js`);
const root = new URL("../..", import.meta.url).pathname;
const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const fetchedAt = new Date().toISOString();
const rows = [];
const sink = await rowSink(`${out}/rows/${name}.ndjson.gz`);
const wrap = { write: (r) => { rows.push(r); sink.write(r); }, get count() { return sink.count; } };
const log = (s) => console.error(s);
const t = Date.now();
const res = await mod.collect({ resorts, sink: wrap, rawDir: `${out}/raw/${name}`, fetchedAt, runId: "try", log });
await sink.close();
const by = {};
for (const r of rows) {
  const k = `${r.kind}/${r.variable}`;
  const b = (by[k] ??= { n: 0, min: Infinity, max: -Infinity, stations: new Set(), resorts: new Set() });
  b.n++;
  if (Number.isFinite(r.value)) { b.min = Math.min(b.min, r.value); b.max = Math.max(b.max, r.value); }
  if (r.station_id) b.stations.add(r.station_id);
  if (r.resort_id) b.resorts.add(r.resort_id);
}
console.log(`\n${name}: ok=${res?.ok} in ${Math.round((Date.now() - t) / 1000)} s, ${rows.length} rows`);
for (const [k, b] of Object.entries(by).sort()) {
  console.log(`  ${k}: ${b.n} rows, ${b.stations.size} stations, ${b.resorts.size} resorts, min ${b.min} max ${b.max}`);
}
const maps = rows.filter((r) => r.kind === "mapping");
const perResort = {};
for (const m of maps) (perResort[m.resort_id] ??= []).push(`${m.station_id} ${m.value} km ${m.elevation_m ?? "?"} m`);
for (const [r, list] of Object.entries(perResort).sort()) console.log(`  ${r}: ${list.join(" | ")}`);
console.log("  sample:", JSON.stringify(rows.find((r) => r.kind === "observation") ?? null));
if (res?.failures?.length) console.log("  failures:", res.failures.slice(0, 10));
process.exit(res?.ok ? 0 : 1);
