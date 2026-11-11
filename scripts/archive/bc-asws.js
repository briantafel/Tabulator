/* ------------------------------------------------------------------ *
 * BC Automated Snow Weather Stations (River Forecast Centre): what fell
 * at BC's high-elevation snow pillows. Ground truth for the BC and
 * border-Rockies resorts, the way SNOTEL is for the US.
 *
 * Same pattern as snotel.js: every run records up to three stations within
 * 30 km of each Canadian resort (kind "mapping", with distance), and the
 * views decide which one stands in for a resort and tier.
 *
 * The data are four wide CSVs (one per variable), one column per station,
 * one row per hour, in UTC:
 *     DATE(UTC),1A01P Yellowhead Lake,1A02P McBride Upper,...
 *     2026-10-01 00:00,0,0,0,4,3
 * The "current" files hold the water year since Oct 1; the "_Archive" files
 * hold every earlier year (large: streamed, never held whole in memory).
 * Blank cells are missing, never zero.
 *
 * Units (BC RFC): SWE mm, snow depth cm, cumulative precipitation mm, air
 * temperature °C. Each run checks the values are in a plausible range for
 * those units, and throws if not, so a unit change can't slip through.
 *
 * Licence: Open Government Licence – British Columbia (attribution).
 * ------------------------------------------------------------------ */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { UA, coordsOf, fetchText, saveRaw } from "./common.js";

export const PARSER_VERSION = "bc-asws-1";
const BASE = "https://www.env.gov.bc.ca/wsd/data_searches/snow/asws/data";
export const STATIONS_URL = "https://openmaps.gov.bc.ca/geo/pub/WHSE_WATER_MANAGEMENT.SSL_SNOW_ASWS_STNS_SP/ows?" +
  new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature",
    typeName: "pub:WHSE_WATER_MANAGEMENT.SSL_SNOW_ASWS_STNS_SP", outputFormat: "json", srsName: "EPSG:4326" });

/** file code → archive variable, unit, plausible range (a value outside it is
 *  a unit change or a broken file — loud), and per-value sensor-fault range
 *  (a single value outside it is dropped and counted). */
export const FILES = {
  SW: { variable: "swe", unit: "mm", fault: [-50, 5000] },
  SD: { variable: "snow_depth", unit: "cm", fault: [-50, 1500] },
  PC: { variable: "precip_accum", unit: "mm", fault: [-50, 10000] },
  TA: { variable: "temp", unit: "C", fault: [-60, 45] },
};
export const currentUrl = (code) => `${BASE}/${code}.csv`;
export const archiveUrl = (code) => `${BASE}/${code}_Archive.csv`;

const RADIUS_KM = 30;
const PER_RESORT = 3;
const HOURS_BACK = 72; // the live run keeps the last 3 days; views keep the newest fetch

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};

/** WFS GeoJSON → [{ id, name, lat, lon, elevation_m, active }]. Throws if the
 *  fields we rely on are gone, naming the ones that are there. */
export function parseStations(json) {
  const feats = json?.features;
  if (!Array.isArray(feats) || feats.length < 20) throw new Error(`station layer has ${feats?.length ?? 0} features — expected 100+`);
  const keys = Object.keys(feats[0].properties ?? {});
  for (const k of ["LOCATION_ID", "LOCATION_NAME", "ELEVATION"]) {
    if (!keys.includes(k)) throw new Error(`station layer lost field ${k}; it has: ${keys.join(", ")}`);
  }
  return feats.map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry?.coordinates ?? [p.LONGITUDE, p.LATITUDE];
    return {
      id: String(p.LOCATION_ID).trim(), name: p.LOCATION_NAME ?? null,
      lat: Number(p.LATITUDE ?? lat), lon: Number(p.LONGITUDE ?? lon),
      elevation_m: Number.isFinite(Number(p.ELEVATION)) ? Math.round(Number(p.ELEVATION)) : null,
      active: p.STATUS == null ? true : /^active$/i.test(String(p.STATUS).trim()),
    };
  }).filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

