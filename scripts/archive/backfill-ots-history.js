#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One-time: OnTheSnow's resort-reported monthly snowfall history, back to
 * 2012-13, for every resort.
 *
 *   node scripts/archive/backfill-ots-history.js <outDir>
 *
 * The /historical-snowfall page has no daily figures — monthly totals, snow
 * days, biggest single snowfall and depths only. It is a scale check on the
 * daily truth (do SNOTEL and the hindcast add up to what the resort
 * reported?), not a daily truth itself.
 *
 * Writes <outDir>/<yyyy-mm>/onthesnow.ndjson.gz by month, raw pages under
 * <outDir>/raw/onthesnow-history/.
 * ------------------------------------------------------------------ */

import { readFile } from "node:fs/promises";
import { fetchText, rowSink, saveRaw, sleep } from "./common.js";
import { historyToRows } from "./onthesnow.js";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
if (!outDir) { console.error("usage: backfill-ots-history.js <outDir>"); process.exit(2); }

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const fetchedAt = new Date().toISOString();
const runId = "backfill-ots-history";

const sinks = new Map();
let ok = 0, rows = 0;
const wanted = resorts.filter((r) => r.otsPath);
for (const resort of wanted) {
  try {
    const { status, text } = await fetchText(`https://www.onthesnow.com/${resort.otsPath}/historical-snowfall`, { delayMs: 1500 });
    if (status !== 200) throw new Error(`HTTP ${status}`);
    await saveRaw(`${outDir}/raw/onthesnow-history/${resort.id}.html.gz`, text);
    for (const r of historyToRows(text, { resort, fetchedAt, runId })) {
      const key = r.valid_start.slice(0, 7);
      if (!sinks.has(key)) sinks.set(key, await rowSink(`${outDir}/${key}/onthesnow.ndjson.gz`));
      sinks.get(key).write(r);
      rows++;
    }
    ok++;
  } catch (e) {
    console.error(`  ✗ ${resort.id} — ${e.message}`);
  }
  await sleep(1500);
}
for (const s of sinks.values()) await s.close();
console.error(`onthesnow history: ${ok}/${wanted.length} resorts, ${rows} monthly values across ${sinks.size} months`);
if (ok / wanted.length < 0.8) process.exit(1);
