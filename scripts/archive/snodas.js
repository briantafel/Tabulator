/* ------------------------------------------------------------------ *
 * SNODAS (NOAA NOHRSC Snow Data Assimilation System) via NSIDC G02158.
 * Added 2026-11-11 (claude/lean-data-plan.md).
 *
 * A daily ~1 km gridded analysis of the snowpack that blends a snow model
 * with ground, airborne and satellite observations. It is the only "truth"
 * that exists on the mountain itself rather than at a station in a valley,
 * so it fills the gaps between SNOTEL/CoCoRaHS sites. It is a model
 * analysis, not a measurement: kind "analysis", and verification must
 * treat it as a second-tier truth.
 *
 * File: https://noaadata.apps.nsidc.org/NOAA/G02158/unmasked/YYYY/MM_Mon/SNODAS_unmasked_YYYYMMDD.tar
 * The "unmasked" grid reaches into southern Canada (Whistler, Revelstoke,
 * Banff); outside the US it has fewer observations behind it.
 * Each tar holds gzipped flat binary grids (16-bit big-endian signed) plus
 * a text header per product. Grid size, corner coordinates, scale and
 * no-data value are read from each header; a missing key fails loudly.
 * Licence: public domain (US Government); cite NOHRSC/NSIDC G02158.
 *
 * Valid time: the snapshot is 06 UTC on the file date; the precipitation
 * products are 24 h totals ending then. Each run fetches the last 3 days.
 * For each resort: the cell at its coordinates, and the maximum over the
 * 5x5 cells (~4 km) around it, a rough stand-in for upper-mountain terrain.
 * ------------------------------------------------------------------ */

import { gunzipSync } from "node:zlib";
import { coordsOf, saveRaw, sleep, UA } from "./common.js";

export const PARSER_VERSION = "snodas-1";
const BASE = "https://noaadata.apps.nsidc.org/NOAA/G02158/unmasked";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = 3;

/* Product code in the file name → [variable, unit, instant?, divisor to reach the unit]. */
export const PRODUCTS = {
  "11034": ["swe", "mm", true],
  "11036": ["snow_depth", "cm", true],
  "01025SlL00": ["snowfall_water_24h", "mm", false],
  "01025SlL01": ["rain_24h", "mm", false],
};