/** Up to three stations within 30 km of each Canadian resort. Inactive
 *  stations are kept for the backfill (they may have reported in past
 *  winters); the live run asks for active ones. */
export function pickStations(stations, resorts, { activeOnly = true } = {}) {
  const pool = stations.filter((s) => !activeOnly || s.active);
  const picks = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || r.region !== "Canada") continue;
    pool.map((s) => ({ s, d: km(c, [s.lat, s.lon]) }))
      .filter((x) => x.d <= RADIUS_KM).sort((a, b) => a.d - b.d).slice(0, PER_RESORT)
      .forEach((x) => picks.push({ resort: r.id, station: x.s, km: Number(x.d.toFixed(2)) }));
  }
  return picks;
}

export function mappingRows(picks, { fetchedAt, runId, parserVersion = PARSER_VERSION }) {
  return picks.map((p) => ({
    source: "bc-asws", kind: "mapping", resort_id: p.resort, station_id: p.station.id,
    lat: p.station.lat, lon: p.station.lon, elevation_m: p.station.elevation_m,
    fetched_at: fetchedAt, variable: "candidate_distance", value: p.km, unit: "km",
    value_text: p.station.name, run_id: runId, parser_version: parserVersion,
  }));
}

/** "2026-10-01 00:00" (UTC) → ISO. Anything else throws. */
export function parseTime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(s.trim());
  if (!m) throw new Error(`unreadable time "${s}"`);
  return `${m[1]}T${m[2]}:${m[3]}:00.000Z`;
}

/** Parse a wide CSV line by line. `lines` is an async (or sync) iterable of
 *  strings. Calls onRow(row) for each kept value; returns counts.
 *  Keeps stations in `wanted` (Map id → station) and times in [from, to). */
export async function parseWide(lines, code, { wanted, from, to, fetchedAt, runId, parserVersion = PARSER_VERSION, onRow }) {
  const spec = FILES[code];
  if (!spec) throw new Error(`unknown file code ${code}`);
  let cols = null, kept = 0, faults = 0, rowsSeen = 0, first = null, last = null;
  const seenIds = new Set();
  for await (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const cells = line.split(",");
    if (!cols) {
      if (!/^DATE\(UTC\)$/i.test(cells[0].trim())) throw new Error(`${code}: first column is "${cells[0]}", expected DATE(UTC)`);
      cols = cells.map((c, i) => (i === 0 ? null : c.trim().split(/\s+/)[0]));
      cols.forEach((id) => id && seenIds.add(id));
      continue;
    }
    rowsSeen++;
    const t = parseTime(cells[0]);
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
    if ((from && t < from) || (to && t >= to)) continue;
    for (let i = 1; i < cells.length; i++) {
      const id = cols[i];
      if (!id || !wanted.has(id)) continue;
      const cell = cells[i].trim();
      if (cell === "") continue; // missing is no row
      const v = Number(cell);
      if (!Number.isFinite(v)) continue;
      if (v < spec.fault[0] || v > spec.fault[1]) { faults++; continue; }
      const s = wanted.get(id);
      onRow({
        source: "bc-asws", kind: "observation", station_id: id, lat: s.lat, lon: s.lon, elevation_m: s.elevation_m,
        fetched_at: fetchedAt, valid_start: t, valid_end: t, period_label: "hourly",
        variable: spec.variable, value: v, unit: spec.unit, run_id: runId, parser_version: parserVersion,
      });
      kept++;
    }
  }
  if (!cols) throw new Error(`${code}: empty file`);
  const missing = [...wanted.keys()].filter((id) => !seenIds.has(id));
  return { kept, faults, rowsSeen, first, last, missingStations: missing };
}

/** Plausibility check on one variable's kept values: catches a unit change
 *  (e.g. SWE arriving in cm) without needing a known-good reference. */
export function checkUnits(code, values) {
  if (values.length < 50) return;
  const sorted = [...values].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const rules = { SW: [p99 <= 4000, "SWE p99 above 4000 mm"], SD: [p99 <= 1200, "depth p99 above 1200 cm"],
    TA: [p99 <= 40 && sorted[Math.floor(sorted.length * 0.01)] >= -55, "temperature outside −55…40 °C"] };
  const r = rules[code];
  if (r && !r[0]) throw new Error(`${code}: ${r[1]} (p99 ${p99}) — units may have changed`);
}

