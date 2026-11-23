#!/usr/bin/env node
/* One wind-obs run: node scripts/archive/wind-obs-run.js <outDir>. Writes rows/wind-obs.ndjson.gz, raw/wind-obs/, manifest.json
   (same layout as collect.js, so to_parquet.py and the R2 upload step are shared). Exits 1 if the source fell short. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rowSink } from "./common.js";
import * as wind from "./wind-obs.js";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
if (!outDir) { console.error("usage: wind-obs-run.js <outDir>"); process.exit(2); }
const log = (s) => console.error(s);
const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const fetchedAt = new Date().toISOString();
const runId = `${fetchedAt.slice(0, 16).replace(/:/g, "")}Z-wind-${process.env.GITHUB_RUN_ID ?? "local"}`;
await mkdir(outDir, { recursive: true });
const sink = await rowSink(`${outDir}/rows/wind-obs.ndjson.gz`);
let result;
try { result = await wind.collect({ resorts, sink, rawDir: `${outDir}/raw/wind-obs`, fetchedAt, runId, log }); }
catch (e) { log(`✗ wind-obs — ${e.message}`); result = { ok: false, error: e.message }; }
await sink.close();
await writeFile(`${outDir}/manifest.json`, JSON.stringify({ runId, fetchedAt, sources: { "wind-obs": { ...result, rows: sink.count } } }, null, 1));
if (!result.ok) {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=wind-obs fell short::${String(result.error ?? (result.failures ?? []).slice(0, 5).join(" | ")).replace(/[\r\n]+/g, " ").slice(0, 400)}`);
  process.exit(1);
}
