#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Wind W2 backfill: public HISTORICAL wind observations into the archive as source=wind-obs, so the wind
 * veto model can be scored this season (claude/wind-model-plan-2026-11-23.md, W2).
 *
 *   node scripts/archive/wind-backfill.js <workDir>          (env: WB_SOURCE, WB_START, WB_END, WB_DRY, WB_STATION)
 *   WB_SOURCE=report node scripts/archive/wind-backfill.js <workDir>   (reads the done markers, prints the table)
 *
 * Sources (WB_SOURCE):
 *   iem-asos     Iowa Environmental Mesonet ASOS/AWOS METARs for the K-stations of src/data/wind-stations.json
 *   iem-hads     IEM HADS (RAWS and other data-collection platforms) for the other stations of that file
 *   eccc-hourly  ECCC climate-hourly, climate stations within 40 km of each Canadian app resort
 *   eccc-daily   ECCC climate-daily SPEED_MAX_GUST (own rows, period_label "daily", never mixed with hourly)
 *   snotel       NRCS AWDB hourly wind (WSPDV, WSPDX, WDIRV), stations within 40 km of US app resorts
 *
 * Rows are the same shape and names as the live wind-obs (wind-obs.js): wind_speed_mean, wind_gust_max, wind_dir_mean,
 * km/h and degrees (FROM), elevation_m of the STATION. Missing is no row, never 0. A blank METAR gust is not calm:
 * no gust row. Units are converted explicitly and an unknown unit is a loud error.
 *
 * RESUMABLE. The unit of work is one station for one UTC month. Each finished station-month gets a marker
 * backfill/done/wind-<source>-<yyyy-mm>-<station>.json in the bucket; a rerun skips those and retries the rest. All
 * stations finished in one month in one run go up together as ONE parquet,
 * archive/source=wind-obs/month=<yyyy-mm>/<runId>.parquet, runId = wind-hist-<source>-<yyyy-mm>-<github run>.
 * A failed station-month is printed, left without a marker, and the run ends red; the others stay uploaded.
 * WB_DRY=1 fetches and parses and writes the parquet locally but uploads and marks nothing.
 * ------------------------------------------------------------------ */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UA, coordsOf, rowSink, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "wind-backfill-1";
export const RADIUS_KM = 40;
const root = new URL("../..", import.meta.url).pathname;

// ---- pure helpers (unit-tested in test/wind-backfill.test.js) --------------------------------------------------

export const KMH_PER = { "km/h": 1, kph: 1, kmh: 1, "m/s": 3.6, mps: 3.6, kt: 1.852, kts: 1.852, knot: 1.852, knots: 1.852, mph: 1.609344, "mi/h": 1.609344 };
/** Speed to km/h from a named unit. An unknown unit is an error, never a guess. */
export function speedToKmh(v, unit) {
  const f = KMH_PER[String(unit ?? "").toLowerCase().replace(/\s/g, "")];
  if (f === undefined) throw new Error(`unknown wind unit "${unit}"`);
  return v * f;
}
const r2 = (x) => Number(x.toFixed(2));
const MAX_KMH = 400;