/** Download a (possibly large) file to disk as gzip, then stream its lines.
 *  Returns { lines(), path }. The gzip is the raw record. */
/** Whole-transfer limit per attempt. The current files are ~0.3 MB a day of
 *  the season; the _Archive files are large. Without a limit a stalled
 *  server would hang the archive run until GitHub cancels it, and a
 *  cancelled run uploads nothing from any source. */
export async function download(url, gzPath, { timeoutMs = 4 * 60e3 } = {}) {
  await mkdir(dirname(gzPath), { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 5000 * attempt));
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createGzip(), createWriteStream(gzPath), { signal });
      return gzPath;
    } catch (e) { lastErr = e; }
  }
  const cause = lastErr.cause?.code || lastErr.cause?.message;
  throw new Error(`${url}: ${lastErr.message}${cause ? ` (${cause})` : ""}`);
}

export async function* gzLines(gzPath) {
  const { createGunzip } = await import("node:zlib");
  const rl = createInterface({ input: createReadStream(gzPath).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) yield l;
}

export async function fetchStations(rawPath) {
  const { status, text } = await fetchText(STATIONS_URL, { retries: 3 });
  if (status !== 200) throw new Error(`station layer HTTP ${status}: ${text.slice(0, 200)}`);
  if (rawPath) await saveRaw(rawPath, text);
  return parseStations(JSON.parse(text));
}

/** The twice-daily run: station mapping + the last 72 hours of all four files. */
export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  const stations = await fetchStations(`${rawDir}/stations.json.gz`);
  const picks = pickStations(stations, resorts);
  mappingRows(picks, { fetchedAt, runId }).forEach((r) => sink.write(r));
  const wanted = new Map(picks.map((p) => [p.station.id, p.station]));
  const canada = resorts.filter((r) => coordsOf(r) && r.region === "Canada");
  const covered = new Set(picks.map((p) => p.resort));
  canada.filter((r) => !covered.has(r.id)).forEach((r) => log(`  · bc-asws: no station within ${RADIUS_KM} km of ${r.id}`));
  if (!wanted.size) throw new Error("no BC ASWS station near any Canadian resort");

  const from = new Date(Date.parse(fetchedAt) - HOURS_BACK * 3600e3).toISOString();
  let rowsOut = 0, ok = 0;
  for (const code of Object.keys(FILES)) {
    try {
      const gz = await download(currentUrl(code), `${rawDir}/${code}.csv.gz`);
      // Hold this file's rows until its unit check passes: a file in the
      // wrong unit must not reach the archive. Each file stands alone, so
      // one bad file costs only that variable for this run.
      const held = [];
      const res = await parseWide(gzLines(gz), code, { wanted, from, fetchedAt, runId, onRow: (r) => held.push(r) });
      checkUnits(code, held.map((r) => r.value));
      held.forEach((r) => sink.write(r));
      if (res.last && Date.parse(fetchedAt) - Date.parse(res.last) > 48 * 3600e3) {
        throw new Error(`newest row is ${res.last} — the file has not updated in 2+ days`);
      }
      if (res.missingStations.length) log(`  · bc-asws ${code}: not in file: ${res.missingStations.join(", ")}`);
      rowsOut += res.kept; ok++;
      log(`  bc-asws ${code}: ${res.kept} readings (${res.faults} out-of-range dropped), file ${res.first} → ${res.last}`);
    } catch (e) {
      failures.push(`${code}: ${e.message}`);
      log(`  ✗ bc-asws ${code} — ${e.message}`);
    }
  }
  log(`bc-asws: ${wanted.size} stations for ${covered.size}/${canada.length} Canadian resorts, ${rowsOut} readings`);
  return { ok: ok === Object.keys(FILES).length && rowsOut > 0, stations: wanted.size,
    resortsCovered: covered.size, readings: rowsOut, failures };
}
