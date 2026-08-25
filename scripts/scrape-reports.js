#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Fetches first-hand skier reports from OnTheSnow and writes
 * public/reports.json.
 *
 * Same manners as the forecast scrape: one request at a time, unhurried,
 * an honest User-Agent, and FAIL LOUDLY — a partial run exits non-zero so
 * the Action goes red rather than quietly shipping a thinner feed.
 *
 * Offline mode for development and for tests:
 *   node scripts/scrape-reports.js --from <dir>
 * reads <dir>/<resortId>.html instead of the network. That is how this was
 * written at all: the dev sandbox gets a 403 at its proxy for onthesnow.com,
 * so the pages come in by hand.
 * ------------------------------------------------------------------ */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { parseReportsPage } from "./parse-reports.js";

const BASE = "https://www.onthesnow.com";
const UA = "Tabulator/1.0 (personal ski-trip planner; low volume; 1 req/1.5s)";
const DELAY_MS = 1500;
const RETRIES = 2;
const MIN_OK_RATIO = 0.8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL("..", import.meta.url).pathname;

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const FROM = fromIdx === -1 ? null : args[fromIdx + 1];

async function page(r) {
  if (FROM) return readFile(`${FROM}/${r.id}.html`, "utf8");
  const url = `${BASE}/${r.otsPath}/ski-report-reviews`;
  let last;
  for (let a = 0; a <= RETRIES; a++) {
    if (a) await sleep(DELAY_MS * (a + 1));
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
      if (res.status === 404) throw new Error(`404 — otsPath "${r.otsPath}" is wrong or was renamed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { last = e; }
  }
  throw new Error(`${r.id}: ${last.message}`);
}

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const only = FROM
  ? new Set((await readdir(FROM)).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)))
  : null;
const wanted = only ? resorts.filter((r) => only.has(r.id)) : resorts;

const out = {};
const urls = {};
const failed = [];
for (const [i, r] of wanted.entries()) {
  if (i && !FROM) await sleep(DELAY_MS);
  urls[r.id] = `${BASE}/${r.otsPath}/ski-report-reviews`;
  try {
    const { total, reports } = parseReportsPage(await page(r), { resortId: r.id });
    out[r.id] = reports;
    console.error(`${r.id.padEnd(16)} ${String(reports.length).padStart(3)} of ${total}`);
  } catch (e) {
    failed.push(`${r.id}: ${e.message}`);
    console.error(`${r.id.padEnd(16)} FAILED — ${e.message}`);
  }
}

const ok = Object.keys(out).length;
const doc = {
  source: "OnTheSnow",
  sourceUrls: urls,
  generatedAt: new Date().toISOString(),
  resorts: out,
};
await writeFile(`${root}public/reports.json`, JSON.stringify(doc));
console.error(`\nwrote public/reports.json — ${ok}/${wanted.length} resorts, ` +
  `${Object.values(out).flat().length} reports`);

if (ok / wanted.length < MIN_OK_RATIO) {
  console.error(`\nonly ${ok} of ${wanted.length} resorts parsed:`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
