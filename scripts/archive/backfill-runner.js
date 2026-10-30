#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * The one-time historical backfill, in small resumable pieces.
 *
 *   node scripts/archive/backfill-runner.js <workDir>
 *
 * WHY PIECES. The first attempt (2026-10-29) fetched everything and
 * uploaded only at the end. Each two-winter request took ~53 s to fetch and
 * process, not the 25 s planned for, so it hit GitHub's 2.5-hour limit at
 * request 154 of 160 and was killed — and everything it had fetched, held
 * only on the runner's disk, was lost. Now each piece is fetched,
 * converted and uploaded on its own, and marked done in the bucket
 * (backfill/done/<key>.json). Every run skips pieces already done, so a run
 * that stops for any reason loses at most the piece in hand.
 *
 * THE OPEN-METEO BUDGET. The free tier allows 10,000 weighted calls a day,
 * and one two-winter request here weighs ~31. The twice-daily collection
 * needs its share too — a backfill that ate the whole day's allowance would
 * leave tomorrow morning's ensemble run with nothing, and that gap could
 * never be refilled. So each run spends at most OM_DAILY_BUDGET, stops
 * Open-Meteo at the first rate-limit answer, and leaves the rest for the
 * next day's scheduled run. At ~1 minute a piece, the 95-minute run limit
 * and the budget both land near 95 pieces a night: two nights covers it.
 *
 * Pieces:
 *   snotel-<year>          SNOTEL daily history, one winter      (no quota)
 *   ots-history-<resort>   OnTheSnow monthly history             (no quota)
 *   om-<resort>-<model>-<year>  Open-Meteo previous runs         (~31 calls)
 *
 * The bucket is reached through the aws CLI with the R2 secrets in the
 * environment. For tests, BACKFILL_LOCAL_BUCKET=<dir> stands in for it.
 * ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { coordsOf, fetchText, rowSink, saveRaw, sleep } from "./common.js";
import { dataToRows, pickStations } from "./snotel.js";
import { historyToRows } from "./onthesnow.js";
import * as om from "./previous-runs.js";

const root = new URL("../..", import.meta.url).pathname;
const work = process.argv[2];
if (!work) { console.error("usage: backfill-runner.js <workDir>"); process.exit(2); }

const WINTERS = [["2024-11-01", "2025-04-30"], ["2025-11-01", "2026-04-30"]];
const OM_DAILY_BUDGET = Number(process.env.OM_DAILY_BUDGET ?? 3000);
const OM_SPACING_MS = 5000;   // each request already takes ~50 s end to end
const TIME_LIMIT_MS = 95 * 60e3;
const SNOTEL = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const started = Date.now();
const log = (s) => console.error(s);

// ---- the bucket -------------------------------------------------------------
const LOCAL = process.env.BACKFILL_LOCAL_BUCKET;
const BUCKET = process.env.R2_BUCKET;
const ENDPOINT = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
if (!LOCAL && !(BUCKET && ENDPOINT)) { log("no bucket: set R2_BUCKET and R2_ACCOUNT_ID, or BACKFILL_LOCAL_BUCKET"); process.exit(2); }

const aws = (...args) => execFileSync("aws", [...args, "--endpoint-url", ENDPOINT, "--only-show-errors"], { encoding: "utf8" });

function upload(localPath, key, { recursive = false } = {}) {
  if (LOCAL) {
    const dest = join(LOCAL, key);
    mkdirSync(recursive ? dest : dirname(dest), { recursive: true });
    cpSync(localPath, dest, { recursive });
    return;
  }
  aws("s3", "cp", localPath, `s3://${BUCKET}/${key}`, ...(recursive ? ["--recursive"] : []));
}

