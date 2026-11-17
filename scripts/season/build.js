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
import { gunzipSync } from "node:zlib";
import { fetchText, sleep } from "../archive/common.js";
import { skireportToRows } from "../archive/onthesnow.js";
import { coordsOf } from "../archive/common.js";
import { zoneFor, parseAvorgProduct, parseAvcanProduct, maxBand, withHistory } from "./avalanche.js";
import { pickStations, toMetric } from "../archive/snotel.js";
import { summarise, pickPrimary, againstHistory } from "./season.js";

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

/** The resort report, summarised: last 7 days of reported snow (null when
 *  under four of the seven days were reported), base and summit depth. */
export function reportedSummary(rows, asOf) {
  const daily = new Map();
  for (const r of rows) {
    if (r.variable !== "reported_daily_snow") continue;
    daily.set(dayOf(r), r.value);
  }
  const end = asOf ?? [...daily.keys()].sort().pop();
  const days = [...daily.entries()].filter(([d]) => !end || d <= end).sort(([a], [b]) => a.localeCompare(b)).slice(-7);
  const val = (v) => rows.find((r) => r.variable === v)?.value ?? null;
  return {
    issued: rows.find((r) => r.issued_at)?.issued_at ?? null,
    last7Cm: days.length >= 4 ? Math.round(days.reduce((s, [, v]) => s + v, 0)) : null,
    baseCm: val("reported_base_depth"),
    summitCm: val("reported_summit_depth"),
    days,
  };
}
/* The resort-local date a reported day belongs to. valid_start is that
   day's local midnight expressed in UTC, so noon after it is safely inside
   the same local day wherever the resort is. */
const dayOf = (r) => new Date(Date.parse(r.valid_start) + 12 * 3600e3).toISOString().slice(0, 10);

/** Ours against the resorts', over resorts where either saw real snow:
 *  median ratio and the share where we read high or low by more than half. */
export function compareNewSnow(pairs) {
  const real = pairs.filter((p) => p.ours >= 5 || p.theirs >= 5);
  if (!real.length) return { n: 0 };
  const ratios = real.filter((p) => p.theirs > 0).map((p) => p.ours / p.theirs).sort((a, b) => a - b);
  const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  return {
    n: real.length,
    medianRatio: med == null ? null : Number(med.toFixed(2)),
    highByHalf: real.filter((p) => p.ours > 1.5 * p.theirs).length,
    lowByHalf: real.filter((p) => p.ours < 0.5 * p.theirs).length,
    sumOurs: real.reduce((s, p) => s + p.ours, 0),
    sumTheirs: real.reduce((s, p) => s + p.theirs, 0),
  };
}

/** Avalanche danger for every US and Canadian resort with coordinates.
 *  Secondary like the resort reports: failures warn loudly, the file still
 *  ships, and a resort with no forecast simply has no entry. */
