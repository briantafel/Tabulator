#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One archive run: Snow-Forecast (all tiers), Open-Meteo ensembles, SNOTEL,
 * BC snow pillows (bc-asws), NWS gridpoints and OnTheSnow, each saved raw and as archive rows.
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
import * as bcasws from "./bc-asws.js";
import * as slf from "./slf.js";
import * as amedas from "./amedas.js";
import * as cocorahs from "./cocorahs.js";
import * as snodas from "./snodas.js";
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

/* ONLY_SOURCES / SKIP_SOURCES (comma-separated source names) let one source
   run on its own schedule: the Open-Meteo ensembles run once a day, paced,
   in ensembles-om.yml (2026-11-11), and archive.yml skips them. A skipped
   source is left out of the manifest entirely — not counted as a failure. */
const only = (process.env.ONLY_SOURCES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const skip = (process.env.SKIP_SOURCES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const wanted = (name) => (!only.length || only.includes(name)) && !skip.includes(name);

async function run(name, fn) {
  if (!wanted(name)) { log(`  · ${name}: not in this run`); return null; }
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

/* Without a Snow-Forecast pass in this run (the paced ensemble job), use the
   mid elevations earlier runs saved, so Open-Meteo still downscales to the
   same height. */
let savedElevations = {};
try { savedElevations = JSON.parse(await readFile(`${root}src/data/sf-elevations.json`, "utf8")); } catch { /* none yet */ }
await run("open-meteo-ensemble", (sink, rawDir) =>
  ens.collect({ resorts, elevations: { ...savedElevations, ...(sfResult?.elevations ?? {}) }, sink, rawDir, fetchedAt, runId, log }));

await run("snotel", (sink, rawDir) =>
  snotel.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("bc-asws", (sink, rawDir) =>
  bcasws.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

// Swiss / Alpine ground truth (2026-11-11).
await run("slf", (sink, rawDir) =>
  slf.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

// Japanese ground truth (2026-11-11).
await run("amedas", (sink, rawDir) =>
  amedas.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

// US/Canada volunteer snowfall reports (2026-11-11).
await run("cocorahs", (sink, rawDir) =>
  cocorahs.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

// SNODAS gridded snowpack analysis, US + southern Canada (2026-11-11).
await run("snodas", (sink, rawDir) =>
  snodas.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("nws", (sink, rawDir) =>
  nws.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

await run("onthesnow", (sink, rawDir) =>
  ots.collect({ resorts, sink, rawDir, fetchedAt, runId, log }));

/* Snow-Forecast's mid elevation per resort, kept in the repo so the
   Previous Runs backfill can ask Open-Meteo for the right height for
   resorts the app's forecast.json does not carry (archiveOnly). Merged, so
   a resort missing from one run keeps its last value. Committed by archive.yml. */
if (sfResult?.elevations && Object.keys(sfResult.elevations).length) {
  const p = `${root}src/data/sf-elevations.json`;
  let prev = {};
  try { prev = JSON.parse(await readFile(p, "utf8")); } catch { /* first run */ }
  await writeFile(p, JSON.stringify({ ...prev, ...sfResult.elevations }, null, 1) + "\n");
}
for (const s of Object.values(manifest.sources)) delete s.elevations;
await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 1));

const failed = Object.entries(manifest.sources).filter(([, s]) => !s.ok);
log(`\nrun ${runId}`);
for (const [name, s] of Object.entries(manifest.sources)) log(`  ${s.ok ? "✓" : "✗"} ${name}: ${s.rows} rows`);
if (failed.length) {
  log(`\nFAILED: ${failed.map(([n]) => n).join(", ")} — what succeeded is still written and uploaded.`);
  // One annotation per failed source: annotations show on the run page and
  // through the public API, so the cause can be read without the job log.
  // Messages are error text from our own code (no data values, no secrets).
  if (process.env.GITHUB_ACTIONS) {
    const clean = (t) => String(t ?? "").replace(/[\r\n]+/g, " ").slice(0, 400);
    for (const [name, s] of failed) {
      if (/snow-forecast/.test(name)) { // paid: don't name it or quote it in public annotations
        console.log("::error title=archive source failed::a paid source failed — see the Collect step");
        continue;
      }
      const why = s.error ?? (s.failures?.length ? s.failures.slice(0, 3).join(" | ") : "returned ok=false");
      console.log(`::error title=archive source ${name} failed::${clean(why)}`);
    }
  }
  process.exit(1);
}
