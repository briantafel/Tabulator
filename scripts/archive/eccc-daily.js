/* ------------------------------------------------------------------ *
 * Environment and Climate Change Canada, daily climate observations
 * (api.weather.gc.ca, OGC API Features). Ground truth for the Canadian
 * resorts where the BC snow pillows are too far away or too few: Whistler
 * Roundhouse (1835 m), Blackcomb (1540 m, 1860 m), Mt Copeland near Revelstoke,
 * Sunshine, Lake Louise, Fernie, Quebec and Ontario stations.
 *
 * Two collections: climate-stations (position, elevation, time zone, first and
 * last daily date) and climate-daily (one record per station per local day).
 * Daily fields used: TOTAL_SNOW (cm), TOTAL_PRECIPITATION (mm), SNOW_ON_GROUND
 * (cm), MAX_TEMPERATURE, MIN_TEMPERATURE (°C), each with a _FLAG. Null is
 * missing and writes no row, never a zero. A "T" flag (trace) is kept in
 * value_text. The record is a LOCAL day on standard time; we store it as the
 * UTC span of that day (station TIMEZONE), so a day is 24 h wherever it is.
 *
 * Same pattern as bc-asws.js: every run records the stations near each
 * Canadian resort (kind "mapping", with distance) and the views decide which
 * one stands in for a resort and tier. Licence: Open Government Licence – Canada.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "eccc-daily-2";
const BASE = "https://api.weather.gc.ca/collections";
const RADIUS_KM = 35;
const NEAREST = 8; // nearest stations kept per resort...
const HIGHEST = 3; // ...plus the highest ones in range, which see the mountain
const BOX_DEG = 0.5;
const LIVE_DAYS = 30; // daily data for manual stations arrives late; re-read a month, views keep the newest fetch

/** record field → archive variable, unit, per-value sensor/typo range (a value outside is dropped and counted). */
export const FIELDS = {
  TOTAL_SNOW: { variable: "total_snow", unit: "cm", fault: [0, 200] },
  TOTAL_PRECIPITATION: { variable: "total_precip", unit: "mm", fault: [0, 500] },
  SNOW_ON_GROUND: { variable: "snow_depth", unit: "cm", fault: [0, 1000] },
  MAX_TEMPERATURE: { variable: "temp_max", unit: "C", fault: [-60, 50] },
  MIN_TEMPERATURE: { variable: "temp_min", unit: "C", fault: [-65, 45] },
};
/** Standard-time offsets (hours) for the TIMEZONE field. An unknown one is loud. */
export const TZ_OFFSET = { PST: -8, MST: -7, CST: -6, EST: -5, AST: -4, NST: -3.5, PDT: -8, MDT: -7, CDT: -6, EDT: -5, ADT: -4 };

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};
// The station layer's LATITUDE/LONGITUDE are degrees-minutes-seconds packed in one integer:
// 485500000 = 48°55'00.000" = 48.9167 (found 2026-11-22; read as degrees ×1e7 it put stations tens of km off).
// GeoJSON geometry, in plain degrees, is preferred; this is the fallback. Plain degrees pass through.
export const dms = (v) => {
  const n = Number(v), a = Math.abs(n);
  if (a <= 1000) return n;
  const d = Math.floor(a / 1e7), m = Math.floor((a % 1e7) / 1e5), sec = (a % 1e5) / 1e3;
  return Math.sign(n) * (d + m / 60 + sec / 3600);
};
const day = (s) => (s ? String(s).slice(0, 10) : null);

/** GeoJSON features → [{ id, name, lat, lon, elevation_m, tz, first, last }]. Throws when the fields we rely on are gone. */
export function parseStations(features) {
  if (!Array.isArray(features)) throw new Error("station layer is not a feature list");
  if (features.length) {
    const keys = Object.keys(features[0].properties ?? {});
    for (const k of ["CLIMATE_IDENTIFIER", "STATION_NAME", "LATITUDE", "LONGITUDE", "ELEVATION", "TIMEZONE", "DLY_FIRST_DATE", "DLY_LAST_DATE"]) {
      if (!keys.includes(k)) throw new Error(`station layer lost field ${k}; it has: ${keys.join(", ")}`);
    }
  }
  const out = features.map((f) => { const p = f.properties, g = f.geometry?.coordinates;
    return [p, Array.isArray(g) && Number.isFinite(g[0]) && Number.isFinite(g[1]) ? [g[1], g[0]] : [dms(p.LATITUDE), dms(p.LONGITUDE)]]; }).map(([p, [lat, lon]]) => ({
    id: String(p.CLIMATE_IDENTIFIER).trim(), name: p.STATION_NAME ?? null, lat, lon,
    elevation_m: Number.isFinite(Number(p.ELEVATION)) && p.ELEVATION !== null ? Math.round(Number(p.ELEVATION)) : null,
    tz: p.TIMEZONE ?? null, first: day(p.DLY_FIRST_DATE), last: day(p.DLY_LAST_DATE),
  })).filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.first);
  // Every station is Canadian: a position outside the country means the coordinate format changed. Loud.
  const bad = out.filter((s) => s.lat < 41 || s.lat > 84 || s.lon < -142 || s.lon > -52);
  if (bad.length) throw new Error(`${bad.length} stations outside Canada (e.g. ${bad[0].id} at ${bad[0].lat}, ${bad[0].lon}) — coordinate format may have changed`);
  return out;
}

