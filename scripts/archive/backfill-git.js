#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One-time: turn every real public/forecast.json in git history into
 * archive rows, so the archive starts with what was already collected.
 *
 *   node scripts/archive/backfill-git.js <outDir>
 *
 * Writes <outDir>/<yyyy-mm>/snow-forecast.ndjson.gz, one per month, for
 * to_parquet.py. Needs a full clone (fetch-depth: 0).
 *
 * What it recovers is modest: only mid-tier, only runs whose file changed
 * (the scraper commits nothing on an unchanged forecast), and nothing from
 * 2026-08-25 to 2026-10-28 while the scrape was paused. Synthetic sample
 * files are skipped. Files written before the 2026-10-28 parser fix carry
 * their own parser_version, because that parser could set every value one
 * period off its time label.
 * ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { addHours, rowSink, zonedToUtc } from "./common.js";

const root = new URL("../..", import.meta.url).pathname;
const outDir = process.argv[2];
if (!outDir) { console.error("usage: backfill-git.js <outDir>"); process.exit(2); }

const WINDOW = { am: [6, 6], pm: [12, 6], night: [18, 12] };
const PARSER_FIX = Date.parse("2026-10-28T00:00:00Z");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
const byId = new Map(resorts.map((r) => [r.id, r]));

const commits = git("log", "--format=%H", "--", "public/forecast.json").trim().split("\n").filter(Boolean);
const sinks = new Map();
const seen = new Set();
let used = 0, skipped = 0;

for (const sha of commits.reverse()) {
  let f;
  try { f = JSON.parse(git("show", `${sha}:public/forecast.json`)); } catch { skipped++; continue; }
  if (f.synthetic || !String(f.source ?? "").startsWith("snow-forecast") || seen.has(f.generatedAt)) { skipped++; continue; }
  seen.add(f.generatedAt);
  const fetchedAt = new Date(f.generatedAt).toISOString();
  const month = fetchedAt.slice(0, 7);
  if (!sinks.has(month)) sinks.set(month, await rowSink(`${outDir}/${month}/snow-forecast.ndjson.gz`));
  const sink = sinks.get(month);
  const base = {
    source: "snow-forecast", kind: "forecast", tier: f.tier ?? "mid", fetched_at: fetchedAt,
    run_id: `git-${sha.slice(0, 7)}`,
    parser_version: Date.parse(fetchedAt) < PARSER_FIX ? "git-json-pre-2026-10-28" : "git-json",
  };

  for (const r of f.resorts ?? []) {
    const resort = byId.get(r.id);
    if (!resort) continue;
    const elevation = r.elevation?.[base.tier] ?? null;
    for (const d of r.days ?? []) {
      if (!d.date) continue;
      for (const p of d.periods ?? []) {
        const w = WINDOW[p.name];
        if (!w) continue;
        const start = zonedToUtc(d.date, w[0], resort.tz);
        const at = { ...base, resort_id: r.id, elevation_m: elevation, station_id: r.slugs?.join("+") ?? null,
          valid_start: start, valid_end: addHours(start, w[1]), period_label: p.name };
        sink.write({ ...at, variable: "snow", value: p.snow, unit: "cm" });
        sink.write({ ...at, variable: "temp_max", value: p.tempMax, unit: "C" });
        sink.write({ ...at, variable: "wind_speed", value: p.wind, unit: "km/h" });
        sink.write({ ...at, variable: "freezing_level", value: p.freezingLevel, unit: "m" });
        sink.write({ ...at, variable: "wind_dir", value_text: p.windDir });
        sink.write({ ...at, variable: "phrase", value_text: p.phrase });
      }
    }
  }
  used++;
}

let rows = 0;
for (const s of sinks.values()) { rows += s.count; await s.close(); }
console.error(`backfill: ${used} real forecasts, ${skipped} skipped, ${rows} rows across ${sinks.size} month(s)`);
if (!rows) process.exit(1);
