#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Fetches every resort from Snow-Forecast, parses, and writes
 * public/forecast.json. Also appends today's observed snowfall to
 * public/history.json, which is what restores the "-3 days" column.
 *
 * Design rule: FAIL LOUDLY. The spreadsheet rotted for months because a
 * broken scrape looked identical to a quiet week. A partial scrape here
 * exits non-zero so the Action goes red.
 * ------------------------------------------------------------------ */

import { readFile, writeFile } from "node:fs/promises";
import { parseResortPage } from "./parse.js";
import { openHistory, recordDay } from "./history.js";

const BASE = "https://www.snow-forecast.com/resorts";
const UA = "Tabulator/1.0 (personal ski-trip planner; low volume; 1 req/1.5s)";
const DELAY_MS = 1500;      // deliberately unhurried
const RETRIES = 2;
const MIN_OK_RATIO = 0.8;   // below this the run is considered failed

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = new URL("..", import.meta.url).pathname;

async function fetchPage(slug, tier) {
  const url = `${BASE}/${slug}/6day/${tier}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(DELAY_MS * (attempt + 1));
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
      if (res.status === 404) throw new Error(`404 — slug "${slug}" is wrong or was renamed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${slug}: ${lastErr.message}`);
}

/** Where a resort spans several lift-connected slugs, fold them together.
 *  Snow takes the max: if one face got it, that's where you ski. Temp and
 *  wind take the max because the warnings are worst-case by design. */
function combine(parsed, rule = "max") {
  if (parsed.length === 1) return parsed[0];
  const pick = (vals) => {
    const n = vals.filter((v) => typeof v === "number" && Number.isFinite(v));
    if (!n.length) return null;
    return rule === "mean" ? n.reduce((a, b) => a + b, 0) / n.length : Math.max(...n);
  };
  const base = parsed[0];
  return {
    ...base,
    elevation: base.elevation,
    days: base.days.map((d, i) => ({
      ...d,
      snow: Number(pick(parsed.map((p) => p.days[i]?.snow)).toFixed(2)),
      tempMax: pick(parsed.map((p) => p.days[i]?.tempMax)),
      tempMin: pick(parsed.map((p) => p.days[i]?.tempMin)),
      windMax: pick(parsed.map((p) => p.days[i]?.windMax)),
      freezeMin: pick(parsed.map((p) => p.days[i]?.freezeMin)),
      freezeMax: pick(parsed.map((p) => p.days[i]?.freezeMax)),
    })),
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function main() {
  const cfg = await readJson(`${root}src/data/resorts.json`);
  const tier = cfg.tier || "mid";
  const rule = cfg.combine?.rule || "max";
  const now = new Date();

  const out = [];
  const failures = [];

  for (const r of cfg.resorts) {
    const parsed = [];
    for (const slug of r.slugs) {
      try {
        parsed.push(parseResortPage(await fetchPage(slug, tier), { now }));
      } catch (e) {
        failures.push(`${r.name} (${slug}): ${e.message}`);
        console.error(`  ✗ ${r.name} [${slug}] — ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
    if (!parsed.length) continue;
    const merged = combine(parsed, rule);
    out.push({ id: r.id, name: r.name, region: r.region, slugs: r.slugs, ...merged });
    console.error(`  ✓ ${r.name} — ${merged.days.length}d, ${merged.days.reduce((a, d) => a + d.snow, 0).toFixed(1)}cm`);
  }

  const ratio = out.length / cfg.resorts.length;
  console.error(`\n${out.length}/${cfg.resorts.length} resorts (${(ratio * 100).toFixed(0)}%)`);

  if (ratio < MIN_OK_RATIO) {
    console.error(`\nFAILED: below the ${MIN_OK_RATIO * 100}% threshold. Not writing output.`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  // Roll the observed day-0 snowfall into a history file. Three days of runs
  // and the "-3 days" column has a real source again — our own archive of
  // Snow-Forecast's nowcast, rather than a second provider.
  //
  // A synthetic archive left behind by `npm run fixture` is discarded, not
  // appended to: mixing invented and observed snowfall would present fabricated
  // numbers as fact in the one column the user reads as ground truth.
  const existing = await readJson(`${root}public/history.json`, null);
  const opened = openHistory(existing);
  if (opened.discarded) {
    console.error("\nnote: discarded a synthetic history.json (from `npm run fixture`).");
    console.error('      "-3 days" will read "—" until three real runs accumulate.');
  }
  const history = recordDay(opened, out, now);

  const forecast = {
    generatedAt: now.toISOString(),
    source: "snow-forecast.com",
    tier,
    combineRule: rule,
    units: { snow: "cm", temp: "C", wind: "km/h", elevation: "m" },
    horizonDays: 6,
    resortCount: out.length,
    failures,
    resorts: out,
  };

  await writeFile(`${root}public/forecast.json`, JSON.stringify(forecast, null, 1));
  await writeFile(`${root}public/history.json`, JSON.stringify(history, null, 1));
  console.error(`\nwrote public/forecast.json (${out.length} resorts) and public/history.json (${Object.keys(history.days).length} days)`);
  if (failures.length) console.error(`\n${failures.length} slug failure(s) — output written, but investigate:`);
  failures.forEach((f) => console.error(`  - ${f}`));
}

main().catch((e) => { console.error(`\nfatal: ${e.stack || e.message}`); process.exit(1); });