/** Per Canadian resort: the NEAREST closest stations and the HIGHEST highest ones within 35 km that have daily
 *  data overlapping [from, to] (YYYY-MM-DD). */
export function pickStations(stations, resorts, { from, to }) {
  const live = stations.filter((s) => s.first <= to && (s.last ?? "9999") >= from);
  const picks = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || r.region !== "Canada") continue;
    const near = live.map((s) => ({ s, d: km(c, [s.lat, s.lon]) })).filter((x) => x.d <= RADIUS_KM).sort((a, b) => a.d - b.d);
    const chosen = new Map(near.slice(0, NEAREST).map((x) => [x.s.id, x]));
    near.filter((x) => x.s.elevation_m != null).sort((a, b) => b.s.elevation_m - a.s.elevation_m).slice(0, HIGHEST)
      .forEach((x) => chosen.set(x.s.id, x));
    for (const x of chosen.values()) picks.push({ resort: r.id, station: x.s, km: Number(x.d.toFixed(2)) });
  }
  return picks;
}

export function mappingRows(picks, { fetchedAt, runId, parserVersion = PARSER_VERSION }) {
  return picks.map((p) => ({
    source: "eccc-daily", kind: "mapping", resort_id: p.resort, station_id: p.station.id,
    lat: p.station.lat, lon: p.station.lon, elevation_m: p.station.elevation_m,
    fetched_at: fetchedAt, variable: "candidate_distance", value: p.km, unit: "km",
    value_text: p.station.name, run_id: runId, parser_version: parserVersion,
  }));
}

/** "2025-01-14 00:00:00" local day + station TIMEZONE → [valid_start, valid_end] in UTC. */
export function dayWindow(localDate, tz) {
  const off = TZ_OFFSET[String(tz ?? "").toUpperCase()];
  if (off === undefined) throw new Error(`unknown station time zone "${tz}"`);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(localDate));
  if (!m) throw new Error(`unreadable date "${localDate}"`);
  const start = Date.parse(`${m[1]}T00:00:00Z`) - off * 3600e3;
  return [new Date(start).toISOString(), new Date(start + 24 * 3600e3).toISOString()];
}

/** Daily records → archive rows. Returns { rows, faults }. Null is no row. */
export function dailyRows(records, station, { fetchedAt, runId, parserVersion = PARSER_VERSION }) {
  const rows = []; let faults = 0;
  for (const p of records) {
    const [start, end] = dayWindow(p.LOCAL_DATE, station.tz);
    for (const [field, spec] of Object.entries(FIELDS)) {
      const raw = p[field];
      if (raw === null || raw === undefined || raw === "") continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      if (v < spec.fault[0] || v > spec.fault[1]) { faults++; continue; }
      rows.push({
        source: "eccc-daily", kind: "observation", station_id: station.id, lat: station.lat, lon: station.lon,
        elevation_m: station.elevation_m, fetched_at: fetchedAt, valid_start: start, valid_end: end, period_label: "daily",
        variable: spec.variable, value: v, unit: spec.unit, value_text: p[`${field}_FLAG`] ?? null,
        run_id: runId, parser_version: parserVersion,
      });
    }
  }
  return { rows, faults };
}

/** A unit change (snow in mm, say) shows as an absurd high end. */
export function checkUnits(rows) {
  const p99 = (v) => { const a = rows.filter((r) => r.variable === v).map((r) => r.value).sort((x, y) => x - y); return a.length >= 100 ? a[Math.floor(a.length * 0.99)] : null; };
  const s = p99("total_snow"), pr = p99("total_precip"), t = p99("temp_max");
  if (s !== null && s > 120) throw new Error(`daily snow p99 is ${s} — units may have changed (expected cm)`);
  if (pr !== null && pr > 250) throw new Error(`daily precipitation p99 is ${pr} — units may have changed (expected mm)`);
  if (t !== null && t > 45) throw new Error(`daily max temperature p99 is ${t} — units may have changed (expected °C)`);
}

async function getJson(url) {
  const { status, text } = await fetchText(url, { retries: 3, headers: { Accept: "application/json" } });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  return { json: JSON.parse(text), text };
}