/** [{month:"2024-01", from:"2024-01-01", to:"2024-02-01"}], `to` exclusive, clipped to the inclusive start..end days. */
export function monthWindows(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error(`bad date range ${start}..${end}`);
  const out = [];
  const stop = new Date(Date.parse(`${end}T00:00:00Z`) + 864e5);
  for (let d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`); d < stop; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const from = new Date(Math.max(d.getTime(), Date.parse(`${start}T00:00:00Z`)));
    const to = new Date(Math.min(next.getTime(), stop.getTime()));
    out.push({ month: d.toISOString().slice(0, 7), from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  }
  return out;
}
/** Oct-Sep winter label: 2023-10 .. 2024-09 is "2023-24". */
export const winterOf = (month) => { const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)), s = m >= 10 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, "0")}`; };

const num = (v) => (v === null || v === undefined || v === "" || v === "M" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const utc = (s) => { // "2025-01-10 07:00:00" or "2025-01-10T07:00:00Z" as UTC
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${String(s).trim().replace(" ", "T")}Z`);
  if (Number.isNaN(t)) throw new Error(`bad timestamp "${s}"`);
  return t;
};

/** Row builder shared by every source. Out-of-range values are rejected (counted by the caller), never written. */
function makeRow(base, variable, value, unit, tStart, tEnd, period) {
  return { source: "wind-obs", kind: "observation", resort_id: null, tier: null, ...base, valid_start: new Date(tStart).toISOString(), valid_end: new Date(tEnd).toISOString(), period_label: period, variable, value, unit };
}
/** Pushes the speed, gust and direction rows of one reading. Calm has no direction; a missing value is no row. */
function pushReading(rows, rej, base, t, { speedKmh, gustKmh, dir }, period = "obs", tStart = t) {
  const ok = (v) => (v > MAX_KMH || v < 0 ? (rej.push(`${base.station_id} ${new Date(t).toISOString()} ${v}`), false) : true);
  if (speedKmh != null && ok(speedKmh)) rows.push(makeRow(base, "wind_speed_mean", r2(speedKmh), "km/h", tStart, t, period));
  if (gustKmh != null && gustKmh > 0 && ok(gustKmh)) rows.push(makeRow(base, "wind_gust_max", r2(gustKmh), "km/h", tStart, t, period));
  if (dir != null && dir >= 1 && dir <= 360 && speedKmh != null && speedKmh > 0) rows.push(makeRow(base, "wind_dir_mean", dir, "deg", tStart, t, period));
}

const splitCsv = (text) => text.replace(/\r/g, "").split("\n").filter((l) => l.trim());

/** IEM asos.py `format=onlycomma` with data=sknt,gust,drct (knots, knots, degrees). "M" = missing. A METAR with no gust group has
 *  gust "M": that is NOT calm and writes no gust row. station is {id, lat, lon, elev, name}; window clips to [fromMs, toMs). */
export function parseIemAsos(text, station, { fetchedAt, runId, fromMs = -Infinity, toMs = Infinity }) {
  const L = splitCsv(text);
  const H = (L.shift() ?? "").split(",");
  const ix = Object.fromEntries(["station", "valid", "sknt", "gust", "drct"].map((k) => [k, H.indexOf(k)]));
  if (Object.values(ix).some((i) => i < 0)) throw new Error(`IEM asos header unexpected: ${H.join(",").slice(0, 120)} / ${L[0] ?? ""}`.slice(0, 300));
  const base = { station_id: `iem:${station.id}`, lat: station.lat ?? null, lon: station.lon ?? null, elevation_m: station.elev != null ? Math.round(station.elev) : null,
    fetched_at: fetchedAt, model: "iem-asos", value_text: station.name ?? null, run_id: runId, parser_version: PARSER_VERSION };
  const rows = [], rej = [];
  let n = 0;
  for (const line of L) {
    const c = line.split(",");
    const t = utc(c[ix.valid]);
    if (t < fromMs || t >= toMs) continue;
    n++;
    const sk = num(c[ix.sknt]), g = num(c[ix.gust]), d = num(c[ix.drct]);
    pushReading(rows, rej, base, t, {
      speedKmh: sk == null ? null : speedToKmh(sk, "kt"), gustKmh: g == null ? null : speedToKmh(g, "kt"), dir: d,
    });
  }
  return { rows, rejected: rej, records: n };
}

/** IEM hads.py `what=txt&delim=comma`: station,valid,<SHEF columns>. US* = wind speed, UD* = direction, UG* = gust, UP* = peak wind.
 *  Returns the RAW readings (speed in the DCP's own unit, to be converted once the unit has been checked). Where a prefix has
 *  several columns the one with the most values wins. Values <= -999 are SHEF "missing". */
export function parseHadsRaw(text) {
  const L = splitCsv(text);
  if (!L.length) return { records: [], cols: {} };
  if (/^error/i.test(L[0])) return { records: [], cols: {}, empty: true };
  const H = L.shift().split(",");
  const iv = H.findIndex((h) => /valid/i.test(h));
  if (iv < 0) throw new Error(`IEM hads header unexpected: ${H.join(",").slice(0, 160)}`);
  const body = L.map((l) => l.split(","));
  const pick = (pre) => {
    const idx = H.map((h, i) => (h.startsWith(pre) ? i : -1)).filter((i) => i >= 0);
    let best = -1, bn = 0;
    for (const i of idx) { const k = body.filter((c) => num(c[i]) !== null && num(c[i]) > -999).length; if (k > bn) { best = i; bn = k; } }
    return best;
  };
  const col = { speed: pick("US"), dir: pick("UD"), gust: pick("UG"), peak: pick("UP") };
  const val = (c, i) => { if (i < 0) return null; const v = num(c[i]); return v === null || v <= -999 ? null : v; };
  const records = body.map((c) => ({ t: utc(c[iv]), speed: val(c, col.speed), dir: val(c, col.dir), gust: val(c, col.gust), peak: val(c, col.peak) }));
  return { records, cols: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, i < 0 ? null : H[i]])) };
}
/** Raw HADS readings to rows. The gust is UG when the platform sends one, else UP (peak wind): a platform peak, not a 3-second gust. */
export function hadsRows(records, station, { unit, fetchedAt, runId, fromMs = -Infinity, toMs = Infinity }) {
  const base = { station_id: `hads:${station.id}`, lat: station.lat ?? null, lon: station.lon ?? null, elevation_m: station.elev != null ? Math.round(station.elev) : null,
    fetched_at: fetchedAt, model: "iem-hads", value_text: station.name ?? null, run_id: runId, parser_version: PARSER_VERSION };
  const rows = [], rej = [];
  for (const r of records) {
    if (r.t < fromMs || r.t >= toMs) continue;
    if (r.speed == null && r.gust == null && r.peak == null) continue; // a transmission with no wind in it
    const gu = r.gust ?? r.peak;
    pushReading(rows, rej, base, r.t, { speedKmh: r.speed == null ? null : speedToKmh(r.speed, unit), gustKmh: gu == null ? null : speedToKmh(gu, unit), dir: r.dir });
  }
  return { rows, rejected: rej, records: records.length };
}
/** Which unit the HADS speeds are in, from paired readings (NWS km/h over raw HADS). The ratio must sit near exactly one known unit. */
export function detectUnit(ratios) {
  if (ratios.length < 15) throw new Error(`HADS unit check inconclusive: only ${ratios.length} paired readings (need 15)`);
  const s = [...ratios].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
  const cand = [["mph", 1.609344], ["kt", 1.852], ["m/s", 3.6], ["km/h", 1]];
  const hit = cand.filter(([, f]) => Math.abs(med / f - 1) <= 0.05);
  if (hit.length !== 1) throw new Error(`HADS unit check failed: median NWS(km/h)/HADS ratio ${med.toFixed(3)} matches ${hit.length ? "several" : "no known"} unit(s)`);
  return { unit: hit[0][0], median: med };
}

/** ECCC climate-hourly feature -> rows. WIND_SPEED is km/h; WIND_DIRECTION is in tens of degrees (0 = calm, 36 = north). */
export function eccchourlyRows(f, station, { fetchedAt, runId }) {
  const p = f.properties ?? {};
  const t = utc(p.UTC_DATE ?? "");
  const base = { station_id: `eccc:${station.id}`, lat: station.lat, lon: station.lon, elevation_m: station.elev != null ? Math.round(station.elev) : null,
    fetched_at: fetchedAt, model: "eccc-climate-hourly", value_text: station.name ?? null, run_id: runId, parser_version: PARSER_VERSION };
  const sp = num(p.WIND_SPEED), d10 = num(p.WIND_DIRECTION);
  if (d10 !== null && (d10 < 0 || d10 > 36)) throw new Error(`ECCC WIND_DIRECTION ${d10} at ${station.id} is not in tens of degrees (0-36)`);
  const rows = [], rej = [];
  pushReading(rows, rej, base, t, { speedKmh: sp, gustKmh: null, dir: d10 === null || d10 === 0 ? null : d10 * 10 });
  return { rows, rejected: rej, t };
}
const TZ_STD = { PST: -8, MST: -7, CST: -6, EST: -5, AST: -4, NST: -3.5 };
/** ECCC climate-daily feature -> a wind_gust_max row for the local-standard-time day. ECCC publishes the daily max gust only when it is
 *  at least ~30 km/h: below that the value is empty (no row) or flagged "<" (an upper bound, not a measurement: no row). */
export function ecccDailyRows(f, station, { fetchedAt, runId }) {
  const p = f.properties ?? {};
  const off = TZ_STD[String(station.tz ?? "").toUpperCase()];
  if (off === undefined) throw new Error(`ECCC station ${station.id} has unknown time zone "${station.tz}"`);
  const day = String(p.LOCAL_DATE ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`ECCC daily row without LOCAL_DATE at ${station.id}`);
  const v = num(p.SPEED_MAX_GUST), flag = String(p.SPEED_MAX_GUST_FLAG ?? "");
  if (v === null || flag.includes("<") || flag === "M") return { rows: [], rejected: [] };
  if (v <= 0 || v > MAX_KMH) return { rows: [], rejected: [`${station.id} ${day} ${v}`] };
  const start = Date.parse(`${day}T00:00:00Z`) - off * 3600e3;
  const base = { station_id: `eccc:${station.id}`, lat: station.lat, lon: station.lon, elevation_m: station.elev != null ? Math.round(station.elev) : null,
    fetched_at: fetchedAt, model: "eccc-climate-daily", value_text: station.name ?? null, run_id: runId, parser_version: PARSER_VERSION };
  return { rows: [makeRow(base, "wind_gust_max", r2(v), "km/h", start, start + 864e5, "daily")], rejected: [] };
}

/** AWDB hourly /data response -> rows. Units come from the response (storedUnitCode) and are converted explicitly. Hours are station
 *  local standard time (dataTimeZone). The speed is checked: the max (WSPDX) can never be below the mean (WSPDV) in the same hour. */
export function snotelWindRows(json, station, { fetchedAt, runId, fromMs = -Infinity, toMs = Infinity }) {
  const base = { station_id: `snotel:${station.id}`, lat: station.lat, lon: station.lon, elevation_m: station.elev != null ? Math.round(station.elev) : null,
    fetched_at: fetchedAt, model: "snotel", value_text: station.name ?? null, run_id: runId, parser_version: PARSER_VERSION };
  const byT = new Map(), units = {};
  for (const st of json ?? []) for (const el of st.data ?? []) {
    const code = el.stationElement?.elementCode, unit = el.stationElement?.storedUnitCode ?? el.stationElement?.unitCode;
    if (!["WSPDV", "WSPDX", "WDIRV"].includes(code)) continue;
    units[code] = unit;
    for (const v of el.values ?? []) {
      const [d, tm = "00:00"] = String(v.date).trim().split(/[ T]/);
      const t = Date.parse(`${d}T${tm.slice(0, 5)}:00Z`) - station.tzOffset * 3600e3;
      if (Number.isNaN(t)) throw new Error(`bad AWDB date "${v.date}" at ${station.id}`);
      if (t < fromMs || t >= toMs || num(v.value) === null) continue;
      (byT.get(t) ?? byT.set(t, {}).get(t))[code] = Number(v.value);
    }
  }
  if (units.WDIRV && !/^deg/i.test(units.WDIRV)) throw new Error(`unknown wind direction unit "${units.WDIRV}" at ${station.id}`);
  const rows = [], rej = [];
  let inverted = 0, pairs = 0;
  for (const [t, o] of [...byT].sort((a, b) => a[0] - b[0])) {
    const sp = o.WSPDV == null ? null : speedToKmh(o.WSPDV, units.WSPDV), gu = o.WSPDX == null ? null : speedToKmh(o.WSPDX, units.WSPDX);
    if (sp != null && gu != null) { pairs++; if (gu + 0.01 < sp) inverted++; }
    pushReading(rows, rej, base, t, { speedKmh: sp, gustKmh: gu, dir: o.WDIRV ?? null });
  }
  if (pairs >= 20 && inverted / pairs > 0.05) throw new Error(`SNOTEL ${station.id}: WSPDX below WSPDV in ${inverted}/${pairs} hours: units or elements are not what they claim`);
  return { rows, rejected: rej, units };
}

/** Chunk statistics for the marker and the run summary. */
export function statsOf(rows) {
  const by = {}, sh = new Set(), gh = new Set();
  for (const r of rows) {
    by[r.variable] = (by[r.variable] ?? 0) + 1;
    const h = Math.floor(Date.parse(r.valid_end) / 3600e3);
    if (r.variable === "wind_speed_mean") sh.add(h);
    if (r.variable === "wind_gust_max") gh.add(h);
  }
  return { rows: rows.length, by_var: by, speed_hours: sh.size, gust_hours: gh.size };
}

/** Per source, station and winter table from marker objects. */
export function summaryTable(markers) {
  const agg = new Map();
  for (const m of markers) {
    const k = `${m.source}|${m.station_id}|${winterOf(m.month)}`;
    const a = agg.get(k) ?? { source: m.source, station_id: m.station_id, elev: m.elev ?? null, winter: winterOf(m.month), rows: 0, speed: 0, gust: 0, dir: 0, speed_hours: 0, gust_hours: 0, months: 0 };
    a.rows += m.rows; a.speed += m.by_var?.wind_speed_mean ?? 0; a.gust += m.by_var?.wind_gust_max ?? 0; a.dir += m.by_var?.wind_dir_mean ?? 0;
    a.speed_hours += m.speed_hours ?? 0; a.gust_hours += m.gust_hours ?? 0; a.months++;
    agg.set(k, a);
  }
  const lines = ["| source | station | elev m | winter | months | rows | speed | gust | dir | gust share of speed hours |", "|---|---|---:|---|---:|---:|---:|---:|---:|---:|"];
  for (const a of [...agg.values()].sort((x, y) => (x.source + x.station_id + x.winter).localeCompare(y.source + y.station_id + y.winter))) {
    const share = a.source === "eccc-climate-daily" ? "daily" : a.speed_hours ? `${((100 * a.gust_hours) / a.speed_hours).toFixed(1)}%` : "-";
    lines.push(`| ${a.source} | ${a.station_id} | ${a.elev ?? "?"} | ${a.winter} | ${a.months} | ${a.rows} | ${a.speed} | ${a.gust} | ${a.dir} | ${share} |`);
  }
  const tot = {};
  for (const a of agg.values()) { const t = (tot[a.source] ??= { rows: 0, stations: new Set() }); t.rows += a.rows; t.stations.add(a.station_id); }
  lines.push("", ...Object.entries(tot).map(([s, t]) => `- ${s}: ${t.rows} rows, ${t.stations.size} stations`));
  return lines.join("\n");
}

// ---- everything below talks to the network and the bucket -------------------------------------------------------

const log = (s) => console.error(s);

async function get(url, { accept = "*/*", tries = 4, timeout = 120000, okEmpty404 = false } = {}) {
  let err = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(timeout) });
      const text = await res.text();
      if (res.ok) return text;
      if (res.status === 404 && okEmpty404) return null;
      err = `HTTP ${res.status} ${text.replace(/\s+/g, " ").slice(0, 160)}`;
      if (res.status < 500 && res.status !== 429) break;
      if (res.status === 429) await sleep(60000);
    } catch (e) { err = `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`; }
    await sleep(3000 * (i + 1) ** 2);
  }
  throw new Error(`${url.slice(0, 200)} -> ${err}`);
}
const getJson = async (url, o = {}) => { const t = await get(url, { accept: "application/json", ...o }); return t === null ? null : JSON.parse(t); };

const rad = Math.PI / 180;
const km = ([a, b], [c, d]) => { const x = Math.sin(((c - a) * rad) / 2), y = Math.sin(((d - b) * rad) / 2); return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * rad) * Math.cos(c * rad) * y * y)); };

// bucket access: the aws CLI with the R2 secrets in the environment, or a directory for tests (WB_LOCAL_BUCKET)
const LOCAL = process.env.WB_LOCAL_BUCKET, BUCKET = process.env.R2_BUCKET;
const ENDPOINT = process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
const aws = (...a) => execFileSync("aws", [...a, "--endpoint-url", ENDPOINT, "--only-show-errors"], { encoding: "utf8" });
function upload(localPath, key, recursive = false) {
  if (LOCAL) { const dest = join(LOCAL, key); mkdirSync(recursive ? dest : dirname(dest), { recursive: true }); cpSync(localPath, dest, { recursive }); return; }
  for (let attempt = 1; ; attempt++) {
    try { aws("s3", "cp", localPath, `s3://${BUCKET}/${key}`, ...(recursive ? ["--recursive"] : [])); return; }
    catch (e) { if (attempt >= 3) throw e; log(`  . upload of ${key} failed (try ${attempt}/3), retrying`); execFileSync("sleep", [String(5 * attempt)]); }
  }
}
function doneKeys(prefix) {
  if (LOCAL) { const d = join(LOCAL, "backfill/done"); return new Set(existsSync(d) ? readdirSync(d).filter((f) => f.startsWith(prefix)).map((f) => f.replace(/\.json$/, "")) : []); }
  let out = "";
  try { out = execFileSync("aws", ["s3", "ls", `s3://${BUCKET}/backfill/done/${prefix}`, "--endpoint-url", ENDPOINT], { encoding: "utf8", maxBuffer: 1 << 26 }); }
  catch { /* ls exits non-zero when nothing matches */ }
  return new Set(out.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter((f) => f?.endsWith(".json")).map((f) => f.slice(0, -5)));
}

const resortsJson = () => JSON.parse(readFileSync(`${root}src/data/resorts.json`, "utf8")).resorts;
const windStations = () => JSON.parse(readFileSync(`${root}src/data/wind-stations.json`, "utf8")).nws;

/** The stations of wind-stations.json as {id, name, elev, resorts:[[resort, km]]}. */
function listedStations() {
  const m = new Map();
  for (const [resort, ss] of Object.entries(windStations())) for (const s of ss) {
    const e = m.get(s.id) ?? { id: s.id, name: s.name, elev: s.elev ?? null, resorts: [] };
    e.resorts.push([resort, s.km]); m.set(s.id, e);
  }
  return [...m.values()];
}
async function iemStation(id, netRe) {
  const j = await getJson(`https://mesonet.agron.iastate.edu/api/1/station/${id}.json`, { okEmpty404: true, tries: 3 });
  const hit = (j?.data ?? []).find((x) => netRe.test(x.network));
  return hit ? { network: hit.network, lat: num(hit.latitude ?? hit.lat), lon: num(hit.longitude ?? hit.lon), elev: num(hit.elevation), begin: hit.archive_begin } : null;
}

/** Source adapters. prepare() -> {stations, notes}; fetchChunk(station, win, ctx) -> {rows, raw, rejected}. */
const ADAPTERS = {
  "iem-asos": {
    model: "iem-asos", sleepMs: 700,
    async prepare() {
      const stations = [], notes = [];
      for (const s of listedStations().filter((x) => /^K[A-Z]{3}$/.test(x.id))) {
        const meta = await iemStation(s.id.slice(1), /_(ASOS|AWOS)$/);
        await sleep(150);
        if (!meta) { notes.push(`${s.id}: no IEM ASOS/AWOS station (skipped)`); continue; }
        stations.push({ ...s, key: s.id, station_id: `iem:${s.id}`, lat: meta.lat, lon: meta.lon, elev: s.elev ?? meta.elev, network: meta.network });
      }
      return { stations, notes };
    },
    async fetchChunk(st, win, ctx) {
      const [y1, m1, d1] = win.from.split("-").map(Number), [y2, m2, d2] = win.to.split("-").map(Number);
      const q = new URLSearchParams({ station: st.id.slice(1), year1: y1, month1: m1, day1: d1, year2: y2, month2: m2, day2: d2, tz: "Etc/UTC", format: "onlycomma", latlon: "no", missing: "M", trace: "T", direct: "no" });
      for (const d of ["sknt", "gust", "drct"]) q.append("data", d);
      for (const t of ["3", "4"]) q.append("report_type", t);
      const text = await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${q}`);
      const r = parseIemAsos(text, st, { fetchedAt: ctx.fetchedAt, runId: ctx.runId(win), fromMs: Date.parse(`${win.from}T00:00:00Z`), toMs: Date.parse(`${win.to}T00:00:00Z`) });
      return { ...r, raw: text };
    },
  },
  "iem-hads": {
    model: "iem-hads", sleepMs: 600,
    async prepare(ctx) {
      const stations = [], notes = [];
      for (const s of listedStations().filter((x) => !/^K[A-Z]{3}$/.test(x.id))) {
        const meta = await iemStation(s.id, /_DCP$/);
        await sleep(150);
        if (!meta) { notes.push(`${s.id}: not a DCP station in IEM (skipped; not in IEM's HADS archive)`); continue; }
        stations.push({ ...s, key: s.id, station_id: `hads:${s.id}`, lat: meta.lat, lon: meta.lon, elev: s.elev ?? meta.elev, network: meta.network });
      }
      ctx.hadsUnit = await checkHadsUnit(stations, notes);
      return { stations, notes };
    },
    async fetchChunk(st, win, ctx) {
      const text = await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py?stations=${st.id}&sts=${win.from}T00:00Z&ets=${win.to}T00:00Z&what=txt&delim=comma`);
      const raw = parseHadsRaw(text);
      const r = hadsRows(raw.records, st, { unit: ctx.hadsUnit, fetchedAt: ctx.fetchedAt, runId: ctx.runId(win), fromMs: Date.parse(`${win.from}T00:00:00Z`), toMs: Date.parse(`${win.to}T00:00:00Z`) });
      if (!raw.empty && raw.records.length && !raw.cols.speed && !raw.cols.dir) ctx.noWind.add(st.id);
      if (ctx.hadsCols && !ctx.hadsCols.has(st.id) && raw.cols.speed !== undefined) { ctx.hadsCols.set(st.id, raw.cols); }
      return { ...r, raw: text, empty: raw.empty };
    },
  },
  "eccc-hourly": {
    model: "eccc-climate-hourly", sleepMs: 250,
    prepare: () => ecccStations("HLY"),
    async fetchChunk(st, win, ctx) {
      const a = new Date(Date.parse(`${win.from}T00:00:00Z`) - 864e5).toISOString().slice(0, 10), b = new Date(Date.parse(`${win.to}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
      const rows = [], rejected = [], raws = [];
      const fromMs = Date.parse(`${win.from}T00:00:00Z`), toMs = Date.parse(`${win.to}T00:00:00Z`);
      for (let off = 0, guard = 0; guard < 20; guard++, off += 1000) {
        const text = await get(`https://api.weather.gc.ca/collections/climate-hourly/items?f=json&limit=1000&offset=${off}&CLIMATE_IDENTIFIER=${st.id}&datetime=${a}T00:00:00Z/${b}T00:00:00Z`, { accept: "application/json" });
        raws.push(text);
        const feats = JSON.parse(text).features ?? [];
        for (const f of feats) { const r = eccchourlyRows(f, st, { fetchedAt: ctx.fetchedAt, runId: ctx.runId(win) }); if (r.t >= fromMs && r.t < toMs) { rows.push(...r.rows); rejected.push(...r.rejected); } }
        if (feats.length < 1000) break;
      }
      return { rows, rejected, raw: raws.join("\n") };
    },
  },
  "eccc-daily": {
    model: "eccc-climate-daily", sleepMs: 250,
    prepare: () => ecccStations("DLY"),
    async fetchChunk(st, win, ctx) {
      const text = await get(`https://api.weather.gc.ca/collections/climate-daily/items?f=json&limit=400&CLIMATE_IDENTIFIER=${st.id}&datetime=${win.from}T00:00:00Z/${new Date(Date.parse(`${win.to}T00:00:00Z`) - 864e5).toISOString().slice(0, 10)}T00:00:00Z`, { accept: "application/json" });
      const feats = JSON.parse(text).features ?? [];
      const rows = [], rejected = [];
      for (const f of feats) { const r = ecccDailyRows(f, st, { fetchedAt: ctx.fetchedAt, runId: ctx.runId(win) }); rows.push(...r.rows); rejected.push(...r.rejected); }
      return { rows, rejected, raw: text };
    },
  },
  snotel: {
    model: "snotel", sleepMs: 400,
    async prepare() {
      const API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
      const all = await getJson(`${API}/stations?elements=WSPDV&networkCds=SNTL&activeOnly=true`);
      if (!Array.isArray(all) || all.length < 100) throw new Error(`SNOTEL wind station list has ${all?.length ?? 0} entries (expected hundreds)`);
      const stations = new Map(), notes = [];
      for (const r of resortsJson().filter((x) => x.region !== "Canada" && x.nws)) {
        const c = coordsOf(r);
        for (const s of all) {
          const d = km(c, [s.latitude, s.longitude]);
          if (d > RADIUS_KM) continue;
          const e = stations.get(s.stationTriplet) ?? { id: s.stationTriplet, key: s.stationTriplet.replace(/:/g, "-"), station_id: `snotel:${s.stationTriplet}`, name: s.name, lat: s.latitude, lon: s.longitude,
            elev: Number.isFinite(s.elevation) ? Math.round(s.elevation * 0.3048) : null, tzOffset: Number(s.dataTimeZone), resorts: [] };
          e.resorts.push([r.id, Number(d.toFixed(1))]); stations.set(s.stationTriplet, e);
        }
      }
      for (const s of stations.values()) if (!Number.isFinite(s.tzOffset)) throw new Error(`${s.id} has no dataTimeZone`);
      notes.push(`SNOTEL: ${stations.size} wind stations within ${RADIUS_KM} km of US app resorts (of ${all.length} reporting wind network-wide)`);
      return { stations: [...stations.values()], notes };
    },
    async fetchChunk(st, win, ctx) {
      const last = new Date(Date.parse(`${win.to}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
      const q = new URLSearchParams({ stationTriplets: st.id, elements: "WSPDV,WSPDX,WDIRV", duration: "HOURLY", beginDate: `${win.from} 00:00`, endDate: `${last} 23:00` });
      const text = await get(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?${q}`, { accept: "application/json" });
      const r = snotelWindRows(JSON.parse(text), st, { fetchedAt: ctx.fetchedAt, runId: ctx.runId(win), fromMs: Date.parse(`${win.from}T00:00:00Z`), toMs: Date.parse(`${win.to}T00:00:00Z`) });
      for (const [k, u] of Object.entries(r.units)) ctx.units.add(`${k}=${u}`);
      return { ...r, raw: text };
    },
  },
};

/** ECCC climate stations within 40 km of each Canadian app resort (the probe's approach), with hourly (HLY) or daily (DLY) data. */
async function ecccStations(kind) {
  const found = new Map(), notes = [];
  for (const r of resortsJson().filter((x) => x.region === "Canada" && coordsOf(x))) {
    const c = coordsOf(r), d = 0.45, bbox = [c[1] - d, c[0] - d, c[1] + d, c[0] + d].join(",");
    const j = await getJson(`https://api.weather.gc.ca/collections/climate-stations/items?f=json&limit=300&bbox=${bbox}`);
    let n = 0;
    for (const f of j?.features ?? []) {
      const p = f.properties ?? {}, g = f.geometry?.coordinates; if (!g) continue;
      const dist = km(c, [g[1], g[0]]);
      if (dist > RADIUS_KM || !p[`${kind}_LAST_DATE`] || !p[`${kind}_FIRST_DATE`]) continue;
      const id = String(p.CLIMATE_IDENTIFIER);
      const e = found.get(id) ?? { id, key: id, station_id: `eccc:${id}`, name: p.STATION_NAME, lat: g[1], lon: g[0], elev: num(p.ELEVATION) === null ? null : Math.round(num(p.ELEVATION)),
        tz: p.TIMEZONE, first: String(p[`${kind}_FIRST_DATE`]).slice(0, 10), last: String(p[`${kind}_LAST_DATE`]).slice(0, 10), resorts: [] };
      e.resorts.push([r.id, Number(dist.toFixed(1))]); found.set(id, e); n++;
    }
    if (!n) notes.push(`${r.id}: no ECCC ${kind === "HLY" ? "hourly" : "daily"} station within ${RADIUS_KM} km`);
    await sleep(250);
  }
  const stations = [...found.values()].map((s) => ({ ...s, covers: (w) => s.last >= w.from && s.first < w.to }));
  return { stations, notes };
}

/** HADS unit check: pair the last 3 days of IEM HADS readings with the NWS API's reading of the same station (km/h, unit stated by NWS)
 *  and find which unit makes them agree. Aborts the source when it matches no known unit. */
async function checkHadsUnit(stations, notes) {
  const end = Date.now() - 3600e3, start = end - 72 * 3600e3;
  const iso = (t) => new Date(t).toISOString().slice(0, 16) + "Z";
  const ratios = [], per = [];
  for (const st of stations.filter((s) => ["HLLC1", "TADC1", "KNXN2", "RWBC1", "HVSC1", "STUC1", "OWNC1", "KCFW1"].includes(s.id)).slice(0, 5)) {
    const nws = await getJson(`https://api.weather.gov/stations/${st.id}/observations?start=${iso(start)}&end=${iso(end)}&limit=200`, { accept: "application/geo+json", okEmpty404: true, tries: 2 });
    const h = parseHadsRaw(await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py?stations=${st.id}&sts=${iso(start)}&ets=${iso(end)}&what=txt&delim=comma`)).records.filter((r) => r.speed != null && r.speed >= 1);
    let n = 0;
    for (const f of nws?.features ?? []) {
      const v = f.properties?.windSpeed, t = Date.parse(f.properties?.timestamp);
      if (!v || v.value == null || v.value < 3 || Number.isNaN(t)) continue;
      const kmh = speedToKmh(v.value, String(v.unitCode).replace(/^wmoUnit:/, "").replace("km_h-1", "km/h").replace("m_s-1", "m/s"));
      const near = h.map((r) => [Math.abs(r.t - t), r]).sort((a, b) => a[0] - b[0])[0];
      if (near && near[0] <= 15 * 60e3) { ratios.push(kmh / near[1].speed); n++; }
    }
    per.push(`${st.id}: ${n} pairs`);
    await sleep(500);
  }
  const d = detectUnit(ratios);
  notes.push(`HADS unit check (NWS km/h over raw IEM HADS, last 72 h, ${per.join(", ")}): median ratio ${d.median.toFixed(3)} => raw speeds are ${d.unit}`);
  return d.unit;
}

async function commit(ad, win, rows, raws, done, ctx) {
  const dir = join(ctx.work, `${ctx.source}-${win.month}`);
  rmSync(dir, { recursive: true, force: true });
  const sink = await rowSink(join(dir, "rows", "wind-obs.ndjson.gz"));
  rows.forEach((r) => sink.write(r));
  await sink.close();
  if (rows.length) execFileSync("python3", [join(root, "scripts/archive/to_parquet.py"), join(dir, "rows"), join(dir, "pq"), ctx.runId(win), win.month], { stdio: ["ignore", "ignore", "inherit"] });
  if (ctx.dry) { log(`  dry run: ${rows.length} rows for ${win.month}, parquet at ${dir}/pq (not uploaded, no markers)`); return; }
  if (rows.length) upload(join(dir, "pq"), "archive", true);
  for (const [name, text] of raws) { const p = join(dir, "raw", name); await saveRaw(p, text); upload(p, `raw/source=wind-obs/backfill/${name}`); }
  for (const m of done) { const p = join(dir, `${m.key}.json`); writeFileSync(p, JSON.stringify(m)); upload(p, `backfill/done/${m.key}.json`); }
  rmSync(dir, { recursive: true, force: true });
}

async function mappingChunk(ad, stations, ctx) {
  const key = `wind-${ctx.source}-mapping`;
  if (ctx.doneSet.has(key)) return;
  const rows = [];
  for (const s of stations) for (const [resort, dist] of s.resorts ?? []) {
    rows.push({ source: "wind-obs", kind: "mapping", resort_id: resort, station_id: s.station_id, lat: s.lat ?? null, lon: s.lon ?? null, elevation_m: s.elev ?? null, fetched_at: ctx.fetchedAt,
      variable: "candidate_distance", value: dist, unit: "km", value_text: s.name ?? null, model: ad.model, run_id: ctx.runId({ month: "mapping" }), parser_version: PARSER_VERSION });
  }
  const month = ctx.fetchedAt.slice(0, 7), dir = join(ctx.work, key);
  rmSync(dir, { recursive: true, force: true });
  const sink = await rowSink(join(dir, "rows", "wind-obs.ndjson.gz"));
  rows.forEach((r) => sink.write(r));
  await sink.close();
  execFileSync("python3", [join(root, "scripts/archive/to_parquet.py"), join(dir, "rows"), join(dir, "pq"), ctx.runId({ month: "mapping" }), month], { stdio: ["ignore", "ignore", "inherit"] });
  if (ctx.dry) { log(`  dry run: ${rows.length} mapping rows (not uploaded)`); return; }
  upload(join(dir, "pq"), "archive", true);
  const p = join(dir, "done.json");
  writeFileSync(p, JSON.stringify({ key, rows: rows.length, at: new Date().toISOString() }));
  upload(p, `backfill/done/${key}.json`);
  rmSync(dir, { recursive: true, force: true });
}

async function report(work) {
  const dir = join(work, "markers");
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  if (LOCAL) cpSync(join(LOCAL, "backfill/done"), dir, { recursive: true });
  else execFileSync("aws", ["s3", "sync", `s3://${BUCKET}/backfill/done/`, dir, "--exclude", "*", "--include", "wind-*", "--endpoint-url", ENDPOINT, "--only-show-errors"], { stdio: ["ignore", "inherit", "inherit"] });
  const markers = readdirSync(dir).filter((f) => f.startsWith("wind-") && !f.endsWith("-mapping.json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).filter((m) => m.station_id);
  const txt = `## wind-backfill report (${markers.length} station-month markers)\n\n${summaryTable(markers)}\n`;
  console.log(txt);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, txt);
  const have = new Set(markers.map((m) => m.station_id.split(":").pop()));
  const spot = ["SLIDE", "STORM", "HMDC1", "KCPW", "KCCU", "KNXN2", "TADC1"].map((s) => `${s}: ${have.has(s) ? "PRESENT" : "absent"}`).join(", ");
  console.log(`spot check: ${spot}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nspot check: ${spot}\n`);
}

async function main() {
  const work = process.argv[2];
  const source = process.env.WB_SOURCE;
  if (!work) { console.error("usage: wind-backfill.js <workDir>  (env WB_SOURCE, WB_START, WB_END, WB_DRY, WB_STATION)"); process.exit(2); }
  if (!LOCAL && !(BUCKET && ENDPOINT)) { log("no bucket: set R2_BUCKET and R2_ACCOUNT_ID (or WB_LOCAL_BUCKET)"); process.exit(2); }
  if (source === "report") return report(work);
  const ad = ADAPTERS[source];
  if (!ad) { log(`WB_SOURCE must be one of ${Object.keys(ADAPTERS).join(", ")} or report (got "${source}")`); process.exit(2); }
  const start = process.env.WB_START || "2023-10-01", end = process.env.WB_END || "2026-11-22";
  const dry = /^(1|true|yes)$/i.test(process.env.WB_DRY ?? "");
  const only = (process.env.WB_STATION ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const fetchedAt = new Date().toISOString();
  const ghRun = process.env.GITHUB_RUN_ID ?? "local";
  const ctx = { work, source, dry, fetchedAt, runId: (w) => `wind-hist-${source}-${w.month}-${ghRun}`, hadsUnit: null, hadsCols: new Map(), noWind: new Set(), units: new Set() };
  const deadline = Date.now() + 5.4 * 3600e3;
  const failures = [], rejectedAll = [], emptyChunks = [], madeMarkers = [], unrun = [];
  log(`wind-backfill ${source} ${start}..${end}${dry ? " (DRY RUN)" : ""}${only.length ? ` stations ${only.join(",")}` : ""}, run ${ghRun}`);

  const prep = await ad.prepare(ctx);
  let stations = prep.stations;
  if (only.length) stations = stations.filter((s) => only.includes(s.id) || only.includes(s.station_id));
  prep.notes.forEach((n) => log(`  note: ${n}`));
  if (!stations.length) throw new Error("no stations to fetch");
  log(`${stations.length} stations: ${stations.map((s) => `${s.id}(${s.elev ?? "?"}m)`).join(" ")}`);
  ctx.doneSet = dry ? new Set() : doneKeys(`wind-${source}-`);
  if (!only.length || dry) await mappingChunk(ad, stations, ctx);

  for (const win of monthWindows(start, end)) {
    if (Date.now() > deadline) { unrun.push(win.month); continue; }
    const pending = stations.filter((s) => (!s.covers || s.covers(win)) && !ctx.doneSet.has(`wind-${source}-${win.month}-${s.key}`));
    if (!pending.length) { log(`${win.month}: nothing to do`); continue; }
    const rows = [], raws = [], done = [];
    for (const st of pending) {
      const key = `wind-${source}-${win.month}-${st.key}`;
      try {
        const r = await ad.fetchChunk(st, win, ctx);
        if (r.rejected?.length) { rejectedAll.push(...r.rejected); log(`  ! ${key}: rejected ${r.rejected.length} implausible reading(s), e.g. ${r.rejected[0]}`); }
        rows.push(...r.rows);
        raws.push([`${key}.gz`, r.raw ?? ""]);
        if (!r.rows.length) emptyChunks.push(key);
        done.push({ key, source: ad.model, station_id: st.station_id, month: win.month, elev: st.elev ?? null, at: new Date().toISOString(), run_id: ctx.runId(win), rejected: r.rejected?.length ?? 0, ...statsOf(r.rows) });
        if (dry && done.length <= 2) log(`  sample ${key}: ${r.rows.slice(0, 3).map((x) => `${x.variable}=${x.value}@${x.valid_end}`).join(" ; ") || "no rows"}\n    raw head: ${String(r.raw ?? "").replace(/\s*\n\s*/g, " // ").slice(0, 420)}`);
      } catch (e) { failures.push(`${key}: ${e.message}`); log(`  X ${key} FAILED: ${e.message}`); }
      await sleep(ad.sleepMs);
    }
    try {
      await commit(ad, win, rows, raws, done, ctx);
      madeMarkers.push(...done);
      log(`${win.month}: ${done.length}/${pending.length} stations, ${rows.length} rows${dry ? " (dry)" : " uploaded"}`);
    } catch (e) { for (const m of done) failures.push(`${m.key}: commit/upload failed: ${e.message}`); log(`  X ${win.month} commit failed: ${e.message}`); }
  }

  const lines = [`## wind-backfill ${source} ${start}..${end}${dry ? " (DRY RUN)" : ""}`, "", ...prep.notes.map((n) => `- ${n}`)];
  if (ctx.units.size) lines.push(`- SNOTEL units in responses: ${[...ctx.units].join(", ")}`);
  if (ctx.hadsCols.size) lines.push(`- HADS columns used: ${[...ctx.hadsCols].slice(0, 6).map(([id, c]) => `${id}=${JSON.stringify(c)}`).join("; ")}`);
  if (ctx.noWind.size) lines.push(`- HADS stations with records but no speed or direction column: ${[...ctx.noWind].join(", ")}`);
  lines.push(`- station-months done this run: ${madeMarkers.length}; with zero rows: ${emptyChunks.length}${emptyChunks.length ? ` (${emptyChunks.slice(0, 40).join(", ")}${emptyChunks.length > 40 ? " ..." : ""})` : ""}`);
  lines.push(`- rejected implausible readings: ${rejectedAll.length}`);
  if (unrun.length) lines.push(`- **NOT RUN (time limit): ${unrun.join(", ")}. Dispatch again; finished chunks are skipped.**`);
  lines.push("", madeMarkers.length ? summaryTable(madeMarkers) : "(nothing new this run)");
  if (failures.length) lines.push("", `### FAILED chunks (${failures.length})`, ...failures.map((f) => `- ${f}`));
  const txt = lines.join("\n") + "\n";
  console.log(txt);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, txt);
  if (failures.length || unrun.length) {
    console.log(`::error title=wind-backfill ${source}::${failures.length} failed chunk(s), ${unrun.length} month(s) not run. First: ${(failures[0] ?? "time limit").replace(/[\r\n]+/g, " ").slice(0, 300)}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`wind-backfill failed: ${e.stack ?? e.message}`); console.log(`::error title=wind-backfill::${String(e.message).replace(/[\r\n]+/g, " ").slice(0, 300)}`); process.exit(1); });
}
