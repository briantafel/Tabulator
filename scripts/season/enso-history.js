#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * What past El Niño (and La Niña) winters did to each region's snowpack,
 * from our own station history (Brian, 2026-11-17: "We need to state what
 * El Niño means for that region").
 *
 *   node scripts/season/enso-history.js
 *
 * Inputs: NOAA CPC's Oceanic Niño Index (oni.ascii.txt, public) and
 * scripts/season/normals.json.gz (every season's SWE per station per day).
 * A winter's ENSO class is its DJF ONI anomaly: El Niño ≥ +0.5, strong
 * El Niño ≥ +1.5, La Niña ≤ −0.5, else neutral. DJF of year Y is water
 * year Y.
 *
 * For each region (the radar's ranges, the stations season.json uses) and
 * each checkpoint (Jan 1, Feb 1, Mar 1, Apr 1), a winter's value is the
 * median over the region's stations of SWE as % of that station's
 * 1991–2020 median for the day. Stations whose median is under 25 mm that
 * day are left out (a % of almost nothing means nothing). The season in
 * progress is never in the sample.
 *
 * Writes scripts/season/enso-history.json; the season job copies it into
 * season.json. Fails loudly if the ONI table or the history is unusable.
 * ------------------------------------------------------------------ */
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fetchText } from "../archive/common.js";
import { RANGES } from "../../src/lib/outlook.js";

const root = new URL("../../", import.meta.url).pathname;
const OUT = `${root}scripts/season/enso-history.json`;
export const CHECKPOINTS = ["01-01", "02-01", "03-01", "04-01"];
const NORMAL = [1991, 2020];
const MIN_MEDIAN_MM = 25;

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
};

/** CPC's ONI table → { waterYear: DJF anomaly }. */
export function parseOni(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*DJF\s+(\d{4})\s+[-\d.]+\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (m) out[Number(m[1])] = Number(m[2]);
  }
  return out;
}

export function ensoClass(anom) {
  if (typeof anom !== "number") return null;
  if (anom >= 1.5) return "strongElNino";
  if (anom >= 0.5) return "elNino";
  if (anom <= -0.5) return "laNina";
  return "neutral";
}

/** One region's winters: { wy: { "MM-DD": pct } } from its stations' history. */
export function regionWinters(stationDays, currentWy) {
  const out = {};
  for (const days of stationDays) {
    for (const md of CHECKPOINTS) {
      const swe = days?.[md]?.swe;
      if (!swe) continue;
      const norm = median(Object.entries(swe).filter(([wy]) => wy >= NORMAL[0] && wy <= NORMAL[1]).map(([, v]) => v));
      if (norm == null || norm < MIN_MEDIAN_MM) continue;
      for (const [wyS, v] of Object.entries(swe)) {
        const wy = Number(wyS);
        if (wy >= currentWy || typeof v !== "number") continue;
        ((out[wy] ??= {})[md] ??= []).push((100 * v) / norm);
      }
    }
  }
  for (const wy of Object.keys(out)) {
    for (const md of Object.keys(out[wy])) out[wy][md] = Math.round(median(out[wy][md]));
  }
  return out;
}

/** Group a region's winters by ENSO class, per checkpoint. */
export function summarise(winters, oni) {
  const out = {};
  for (const md of CHECKPOINTS) {
    const rows = Object.entries(winters)
      .map(([wy, v]) => ({ wy: Number(wy), oni: oni[wy] ?? null, pct: v[md] ?? null }))
      .filter((x) => x.pct != null && x.oni != null)
      .sort((a, b) => a.wy - b.wy);
    if (!rows.length) continue;
    const group = (pred) => {
      const g = rows.filter(pred);
      return { n: g.length, median: median(g.map((x) => x.pct)), above: g.filter((x) => x.pct >= 100).length, years: g.map(({ wy, oni: o, pct }) => [wy, o, pct]) };
    };
    out[md] = {
      all: group(() => true),
      strongElNino: group((x) => ensoClass(x.oni) === "strongElNino"),
      elNino: group((x) => ["elNino", "strongElNino"].includes(ensoClass(x.oni))),
      neutral: group((x) => ensoClass(x.oni) === "neutral"),
      laNina: group((x) => ensoClass(x.oni) === "laNina"),
    };
  }
  return out;
}

async function main() {
  const res = await fetchText("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt", { retries: 3, delayMs: 4000 });
  if (res.status !== 200) throw new Error(`ONI table HTTP ${res.status}`);
  const oni = parseOni(res.text);
  if (Object.keys(oni).length < 60 || oni[1998] == null) throw new Error(`ONI table parsed to ${Object.keys(oni).length} winters — the file shape has moved`);

  const normals = JSON.parse(gunzipSync(await readFile(`${root}scripts/season/normals.json.gz`)));
  const season = JSON.parse(await readFile(`${root}public/season.json`, "utf8"));
  const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
  const now = new Date();
  const currentWy = now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();

  const byRegion = new Map();
  for (const r of resorts) {
    const region = RANGES[r.id]?.range ?? null;
    const st = season.resorts?.[r.id]?.station?.id;
    if (!region || !st || !normals.stations?.[st]) continue;
    if (!byRegion.has(region)) byRegion.set(region, new Set());
    byRegion.get(region).add(st);
  }
  if (!byRegion.size) throw new Error("no region has station history — normals.json.gz or season.json is empty");

  const regions = {};
  for (const [region, ids] of byRegion) {
    const winters = regionWinters([...ids].map((id) => normals.stations[id].days), currentWy);
    regions[region] = { stations: ids.size, ...summarise(winters, oni) };
    const s = regions[region]["04-01"];
    console.log(`${region}: ${ids.size} stations; Apr 1 strong El Niño ${JSON.stringify(s?.strongElNino?.years)} median ${s?.strongElNino?.median}; all median ${s?.all?.median}`);
  }
  const doc = {
    generatedAt: now.toISOString(),
    method: "SWE as % of each station's 1991–2020 median for the day, median across the region's stations; ENSO class from DJF ONI (strong El Niño ≥ 1.5, El Niño ≥ 0.5, La Niña ≤ −0.5).",
    oniSource: "NOAA CPC oni.ascii.txt",
    regions,
  };
  await writeFile(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