/** Stations in a box around each Canadian resort, paged, de-duplicated. */
export async function fetchStations(resorts, rawPath) {
  const seen = new Map(), raws = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || r.region !== "Canada") continue;
    const bbox = [c[1] - BOX_DEG, c[0] - BOX_DEG, c[1] + BOX_DEG, c[0] + BOX_DEG].join(",");
    for (let offset = 0; ; offset += 500) {
      const { json, text } = await getJson(`${BASE}/climate-stations/items?f=json&limit=500&offset=${offset}&bbox=${bbox}`);
      raws.push(text);
      for (const s of parseStations(json.features)) seen.set(s.id, s);
      if ((json.features ?? []).length < 500) break;
    }
  }
  if (rawPath) await saveRaw(rawPath, raws.join("\n"));
  if (seen.size < 20) throw new Error(`only ${seen.size} stations came back for all Canadian resorts — expected hundreds`);
  return [...seen.values()];
}

/** One station's daily records between two YYYY-MM-DD dates, inclusive. */
export async function fetchDaily(id, from, to) {
  const out = [], texts = [];
  for (let offset = 0; ; offset += 1000) {
    const { json, text } = await getJson(`${BASE}/climate-daily/items?f=json&limit=1000&offset=${offset}&sortby=LOCAL_DATE&CLIMATE_IDENTIFIER=${encodeURIComponent(id)}&datetime=${from}/${to}`);
    texts.push(text);
    const feats = json.features ?? [];
    for (const f of feats) out.push(f.properties);
    if (feats.length < 1000) break;
  }
  return { records: out, text: texts.join("\n") };
}

/** Fetch rows for a set of picks over [from, to]. Never silent: a station that fails is listed, and too many failures throw. */
export async function collectWindow({ picks, from, to, fetchedAt, runId, parserVersion = PARSER_VERSION, log = () => {}, pace = 150 }) {
  const stations = new Map(picks.map((p) => [p.station.id, p.station]));
  const rows = [], raws = [], failed = [], silent = [];
  let faults = 0;
  for (const s of stations.values()) {
    try {
      const { records, text } = await fetchDaily(s.id, from, to);
      raws.push(text);
      const res = dailyRows(records, s, { fetchedAt, runId, parserVersion });
      faults += res.faults; res.rows.forEach((r) => rows.push(r));
      if (!res.rows.length) silent.push(s.id);
    } catch (e) { failed.push(`${s.id}: ${e.message}`); log(`  ✗ eccc-daily ${s.id} — ${e.message}`); }
    await sleep(pace);
  }
  if (failed.length > stations.size * 0.25) throw new Error(`${failed.length} of ${stations.size} stations failed: ${failed.slice(0, 3).join("; ")}`);
  checkUnits(rows);
  return { rows, raws, failed, silent, faults, stations: stations.size };
}

/** Per resort: how many chosen stations reported any snow or precipitation in the window. */
export function coverage(picks, rows) {
  const byStation = new Set(rows.filter((r) => r.variable === "total_snow" || r.variable === "total_precip").map((r) => r.station_id));
  const out = new Map();
  for (const p of picks) { const o = out.get(p.resort) ?? { stations: 0, reporting: 0 }; o.stations++; if (byStation.has(p.station.id)) o.reporting++; out.set(p.resort, o); }
  return out;
}

/** The live run: stations near each Canadian resort, the last 30 days of daily records. */
export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const to = fetchedAt.slice(0, 10);
  const from = new Date(Date.parse(fetchedAt) - LIVE_DAYS * 864e5).toISOString().slice(0, 10);
  const stations = await fetchStations(resorts, `${rawDir}/stations.json.gz`);
  const picks = pickStations(stations, resorts, { from, to });
  if (!picks.length) throw new Error("no Environment Canada station with daily data near any Canadian resort");
  mappingRows(picks, { fetchedAt, runId }).forEach((r) => sink.write(r));
  const res = await collectWindow({ picks, from, to, fetchedAt, runId, log });
  res.rows.forEach((r) => sink.write(r));
  await saveRaw(`${rawDir}/daily.ndjson.gz`, res.raws.join("\n"));
  const cov = coverage(picks, res.rows);
  const canada = resorts.filter((r) => coordsOf(r) && r.region === "Canada");
  canada.filter((r) => !cov.has(r.id)).forEach((r) => log(`  · eccc-daily: no station with daily data within ${RADIUS_KM} km of ${r.id}`));
  log(`eccc-daily: ${res.stations} stations for ${cov.size}/${canada.length} Canadian resorts, ${res.rows.length} values ${from} → ${to} (${res.faults} out-of-range dropped, ${res.failed.length} failed)`);
  return { ok: res.rows.length > 0 && res.failed.length === 0, stations: res.stations, resortsCovered: cov.size,
    readings: res.rows.length, failures: res.failed };
}
