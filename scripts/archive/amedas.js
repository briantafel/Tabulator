/* ------------------------------------------------------------------ *
 * JMA AMeDAS: ground truth for Japanese resorts. Added 2026-11-11
 * (claude/lean-data-plan.md).
 *
 * From the public JSON behind JMA's AMeDAS pages:
 *   /bosai/amedas/const/amedastable.json        stations (lat/lon as [deg, min], alt m)
 *   /bosai/amedas/data/map/<YYYYMMDDHHmmss>.json every station at one time (JST)
 * Values are [value, quality flag]; only flag 0 (normal) is kept.
 * Licence: Government of Japan Standard Terms of Use (compatible with CC BY 4.0).
 * Attribution: 出典：気象庁ホームページ (Source: Japan Meteorological Agency website).
 *
 * Each run fetches the snapshots at 03/09/15/21 JST for the last 3 days
 * (12 requests). Those hours are 18/00/06/12 UTC, so each "snow6h" (snow
 * depth increase over the 6 hours to that time) lines up with the archive's
 * 6-hour blocks, and "snow24h" at 09 JST is the 00–00 UTC day. Runs overlap on
 * purpose. Like SNOTEL and SLF, up to 3 stations within 30 km of each resort
 * that report snow are recorded as mapping rows.
 *
 * Caveat: AMeDAS sites sit in towns and valleys, often well below the
 * slopes. elevation_m is the station's height, so views can see the gap.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "amedas-1";
const BASE = "https://www.jma.go.jp/bosai/amedas";
const RADIUS_KM = 30;
const PER_RESORT = 3;
const DAYS = 3;

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};
const deg = (v) => (Array.isArray(v) ? v[0] + v[1] / 60 : Number(v));

/* AMeDAS field → [variable, unit, window hours (0 = instant)]. */
const FIELDS = {
  snow: ["snow_depth", "cm", 0],
  snow6h: ["new_snow_6h", "cm", 6],
  snow24h: ["new_snow_24h", "cm", 24],
  precipitation24h: ["precip_24h", "mm", 24],
  temp: ["temp", "C", 0],
};

/** Snapshot times (UTC Date) for the last `days` days: 03/09/15/21 JST = 18/00/06/12 UTC. */
export function snapshotTimes(now, days = DAYS) {
  const out = [];
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  t.setUTCHours(Math.floor(t.getUTCHours() / 6) * 6);
  // A snapshot needs ~30 min to appear; skip the newest slot if it is too fresh.
  if (now - t < 40 * 60e3) t.setUTCHours(t.getUTCHours() - 6);
  for (let i = 0; i < days * 4; i++) out.push(new Date(t.getTime() - i * 6 * 3600e3));
  return out;
}

/** UTC Date → the JST file name stamp YYYYMMDDHHmmss. */
export function jstStamp(d) {
  const j = new Date(d.getTime() + 9 * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}${p(j.getUTCMonth() + 1)}${p(j.getUTCDate())}${p(j.getUTCHours())}0000`;
}

export function pickStations(table, resorts) {
  const picks = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || c[0] < 24 || c[0] > 46 || c[1] < 122 || c[1] > 146) continue; // Japan only
    const near = Object.entries(table)
      .map(([code, s]) => ({ code, s, lat: deg(s.lat), lon: deg(s.lon) }))
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))
      .map((x) => ({ ...x, km: Number(km(c, [x.lat, x.lon]).toFixed(2)) }))
      .filter((x) => x.km <= RADIUS_KM)
      .sort((a, b) => a.km - b.km);
    picks.push({ resort: r.id, near });
  }
  return picks;
}

/** One station at one snapshot → rows. Missing or flagged values write no row. */
export function stationRows(code, obs, station, at, { fetchedAt, runId }) {
  const rows = [];
  for (const [field, [variable, unit, hours]] of Object.entries(FIELDS)) {
    const v = obs[field];
    if (!Array.isArray(v) || v[0] == null || !Number.isFinite(v[0]) || v[1] !== 0) continue;
    rows.push({
      source: "amedas", kind: "observation", resort_id: null, tier: null, station_id: code,
      lat: station.lat, lon: station.lon, elevation_m: station.alt ?? null,
      fetched_at: fetchedAt, valid_start: new Date(at.getTime() - hours * 3600e3).toISOString(),
      valid_end: at.toISOString(), period_label: hours ? `${hours}h` : "instant",
      variable, value: v[0], unit, run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  return rows;
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  const res = await fetchText(`${BASE}/const/amedastable.json`, { retries: 3 });
  if (res.status !== 200) throw new Error(`station table HTTP ${res.status}`);
  await saveRaw(`${rawDir}/amedastable.json.gz`, res.text);
  const table = JSON.parse(res.text);
  if (!Object.keys(table).length) throw new Error("station table is empty — the format may have changed");
  const candidates = pickStations(table, resorts);
  if (!candidates.some((c) => c.near.length)) throw new Error("no AMeDAS station within 30 km of any Japanese resort");

  const snaps = [];
  let ok = 0;
  for (const at of snapshotTimes(new Date(fetchedAt))) {
    const stamp = jstStamp(at);
    const r = await fetchText(`${BASE}/data/map/${stamp}.json`, { retries: 2 });
    if (r.status === 200) {
      await saveRaw(`${rawDir}/map-${stamp}.json.gz`, r.text);
      snaps.push({ at, data: JSON.parse(r.text) });
      ok++;
    } else failures.push(`map ${stamp}: HTTP ${r.status}`);
    await sleep(500);
  }
  // Stations that report snow depth in any snapshot: the only useful truth here.
  const reportsSnow = (code) => snaps.some((s) => Array.isArray(s.data[code]?.snow));
  const picked = new Map();
  for (const c of candidates) {
    for (const n of c.near.filter((x) => reportsSnow(x.code)).slice(0, PER_RESORT)) {
      const station = { lat: Number(n.lat.toFixed(5)), lon: Number(n.lon.toFixed(5)), alt: n.s.alt ?? null };
      picked.set(n.code, station);
      sink.write({
        source: "amedas", kind: "mapping", resort_id: c.resort, station_id: n.code, lat: station.lat, lon: station.lon,
        elevation_m: station.alt, fetched_at: fetchedAt, variable: "candidate_distance", value: n.km, unit: "km",
        value_text: n.s.enName ?? n.s.kjName ?? null, run_id: runId, parser_version: PARSER_VERSION,
      });
    }
  }
  let rows = 0;
  for (const { at, data } of snaps) {
    for (const [code, station] of picked) {
      if (!data[code]) continue;
      for (const row of stationRows(code, data[code], station, at, { fetchedAt, runId })) { sink.write(row); rows++; }
    }
  }
  log(`amedas: ${picked.size} snow stations for ${candidates.filter((c) => c.near.some((x) => picked.has(x.code))).length} resorts, ${ok}/${snaps.length + failures.length} snapshots, ${rows} rows`);
  return { ok: ok >= 0.75 * DAYS * 4 && picked.size > 0, stations: picked.size, snapshots: ok, rows, failures };
}