async function collectAvalanche(resorts, today) {
  let prev = {};
  try { prev = JSON.parse(await readFile(`${outDir}/season.json`, "utf8")).avalanche ?? {}; } catch { /* first run */ }
  const out = {};
  const north = resorts.filter((r) => coordsOf(r) && !r.country);

  // US: zones from the avalanche.org map layer, then each zone's product.
  let layer = null;
  try {
    const res = await fetchText(`https://api.avalanche.org/v2/public/products/map-layer`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    layer = JSON.parse(res.text);
  } catch (e) { console.log(`::warning::avalanche.org map layer: ${e.message}`); }
  const products = new Map();
  let logged = false;
  for (const r of north.filter((x) => x.region !== "Canada")) {
    const z = layer ? zoneFor(coordsOf(r), layer) : null;
    if (!z) continue;
    const key = `${z.centerId}/${z.zoneId}`;
    if (!products.has(key)) {
      let parsed = null;
      try {
        const res = await fetchText(`https://api.avalanche.org/v2/public/product?type=forecast&center_id=${encodeURIComponent(z.centerId)}&zone_id=${encodeURIComponent(z.zoneId)}`);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const json = JSON.parse(res.text);
        if (!logged) { console.log(`avalanche.org product keys: ${Object.keys(json ?? {}).join(",")}; danger[0]: ${JSON.stringify(json?.danger?.[0] ?? null)}`); logged = true; }
        parsed = parseAvorgProduct(json);
      } catch (e) { console.log(`::warning::avalanche.org ${key}: ${e.message}`); }
      products.set(key, parsed);
      await sleep(500);
    }
    const p = products.get(key);
    const bands = p?.bands ?? null;
    const max = maxBand(bands) ?? z.mapLevel;
    out[r.id] = {
      source: "avalanche.org", center: z.center, zone: z.zone, link: z.link, offSeason: z.offSeason,
      issued: p?.issued ?? null, bands, max, problems: p?.problems ?? [], persistent: !!p?.persistent,
      history: withHistory(prev[r.id], today, max),
    };
  }

  // Canada: the point endpoint.
  for (const r of north.filter((x) => x.region === "Canada")) {
    const [lat, lon] = coordsOf(r);
    try {
      const res = await fetchText(`https://avcan-services-api.prod.avalanche.ca/forecasts/en/products/point?lat=${lat}&long=${lon}`);
      if (res.status === 404) continue;              // outside every forecast area
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const p = parseAvcanProduct(JSON.parse(res.text));
      const max = maxBand(p.bands);
      out[r.id] = { source: "avalanche.ca", ...p, offSeason: max == null, max, history: withHistory(prev[r.id], today, max) };
    } catch (e) { console.log(`::warning::avalanche.ca ${r.id}: ${e.message}`); }
    await sleep(500);
  }
  const rated = Object.values(out).filter((x) => x.max != null).length;
  console.log(`avalanche: ${Object.keys(out).length} resorts in a forecast zone, ${rated} with a current rating`);
  return out;
}

/** NOAA CPC 6–10 and 8–14 day outlooks at each US resort's point
 *  (mapservices.weather.noaa.gov, ArcGIS, public). Each layer answers with
 *  the polygon the point falls in: a category (Above / Below / Near normal,
 *  or EC = equal chances) and the probability of that category. The service
 *  has no week 3–4 layer. Secondary: failures warn, the file ships. */
const CPC = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks";
export function parseCpcAttrs(a) {
  if (!a) return null;
  const k = (re) => Object.keys(a).find((x) => re.test(x));
  const cat = a[k(/^cat/i)] ?? null;
  const prob = Number(a[k(/^prob/i)]);
  const norm = String(cat ?? "").toLowerCase();
  const category = /^a/.test(norm) ? "above" : /^b/.test(norm) ? "below" : /^n/.test(norm) ? "near" : /^ec|equal/.test(norm) ? "equal" : null;
  const day = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString().slice(0, 10) : null);
  return category ? { category, prob: Number.isFinite(prob) ? prob : null, start: day(a.start_date), end: day(a.end_date) } : null;
}
async function collectOutlook(resorts) {
  const out = {};
  let logged = false, ok = 0, tried = 0;
  for (const r of resorts.filter((x) => coordsOf(x) && !x.country && x.region !== "Canada")) {
    const [lat, lon] = coordsOf(r);
    const one = {};
    for (const [key, svc] of [["d6_10", "cpc_6_10_day_outlk"], ["d8_14", "cpc_8_14_day_outlk"]]) {
      for (const [layer, what] of [[0, "temp"], [1, "precip"]]) {
        tried++;
        try {
          const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
            spatialRel: "esriSpatialRelIntersects", outFields: "*", returnGeometry: "false", f: "json" });
          const res = await fetchText(`${CPC}/${svc}/MapServer/${layer}/query?${q}`);
          if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
          const json = JSON.parse(res.text);
          const attrs = json?.features?.[0]?.attributes ?? null;
          if (!logged && attrs) { console.log(`CPC attributes: ${JSON.stringify(attrs)}`); logged = true; }
          (one[key] ??= {})[what] = parseCpcAttrs(attrs);
          ok++;
        } catch (e) { console.log(`::warning::CPC ${svc}/${layer} ${r.id}: ${e.message}`); }
      }
    }
    out[r.id] = one;
  }
  console.log(`CPC outlooks: ${ok}/${tried} point queries answered`);
  return out;
}

