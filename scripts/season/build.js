#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Build public/season.json: season to date for every US resort with a
 * SNOTEL station nearby (claude/calendar-shaping-up-plan.md, step 1).
 *
 *   node scripts/season/build.js public
 *
 * Source: NRCS AWDB (public, no key). For each resort, the up-to-three
 * active SNOTEL stations within 30 km that the archive already maps
 * (scripts/archive/snotel.js pickStations), daily since Oct 1:
 * snow depth, SWE, accumulated precipitation, daily high and low, plus the
 * 1991–2020 MEDIAN depth and SWE for each date (AWDB centralTendencyType).
 *
 * Fails loudly (settled rule): a stations list that looks wrong, no medians
 * at all, or fewer than MIN_RESORTS resorts summarised all throw, so CI goes
 * red instead of shipping a plausible-looking empty file.
 * ------------------------------------------------------------------ */
import { readFile, writeFile } from "node:fs/promises";
import { fetchText } from "../archive/common.js";
import { pickStations, toMetric } from "../archive/snotel.js";
import { summarise, pickPrimary } from "./season.js";

const API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const ELEMENTS = ["SNWD", "WTEQ", "PREC", "TMAX", "TMIN"];
const FIELD = { SNWD: "depthCm", WTEQ: "sweMm", PREC: "precipMm", TMAX: "tmaxC", TMIN: "tminC" };
const MEDIAN_FIELD = { SNWD: "depthMedCm", WTEQ: "sweMedMm" };
const CHUNK = 20;
const MIN_RESORTS = 20;

const outDir = process.argv[2] ?? "public";
const root = new URL("../../", import.meta.url).pathname;

/** The water year the date falls in starts Oct 1. */
export function waterYearStart(d = new Date()) {
  const y = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-10-01`;
}

/** AWDB JSON for one chunk → Map(stationTriplet → Map(date → day)). */
export function parseDaily(json, into = new Map(), stats = { medians: 0, sample: null }) {
  for (const st of json ?? []) {
    const days = into.get(st.stationTriplet) ?? new Map();
    into.set(st.stationTriplet, days);
    for (const el of st.data ?? []) {
      const code = el.stationElement?.elementCode;
      if (!FIELD[code]) continue;
      const unit = el.stationElement?.storedUnitCode ?? el.stationElement?.unitCode
        ?? (code === "TMAX" || code === "TMIN" ? "degF" : "in");
      const elementForUnits = code === "TMAX" || code === "TMIN" ? "TMAX" : code;
      for (const v of el.values ?? []) {
        const date = String(v.date ?? "").slice(0, 10);
        if (!date) continue;
        if (!stats.sample) stats.sample = { code, keys: Object.keys(v) };
        const day = days.get(date) ?? { date };
        const m = toMetric(elementForUnits, v.value, unit);
        if (m) day[FIELD[code]] = m.value;
        const medRaw = v.median ?? v.centralTendency?.median ?? null;
        if (MEDIAN_FIELD[code] && medRaw != null) {
          const mm = toMetric(elementForUnits, medRaw, unit);
          if (mm) { day[MEDIAN_FIELD[code]] = mm.value; stats.medians++; }
        }
        days.set(date, day);
      }
    }
  }
  return into;
}

async function main() {
  const { resorts } = JSON.parse(await readFile(`${root}src/data/resorts.json`, "utf8"));
  const slr = JSON.parse(await readFile(`${root}public/slr.json`, "utf8"));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const st = await fetchText(`${API}/stations?stationTriplets=*:*:SNTL`);
  if (st.status !== 200) throw new Error(`AWDB stations HTTP ${st.status}`);
  const stations = JSON.parse(st.text);
  if (!Array.isArray(stations) || stations.length < 100) throw new Error(`AWDB stations list has ${stations?.length ?? 0} entries — expected hundreds`);

  const picks = pickStations(stations, resorts, now);
  const byId = new Map(picks.map((p) => [p.station.stationTriplet, p.station]));
  const ids = [...byId.keys()];
  if (!ids.length) throw new Error("no SNOTEL stations near any resort");

  const series = new Map();
  const stats = { medians: 0, sample: null };
  const failures = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const q = new URLSearchParams({
      stationTriplets: ids.slice(i, i + CHUNK).join(","), duration: "DAILY",
      elements: ELEMENTS.join(","), beginDate: waterYearStart(now), endDate: today,
      centralTendencyType: "MEDIAN",
    });
    const res = await fetchText(`${API}/data?${q}`);
    if (res.status !== 200) { failures.push(`chunk ${i / CHUNK}: HTTP ${res.status}`); continue; }
    parseDaily(JSON.parse(res.text), series, stats);
  }
  console.log(`AWDB value shape: ${JSON.stringify(stats.sample)}; medians read: ${stats.medians}`);
  if (failures.length) throw new Error(`AWDB data requests failed: ${failures.join("; ")}`);
  if (stats.medians === 0) throw new Error("AWDB returned no medians — centralTendencyType may have changed; refusing to ship % of normal without them");

  const out = {};
  for (const r of resorts) {
    const mine = picks.filter((p) => p.resort === r.id);
    if (!mine.length) continue;
    const cands = mine.map((p) => {
      const days = [...(series.get(p.station.stationTriplet)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
      return {
        id: p.station.stationTriplet, name: p.station.name ?? null, km: p.km,
        elevationM: Number.isFinite(p.station.elevation) ? Math.round(p.station.elevation * 0.3048) : null,
        summary: summarise(days, { slr, today }),
      };
    });
    const primary = pickPrimary(cands);
    if (!primary) { console.log(`  · ${r.id}: no station with a current reading`); continue; }
    out[r.id] = {
      station: { id: primary.id, name: primary.name, elevationM: primary.elevationM, km: primary.km },
      ...primary.summary,
      // Every nearby station's % of median, so the app can show agreement.
      neighbours: cands.filter((c) => c.summary).map((c) => ({ id: c.id, elevationM: c.elevationM, swePctMedian: c.summary.swePctMedian })),
    };
  }
  const n = Object.keys(out).length;
  console.log(`season: ${n} resorts from ${ids.length} stations`);
  if (n < MIN_RESORTS) throw new Error(`only ${n} resorts summarised — expected at least ${MIN_RESORTS}`);

  const doc = {
    generatedAt: now.toISOString(),
    waterYearStart: waterYearStart(now),
    source: "NRCS SNOTEL (AWDB), daily; medians are AWDB's 1991–2020 central tendency (served for SWE and precipitation, not for snow depth — depthMedianCm stays null until another source supplies it)",
    notes: [
      "newNCm is estimated fresh snow: SWE gain × our SLR at the day's mean station temperature (public/slr.json). Unknown days are skipped; a window with under half its days known is null.",
      "sinceDump counts days since the last ≥15 cm day: warm = high > +2 °C; freezeThaw = high > 0 and low < −2 °C; rainOnSnow = ≥2.5 mm water at mean > +1 °C onto snow.",
      "The station is the highest of up to three SNOTEL sites within 30 km with a current reading.",
    ],
    resorts: out,
  };
  await writeFile(`${outDir}/season.json`, JSON.stringify(doc));
  console.log(`wrote ${outDir}/season.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
