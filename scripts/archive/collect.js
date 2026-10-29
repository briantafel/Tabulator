#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One archive run: Snow-Forecast (all tiers), Open-Meteo ensembles, SNOTEL,
 * NWS gridpoints and OnTheSnow, each saved raw and as archive rows.
 *
 *   node scripts/archive/collect.js <outDir>
 *
 * Writes:
 *   <outDir>/raw/<source>/…          the bytes as fetched, gzipped
 *   <outDir>/rows/<source>.ndjson.gz  archive rows, for to_parquet.py
 *   <outDir>/manifest.json            what ran, what failed, row counts
 *
 * FAIL LOUDLY. Every source runs even when another fails, everything that
 * succeeded is written, and the exit code is non-zero if any source fell
 * short — a gap in an archive can never be refilled, so it must be seen.
 * ------------------------------------------------------------------ */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rowSink } from "./common.js";
import * as sf from "./snow-forecast.js";
import * as ens from "./ensembles.js";
import * as snotel from "./snotel.js";
import * as nws from "./nws.js";
import * as ots from "./onthesnow.js";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
if (!outDir) { console.error("usage: collect.js <outDir>"); process.exit(2); }

const log = (s) => console.error(s);
const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const fetchedAt = new Date().toISOString();
const runId = `${fetchedAt.slice(0, 16).replace(/:/g, "")}Z-${process.env.GITHUB_RUN_ID ?? "local"}`;
await mkdir(outDir, { recursive: true });

const manifest = { runId, fetchedAt, resorts: resorts.length, sources: {} };

async function run(name, fn) {
  const sink = await rowSink(`${outDir}/rows/${name}.ndjson.gz`);
  const started = Date.now();
  try {
    const result = await fn(sink, `${outDir}/raw/${name}`);
    manifest.sources[name] = { ...result, rows: sink.count };
    return result;
  } catch (e) {
    log(`  ✗ ${name} — ${e.message}`);
    manifest.sources[name] = { ok: false, error: e.message, rows: sink.count };
    return null;
  } finally {
    await sink.close();
    manifest.sources[name].seconds = Math.round((Date.now() - started) / 1000);
  }
}

const sfResult = await run("snow-forecast", (sink, rawDir) =>
  sf.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("open-meteo-ensemble", (sink, rawDir) =>
  ens.collect({ resorts, elevations: sfResult?.elevations ?? {}, sink, rawDir, fetchedAt, runId, log }));

await run("snotel", (sink, rawDir) =>
  snotel.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("nws", (sink, rawDir) =>
  nws.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("onthesnow", (sink, rawDir) =>
  ots.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

for (const s of Object.values(manifest.sources)) delete s.elevations;
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 1));

const failed = Object.entries(manifest.sources).filter(([, s]) => !s.ok);
log(`\nrun ${runId}`);
for (const [name, s] of Object.entries(manifest.sources)) log(`  ${s.ok ? "✓" : "✗"} ${name}: ${s.rows} rows`);
if (failed.length) {
  log(`\nFAILED: ${failed.map(([n]) => n).join(", ")} — what succeeded is still written and uploaded.`);
  process.exit(1);
}