/** ENSO status from CPC's monthly discussion: the alert line and synopsis. */
export function parseEnso(html) {
  const ent = { nbsp: " ", ntilde: "ñ", Ntilde: "Ñ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", ndash: "–", mdash: "—" };
  const text = String(html ?? "").replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ent[n] ?? m)
    .replace(/\s+/g, " ");
  const status = /ENSO Alert System Status:\s*([^.]+?)(?:\s{2,}|Synopsis|$)/i.exec(text)?.[1]?.trim() ?? null;
  const synopsis = /Synopsis:\s*([^.]+\.)/i.exec(text)?.[1]?.trim() ?? null;
  return status || synopsis ? { status, synopsis } : null;
}
async function collectEnso() {
  try {
    const res = await fetchText("https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml");
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const e = parseEnso(res.text);
    console.log(`ENSO: ${JSON.stringify(e)}`);
    if (!e) console.log("::warning::ENSO discussion: no status line found — the page shape may have moved");
    return e;
  } catch (e) { console.log(`::warning::ENSO: ${e.message}`); return null; }
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

  /* Station history (scripts/season/normals.js, monthly). Optional: without
     it depth vs normal and the rank are simply absent. */
  let normals = null;
  try {
    normals = JSON.parse(gunzipSync(await readFile(`${root}scripts/season/normals.json.gz`)).toString("utf8"));
    console.log(`normals: ${Object.keys(normals.stations ?? {}).length} stations, built ${normals.generatedAt}`);
  } catch { console.log("::warning::no scripts/season/normals.json.gz yet — depth vs normal and rank left out"); }

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
        summary: (() => {
          const sm = summarise(days, { slr, today });
          return sm ? { ...sm, ...againstHistory(normals?.stations?.[p.station.stationTriplet], { date: sm.asOf, depthCm: sm.depthCm, sweMm: sm.sweMm }) } : sm;
        })(),
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
  /* Resort reports (OnTheSnow /skireport, public pages the archive already
     reads twice a day): the resort's own daily snowfall for the last eight
     days and its base/summit depth. Two jobs: a check on our SNOTEL-based
     new-snow estimate, and the public depth source that is meant to replace
     Snow-Forecast's paid depths once it is as close (Brian, 2026-11-17).
     Secondary: a failure here is logged loudly but does not stop the file. */
  const check = [];
  let otsOk = 0, otsTried = 0;
  for (const r of resorts) {
    if (!out[r.id] || !r.otsPath) continue;
    otsTried++;
    try {
      const res = await fetchText(`https://www.onthesnow.com/${r.otsPath}/skireport`, { delayMs: 1500 });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const rows = skireportToRows(res.text, { resort: r, fetchedAt: now.toISOString(), runId: "season" });
      out[r.id].reported = reportedSummary(rows, out[r.id].asOf);
      otsOk++;
      const ours = out[r.id].new7Cm, theirs = out[r.id].reported.last7Cm;
      if (ours != null && theirs != null) check.push({ id: r.id, ours, theirs });
    } catch (e) {
      console.log(`::warning::onthesnow ${r.id}: ${e.message}`);
    }
    await sleep(1500);
  }
  console.log(`onthesnow: ${otsOk}/${otsTried} resort reports read`);
  if (otsTried && otsOk < otsTried / 2) console.log(`::error::onthesnow: only ${otsOk}/${otsTried} reports read — the page shape may have moved`);
  const cmp = compareNewSnow(check);
  console.log(`new-snow check (ours = SNOTEL SWE gain x SLR, theirs = resort-reported, 7 days):`);
  for (const c of check) console.log(`  ${c.id.padEnd(18)} ours ${String(c.ours).padStart(4)} cm   reported ${String(c.theirs).padStart(4)} cm`);
  console.log(`  summary: ${JSON.stringify(cmp)}`);

  const avalanche = await collectAvalanche(resorts, today);
  const outlook = await collectOutlook(resorts);
  const enso = await collectEnso();
  /* What past ENSO winters did per region (scripts/season/enso-history.js,
     monthly). Optional: without it the backdrop row says only NOAA's status. */
  let ensoHistory = null;
  try { ensoHistory = JSON.parse(await readFile(`${root}scripts/season/enso-history.json`, "utf8")); }
  catch { console.log("::warning::no scripts/season/enso-history.json yet — the El Niño row will carry NOAA's status only"); }

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
    newSnowCheck: cmp,
    avalanche,
    outlook,
    enso,
    ensoHistory,
    resorts: out,
  };
  await writeFile(`${outDir}/season.json`, JSON.stringify(doc));
  console.log(`wrote ${outDir}/season.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