function doneKeys() {
  if (LOCAL) {
    const d = join(LOCAL, "backfill/done");
    return new Set(existsSync(d) ? readdirSync(d).map((f) => f.replace(/\.json$/, "")) : []);
  }
  let out = "";
  try { out = execFileSync("aws", ["s3", "ls", `s3://${BUCKET}/backfill/done/`, "--endpoint-url", ENDPOINT], { encoding: "utf8" }); }
  catch { /* nothing done yet: ls exits non-zero on an empty prefix */ }
  return new Set(out.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter((f) => f?.endsWith(".json")).map((f) => f.slice(0, -5)));
}

// ---- one piece: rows → Parquet by month → bucket → done marker ------------------
async function finish(piece, source, rows, raws) {
  const dir = join(work, piece.key);
  rmSync(dir, { recursive: true, force: true });
  const sinks = new Map();
  for (const r of rows) {
    const m = r.valid_start.slice(0, 7);
    if (!sinks.has(m)) sinks.set(m, await rowSink(join(dir, "rows", m, `${source}.ndjson.gz`)));
    sinks.get(m).write(r);
  }
  for (const s of sinks.values()) await s.close();
  const runId = `bf-${piece.key}`;
  for (const m of sinks.keys()) {
    execFileSync("python3", [join(root, "scripts/archive/to_parquet.py"), join(dir, "rows", m), join(dir, "pq"), runId, m], { stdio: ["ignore", "ignore", "inherit"] });
  }
  if (sinks.size) upload(join(dir, "pq"), "archive", { recursive: true });
  for (const [name, text] of raws) {
    const p = join(dir, "raw", name);
    await saveRaw(p, text);
    upload(p, `raw/source=${source}/backfill/${name}`);
  }
  const marker = join(dir, "done.json");
  writeFileSync(marker, JSON.stringify({ key: piece.key, rows: rows.length, at: new Date().toISOString() }));
  upload(marker, `backfill/done/${piece.key}.json`);
  rmSync(dir, { recursive: true, force: true });
  return rows.length;
}

// ---- inputs -------------------------------------------------------------------
const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
let elevations = {};
try {
  const f = JSON.parse(await readFile(`${root}public/forecast.json`, "utf8"));
  elevations = Object.fromEntries(f.resorts.map((r) => [r.id, r.elevation?.mid]));
} catch { /* Open-Meteo picks its own elevation */ }
const fetchedAt = new Date().toISOString();
const year = (w) => w[0].slice(0, 4);

const pieces = [
  ...WINTERS.map((w) => ({ key: `snotel-${year(w)}`, kind: "snotel", winter: w })),
  ...resorts.filter((r) => r.otsPath).map((r) => ({ key: `ots-history-${r.id}`, kind: "ots", resort: r })),
  ...resorts.filter(coordsOf).flatMap((r) => om.MODELS.flatMap((model) => WINTERS.map((w) => ({
    key: `om-${r.id}-${model}-${year(w)}`, kind: "om", resort: r, model, winter: w,
    weight: om.callWeight(om.HOURLY.length, (Date.parse(w[1]) - Date.parse(w[0])) / 864e5 + 1),
  })))),
];

const done = doneKeys();
const pending = pieces.filter((p) => !done.has(p.key));
log(`backfill: ${pieces.length} pieces, ${done.size} already done, ${pending.length} to go`);

let stations = null;
async function snotelStations() {
  if (stations) return stations;
  const st = await fetchText(`${SNOTEL}/stations?stationTriplets=*:*:SNTL`, { retries: 3 });
  if (st.status !== 200) throw new Error(`stations HTTP ${st.status}`);
  const picks = pickStations(JSON.parse(st.text), resorts);
  stations = new Map(picks.map((p) => [p.station.stationTriplet, p.station]));
  return stations;
}

