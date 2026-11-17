#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Station history for Shaping up: what is normal for this date, and how
 * this season ranks (claude/calendar-shaping-up-plan.md).
 *
 *   node scripts/season/normals.js
 *
 * AWDB publishes 1991–2020 medians for snow water (SWE) but not for snow
 * depth, and a ratio to a median of a few millimetres means nothing in
 * November. So, for every SNOTEL station the season job uses, this pulls
 * the daily depth and SWE history since water year 1991 and keeps, per
 * calendar day (MM-DD):
 *
 *   depthMed   median snow depth over water years 1991–2020 (cm)
 *   swe        each season's SWE on that day, by water year (mm) — the
 *              season job ranks this season against them
 *
 * Writes scripts/season/normals.json.gz (build data, not shipped to the
 * app). Monthly; history does not change. Fails loudly when a station
 * returns nothing.
 * ------------------------------------------------------------------ */
import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fetchText, sleep } from "../archive/common.js";
import { pickStations, toMetric } from "../archive/snotel.js";

const API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const root = new URL("../../", import.meta.url).pathname;
const OUT = `${root}scripts/season/normals.json.gz`;
const FIRST_WY = 1991, NORMAL_LAST_WY = 2020;

/** The water year a date belongs to (Oct 1 starts the next one). */
export const waterYear = (date) => {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return m >= 10 ? y + 1 : y;
};

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const k = Math.floor(v.length / 2);
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
};

/** One station's daily SNWD/WTEQ rows → { "MM-DD": { depthMed, swe: { wy: mm } } }.
 *  Only Oct 1 – Jun 30: the ski season. Depth median needs ≥ 10 normal-period
 *  seasons on that day, or it is left out (missing is not zero). */
export function compact(days) {
  const byDay = new Map();
  for (const d of days) {
    const md = d.date.slice(5, 10);
    const mo = Number(md.slice(0, 2));
    if (mo >= 7 && mo <= 9) continue;
    const wy = waterYear(d.date);
    if (!byDay.has(md)) byDay.set(md, { depth: [], swe: {} });
    const e = byDay.get(md);
    if (typeof d.depthCm === "number" && wy >= FIRST_WY && wy <= NORMAL_LAST_WY) e.depth.push(d.depthCm);
    if (typeof d.sweMm === "number") e.swe[wy] = Math.round(d.sweMm);
  }
  const out = {};
  for (const [md, e] of byDay) {
    const med = e.depth.length >= 10 ? median(e.depth) : null;
    out[md] = { depthMed: med == null ? null : Math.round(med), swe: e.swe };
  }
  return out;
}

async function main() {
  const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
  const st = await fetchText(`${API}/stations?stationTriplets=*:*:SNTL`);
  if (st.status !== 200) throw new Error(`AWDB stations HTTP ${st.status}`);
  const picks = pickStations(JSON.parse(st.text), resorts, new Date());
  const ids = [...new Set(picks.map((p) => p.station.stationTriplet))];
  const end = new Date().toISOString().slice(0, 10);
  const stations = {};
  const empty = [];
  for (const id of ids) {
    const q = new URLSearchParams({ stationTriplets: id, duration: "DAILY", elements: "SNWD,WTEQ",
      beginDate: `${FIRST_WY - 1}-10-01`, endDate: end });
    const res = await fetchText(`${API}/data?${q}`, { retries: 3, delayMs: 4000 });
    if (res.status !== 200) throw new Error(`AWDB ${id} HTTP ${res.status}`);
    const days = new Map();
    for (const s of JSON.parse(res.text) ?? []) {
      for (const el of s.data ?? []) {
        const code = el.stationElement?.elementCode;
        const unit = el.stationElement?.storedUnitCode ?? "in";
        for (const v of el.values ?? []) {
          const date = String(v.date ?? "").slice(0, 10);
          const m = toMetric(code, v.value, unit);
          if (!date || !m) continue;
          const d = days.get(date) ?? { date };
          if (code === "SNWD") d.depthCm = m.value; else if (code === "WTEQ") d.sweMm = m.value;
          days.set(date, d);
        }
      }
    }
    if (!days.size) { empty.push(id); continue; }
    const c = compact([...days.values()]);
    const seasons = new Set(Object.values(c).flatMap((x) => Object.keys(x.swe))).size;
    stations[id] = { seasons, days: c };
    console.log(`  ${id}: ${days.size} days, ${seasons} seasons`);
    await sleep(800);
  }
  if (empty.length) console.log(`::warning::no history for ${empty.join(", ")}`);
  if (Object.keys(stations).length < ids.length * 0.8) throw new Error(`history for only ${Object.keys(stations).length}/${ids.length} stations`);
  const doc = { generatedAt: new Date().toISOString(), normalPeriod: `${FIRST_WY}-${NORMAL_LAST_WY}`, stations };
  await writeFile(OUT, gzipSync(JSON.stringify(doc)));
  console.log(`wrote ${OUT}: ${Object.keys(stations).length} stations`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