export function tarEntries(buf) {
  const out = [];
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.toString("latin1", o, o + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(buf.toString("latin1", o + 124, o + 136).replace(/\0.*$/s, "").trim() || "0", 8);
    out.push({ name, data: buf.subarray(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export function productOf(name) {
  for (const code of Object.keys(PRODUCTS)) if (name.includes(`ssmv${code}`)) return code;
  return null;
}

/** "Key: value" header → the numbers we need. Throws on a missing key. */
export function parseHeader(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) kv[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const num = (k) => {
    const v = Number(kv[k]);
    if (!Number.isFinite(v)) throw new Error(`SNODAS header has no numeric "${k}" — the format changed`);
    return v;
  };
  return {
    cols: num("number of columns"), rows: num("number of rows"),
    minX: num("minimum x-axis coordinate"), maxY: num("maximum y-axis coordinate"),
    dx: num("x-axis resolution"), dy: num("y-axis resolution"),
    noData: num("no data value"),
    slope: Number.isFinite(Number(kv["data slope"])) ? Number(kv["data slope"]) : null,
    intercept: Number.isFinite(Number(kv["data intercept"])) ? Number(kv["data intercept"]) : 0,
    units: kv["data units"] ?? "",
  };
}

/** Physical value in the archive unit, from a raw cell. */
export function toUnit(code, raw, h) {
  if (raw === h.noData || raw < 0) return null;
  const [, unit] = PRODUCTS[code];
  // Header slope turns the raw integer into the header unit (meters, or kg/m^2).
  const slope = h.slope ?? (code.startsWith("01025") ? 0.1 : 0.001);
  const v = raw * slope + h.intercept;
  const metres = /meter/i.test(h.units);
  const out = unit === "cm" ? (metres ? v * 100 : v / 10) : metres ? v * 1000 : v; // kg/m^2 == mm
  return Number(out.toFixed(1));
}

export function sample(grid, h, lat, lon) {
  const col = Math.floor((lon - h.minX) / h.dx), row = Math.floor((h.maxY - lat) / h.dy);
  if (col < 0 || row < 0 || col >= h.cols || row >= h.rows) return null;
  const at = (r, c) => grid.readInt16BE(2 * (r * h.cols + c));
  let max = null;
  for (let r = Math.max(0, row - 2); r <= Math.min(h.rows - 1, row + 2); r++)
    for (let c = Math.max(0, col - 2); c <= Math.min(h.cols - 1, col + 2); c++) {
      const v = at(r, c);
      if (v !== h.noData && v >= 0 && (max === null || v > max)) max = v;
    }
  return { row, col, cell: at(row, col), max };
}

export function urlFor(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = String(d.getUTCDate()).padStart(2, "0");
  return `${BASE}/${y}/${String(m + 1).padStart(2, "0")}_${MONTHS[m]}/SNODAS_unmasked_${y}${String(m + 1).padStart(2, "0")}${day}.tar`;
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  const targets = resorts.filter((r) => coordsOf(r) && (!r.country || r.country === "US" || r.country === "CA"));
  let days = 0, rows = 0;
  const covered = new Set();
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(Date.parse(fetchedAt) - i * 86400e3);
    const url = urlFor(d);
    let buf;
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(120e3) });
      if (res.status === 404) { if (i > 0) failures.push(`${url}: 404`); continue; } // today's file may not exist yet
      if (!res.ok) { failures.push(`${url}: HTTP ${res.status}`); continue; }
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) { failures.push(`${url}: ${e.message}`); continue; }
    const ymd = d.toISOString().slice(0, 10);
    const validEnd = `${ymd}T06:00:00.000Z`;
    const validStart = new Date(Date.parse(validEnd) - 24 * 3600e3).toISOString();
    const entries = tarEntries(buf);
    const found = new Set();
    for (const code of Object.keys(PRODUCTS)) {
      const dat = entries.find((e) => productOf(e.name) === code && /\.dat\.gz$/.test(e.name));
      const hdr = entries.find((e) => productOf(e.name) === code && /\.(txt|Hdr)\.gz$/i.test(e.name));
      if (!dat || !hdr) { failures.push(`${ymd}: product ${code} missing from tar`); continue; }
      const htext = gunzipSync(hdr.data).toString("latin1");
      await saveRaw(`${rawDir}/${ymd}-${code}.txt.gz`, htext);
      const h = parseHeader(htext);
      const grid = gunzipSync(dat.data);
      if (grid.length !== 2 * h.cols * h.rows) throw new Error(`SNODAS ${code} ${ymd}: grid is ${grid.length} bytes, header says ${h.cols}x${h.rows}`);
      found.add(code);
      const [variable, unit, instant] = PRODUCTS[code];
      for (const r of targets) {
        const [lat, lon] = coordsOf(r);
        const s = sample(grid, h, lat, lon);
        if (!s) continue;
        for (const [suffix, raw] of [["", s.cell], ["_max_5x5", s.max]]) {
          const value = raw === null ? null : toUnit(code, raw, h);
          if (value === null) continue;
          covered.add(r.id);
          sink.write({
            source: "snodas", kind: "analysis", resort_id: r.id, tier: null, station_id: `snodas:${s.row}_${s.col}`,
            lat, lon, elevation_m: null, fetched_at: fetchedAt,
            valid_start: instant ? validEnd : validStart, valid_end: validEnd, period_label: instant ? "instant" : "24h",
            variable: variable + suffix, value, unit, run_id: runId, parser_version: PARSER_VERSION,
          });
          rows++;
        }
      }
    }
    if (found.size === Object.keys(PRODUCTS).length) days++;
    await sleep(1000);
  }
  log(`snodas: ${days} complete days, ${covered.size}/${targets.length} resorts, ${rows} rows`);
  return { ok: days >= DAYS - 1 && covered.size > 0, rows, failures };
}