async function runPiece(p) {
  if (p.kind === "snotel") {
    const byId = await snotelStations();
    const ids = [...byId.keys()];
    const rows = [], raws = [];
    for (let i = 0; i < ids.length; i += 20) {
      const q = new URLSearchParams({ stationTriplets: ids.slice(i, i + 20).join(","),
        elements: "SNWD,WTEQ,TOBS,PREC", duration: "DAILY", beginDate: p.winter[0], endDate: p.winter[1] });
      const res = await fetchText(`${SNOTEL}/data?${q}`, { retries: 3 });
      if (res.status !== 200) throw new Error(`data HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      raws.push([`${p.key}-${i / 20}.json.gz`, res.text]);
      rows.push(...dataToRows(JSON.parse(res.text), { stationsById: byId, duration: "DAILY", fetchedAt, runId: `bf-${p.key}` })
        .map((r) => ({ ...r, parser_version: "snotel-history-1" })));
      await sleep(2000);
    }
    if (!rows.length) throw new Error("no SNOTEL readings");
    return finish(p, "snotel", rows, raws);
  }
  if (p.kind === "ots") {
    const res = await fetchText(`https://www.onthesnow.com/${p.resort.otsPath}/historical-snowfall`, { delayMs: 1500 });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const rows = historyToRows(res.text, { resort: p.resort, fetchedAt, runId: `bf-${p.key}` });
    await sleep(1500);
    return finish(p, "onthesnow", rows, [[`${p.key}.html.gz`, res.text]]);
  }
  const [lat, lon] = coordsOf(p.resort);
  const q = new URLSearchParams({ latitude: lat, longitude: lon, models: p.model, hourly: om.HOURLY.join(","),
    start_date: p.winter[0], end_date: p.winter[1], timezone: "GMT", timeformat: "iso8601" });
  if (elevations[p.resort.id]) q.set("elevation", String(elevations[p.resort.id]));
  const res = await fetchText(`${om.URL_BASE}?${q}`, { retries: 0 });
  if (res.status !== 200) {
    const err = new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    if (/limit exceeded/i.test(res.text)) err.rateLimited = true;
    throw err;
  }
  const rows = om.previousRunsToRows(JSON.parse(res.text), {
    resort: p.resort, model: p.model, elevation: elevations[p.resort.id], fetchedAt, runId: `bf-${p.key}` });
  return finish(p, "open-meteo-previous-runs", rows, [[`${p.key}.json.gz`, res.text]]);
}

// ---- the run ------------------------------------------------------------------
let spent = 0, omStop = null, ok = 0, rowsOut = 0, inARow = 0;
const failed = [];
for (const p of pending) {
  if (Date.now() - started > TIME_LIMIT_MS) { log("time limit for this run reached — the rest continues next run"); break; }
  if (p.kind === "om") {
    if (omStop) continue;
    if (spent + p.weight > OM_DAILY_BUDGET) { omStop = `today's budget of ${OM_DAILY_BUDGET} calls is spent`; continue; }
    spent += p.weight;
  }
  try {
    const n = await runPiece(p);
    ok++; rowsOut += n; inARow = 0;
    log(`  ✓ ${p.key}: ${n} rows`);
  } catch (e) {
    const rateLimited = e.rateLimited || /HTTP 429/.test(e.message);
    if (p.kind === "om" && rateLimited) { omStop = "Open-Meteo answered with a rate limit"; log(`  · ${p.key}: rate limited — Open-Meteo paused until the next run`); continue; }
    failed.push(`${p.key}: ${e.message}`);
    log(`  ✗ ${p.key} — ${e.message}`);
    if (++inARow >= 5) { log("5 failures in a row — stopping this run"); break; }
  }
  if (p.kind === "om") await sleep(OM_SPACING_MS);
}

const nowDone = done.size + ok;
log(`\nthis run: ${ok} pieces, ${rowsOut} rows, ~${Math.round(spent)} Open-Meteo calls${omStop ? ` (Open-Meteo stopped: ${omStop})` : ""}`);
log(nowDone >= pieces.length
  ? `BACKFILL COMPLETE — all ${pieces.length} pieces are in the bucket.`
  : `backfill: ${nowDone}/${pieces.length} pieces done; the rest continue on the next scheduled run.`);
if (failed.length) {
  log(`\n${failed.length} piece(s) failed and will be retried next run:`);
  failed.forEach((f) => log(`  - ${f}`));
  process.exit(1);
}
