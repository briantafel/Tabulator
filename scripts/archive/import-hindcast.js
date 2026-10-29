#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Import a Snow-Forecast hindcast file (from sf-hindcast-runner.browser.js)
 * into archive rows.
 *
 *   node scripts/archive/import-hindcast.js <file.ndjson.gz>... <outDir>
 *
 * Writes <outDir>/<yyyy-mm>/snow-forecast-hindcast.ndjson.gz by valid month,
 * for to_parquet.py. Fails if more than 2% of pages cannot be parsed.
 * ------------------------------------------------------------------ */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { rowSink } from "./common.js";
import { hindcastToRows } from "./sf-hindcast.js";

const root = new URL("../..", import.meta.url).pathname;
const args = process.argv.slice(2);
const outDir = args.pop();
if (!args.length || !outDir) { console.error("usage: import-hindcast.js <file.ndjson.gz>... <outDir>"); process.exit(2); }

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const bySlug = new Map(resorts.flatMap((r) => r.slugs.map((s) => [s, r])));

const sinks = new Map();
let pages = 0, bad = 0, rows = 0;
for (const file of args) {
  const runId = `hindcast-${file.split("/").pop().replace(/\.ndjson\.gz$/, "")}`;
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    pages++;
    try {
      const rec = JSON.parse(line);
      const resort = bySlug.get(rec.slug);
      if (!resort) throw new Error(`unknown slug ${rec.slug}`);
      for (const r of hindcastToRows(rec, { resort, runId })) {
        const key = `${r.valid_start.slice(0, 7)}`;
        if (!sinks.has(key)) sinks.set(key, await rowSink(`${outDir}/${key}/snow-forecast-hindcast.ndjson.gz`));
        sinks.get(key).write(r);
        rows++;
      }
    } catch (e) {
      bad++;
      if (bad <= 10) console.error(`  ✗ page ${pages}: ${e.message}`);
    }
  }
}
for (const s of sinks.values()) await s.close();
console.error(`hindcast import: ${pages} pages, ${bad} unparseable, ${rows} rows across ${sinks.size} month(s)`);
if (!rows || bad / pages > 0.02) process.exit(1);
