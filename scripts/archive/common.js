/* ------------------------------------------------------------------ *
 * Shared plumbing for the forecast archive.
 *
 * Every collector produces two things:
 *   - the RAW bytes it fetched, gzipped, exactly as received, so any parser
 *     bug can be fixed later by re-parsing history;
 *   - ROWS in the archive's one long shape (one row per value), written as
 *     gzipped NDJSON and turned into Parquet by to_parquet.py.
 *
 * Storage is metric and UTC. Missing is no row, never a zero.
 * See archive/dictionary.yaml for every variable's meaning and unit.
 * ------------------------------------------------------------------ */

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createGzip, gzipSync } from "node:zlib";

export const UA = "Tabulator/1.0 (personal ski-trip planner; forecast archive; low volume)";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The archive's columns, in order. to_parquet.py declares the same list
 *  with types; keep the two in step. */
export const COLUMNS = [
  "source", "kind", "resort_id", "tier", "elevation_m", "lat", "lon", "station_id",
  "issued_at", "fetched_at", "valid_start", "valid_end", "period_label",
  "variable", "value", "value_text", "unit", "model", "member", "run_id", "parser_version",
];

/** Fetch with retries. Returns { status, text }. A 404 is not retried. */
export async function fetchText(url, { retries = 2, delayMs = 2000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(delayMs * (attempt + 1));
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en", ...headers } });
      const text = await res.text();
      if (res.status === 404) return { status: 404, text };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text };
    } catch (e) { lastErr = e; }
  }
  // Node's fetch reports every network fault as "fetch failed"; the real
  // reason (reset, timeout, DNS) is on .cause. Say it.
  const cause = lastErr.cause?.code || lastErr.cause?.message;
  throw new Error(`${url}: ${lastErr.message}${cause ? ` (${cause})` : ""}`);
}

/** A sink for one source's rows: gzipped NDJSON, every row carrying every
 *  column (null where it does not apply) so the Parquet schema never guesses. */
export async function rowSink(path) {
  await mkdir(dirname(path), { recursive: true });
  const gz = createGzip();
  const file = createWriteStream(path);
  gz.pipe(file);
  let count = 0;
  return {
    write(row) {
      const full = {};
      for (const c of COLUMNS) full[c] = row[c] ?? null;
      if (full.value != null && !Number.isFinite(full.value)) full.value = null;
      if (full.value == null && full.value_text == null) return; // missing is no row
      gz.write(JSON.stringify(full) + "\n");
      count++;
    },
    get count() { return count; },
    close: () => new Promise((resolve, reject) => {
      file.on("finish", resolve);
      file.on("error", reject);
      gz.end();
    }),
  };
}

/** Save fetched bytes exactly as received, gzipped. */
export async function saveRaw(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(text));
}

/** UTC instant for a wall-clock time in an IANA zone. Two passes of the
 *  offset lookup handle the hour either side of a DST change. */
export function zonedToUtc(date, hour, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const offset = (t) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}

export const addHours = (iso, h) => new Date(Date.parse(iso) + h * 3600e3).toISOString();

/** Resort coordinates: the NWS mid-slope point for US resorts, `latlon` for
 *  the rest. Both are points on the mountain, not the base town. */
export const coordsOf = (r) => r.nws ?? r.latlon ?? null;
