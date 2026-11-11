/* ------------------------------------------------------------------ *
 * SLF (WSL Institute for Snow and Avalanche Research): ground truth for
 * Swiss and nearby Alpine resorts. Added 2026-11-11 (claude/lean-data-plan.md).
 *
 * Two networks, from the free Measurement API (https://measurement-api.slf.ch,
 * CC BY 4.0, cite "Source: WSL Institute for Snow and Avalanche Research SLF";
 * IMIS data DOI 10.16904/envidat.406):
 *   study plots (manual, daily, read by observers): HS snow depth, HN_1D new
 *     snow in the last 24 h, HNW_1D its water equivalent. The best "what
 *     fell" in the Alps: new snow measured on a board, not inferred.
 *   IMIS (automatic): HS snow depth, and HN_1D new snow modelled by SLF's
 *     snowpack model (variable hn_1d_model, never mixed with the manual one).
 *
 * Like SNOTEL, stations are not at resorts: every run records up to three
 * stations within 30 km of each resort (kind "mapping", candidate_distance).
 * Observations are keyed by station. The API serves the last 7 days, and
 * each run takes 3, so runs overlap on purpose (a late reading still lands;
 * views keep the newest fetch of each station, time and variable).
 * Older history (file downloads) is a separate one-time job.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw } from "./common.js";

export const PARSER_VERSION = "slf-1";
const API = "https://measurement-api.slf.ch/public/api";
const RADIUS_KM = 30;
const PER_RESORT = 3;
const DAYS = 3;

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};

/** Up to three stations of one network within 30 km of each resort. */
export function pickStations(stations, resorts, network) {
  const picks = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c) continue;
    const near = stations
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && (network !== "imis" || s.type === "SNOW_FLAT"))
      .map((s) => ({ s, km: Number(km(c, [s.lat, s.lon]).toFixed(2)) }))
      .filter((x) => x.km <= RADIUS_KM)
      .sort((a, b) => a.km - b.km)
      .slice(0, PER_RESORT);
    for (const n of near) picks.push({ resort: r.id, station: n.s, km: n.km, network });
  }
  return picks;
}

/* Field → [variable, unit, 24-hour total?]. 24-hour totals get a window that
   ends at measure_date; snow depth is an instant. */
const FIELDS = {
  "study-plot": { HS: ["snow_depth", "cm", false], HN_1D: ["new_snow_24h", "cm", true], HNW_1D: ["new_snow_water_24h", "mm", true] },
  imis: { HS: ["snow_depth", "cm", false], HN_1D: ["hn_1d_model", "cm", true] },
};

/** One measurement → rows. Null is "not measured": no row, never 0. */
export function measurementRows(m, station, network, { fetchedAt, runId }) {
  const end = new Date(m.measure_date);
  if (Number.isNaN(end.getTime())) throw new Error(`bad measure_date ${m.measure_date}`);
  const rows = [];
  for (const [field, [variable, unit, isTotal]] of Object.entries(FIELDS[network])) {
    const v = m[field];
    if (v == null || !Number.isFinite(v)) continue;
    rows.push({
      source: "slf", kind: "observation", resort_id: null, tier: null, station_id: `${network}:${station.code}`,
      lat: station.lat, lon: station.lon, elevation_m: Number.isFinite(station.elevation) ? Math.round(station.elevation) : null,
      fetched_at: fetchedAt, valid_start: new Date(end.getTime() - (isTotal ? 864e5 : 0)).toISOString(),
      valid_end: end.toISOString(), period_label: isTotal ? "24h" : "instant",
      variable, value: v, unit, model: network, run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  return rows;
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  let picks = [];
  const stationsBy = {};
  for (const network of ["study-plot", "imis"]) {
    const res = await fetchText(`${API}/${network}/stations`, { retries: 3 });
    if (res.status !== 200) throw new Error(`${network} stations HTTP ${res.status}`);
    await saveRaw(`${rawDir}/${network}-stations.json.gz`, res.text);
    const stations = JSON.parse(res.text);
    if (!Array.isArray(stations) || !stations.length) throw new Error(`${network} station list is empty — the API may have changed`);
    stationsBy[network] = stations;
    picks = picks.concat(pickStations(stations, resorts, network));
  }
  for (const p of picks) {
    sink.write({
      source: "slf", kind: "mapping", resort_id: p.resort, station_id: `${p.network}:${p.station.code}`,
      lat: p.station.lat, lon: p.station.lon,
      elevation_m: Number.isFinite(p.station.elevation) ? Math.round(p.station.elevation) : null,
      fetched_at: fetchedAt, variable: "candidate_distance", value: p.km, unit: "km",
      value_text: p.station.label ?? null, model: p.network, run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  const wanted = new Map(picks.map((p) => [`${p.network}:${p.station.code}`, p]));
  log(`  slf: ${wanted.size} stations within ${RADIUS_KM} km of ${new Set(picks.map((p) => p.resort)).size} resorts`);

  let ok = 0, tried = 0, rows = 0;
  const noData = [];
  for (const [key, p] of wanted) {
    tried++;
    const path = p.network === "imis" ? `imis/station/${p.station.code}/measurements` : `study-plot/station/${p.station.code}/measurements`;
    try {
      const res = await fetchText(`${API}/${path}?period_in_days=${DAYS}`, { retries: 2 });
      // A station with nothing in the window answers 404 NO_DATA (study plots
      // before their observers start the season). That is "no reading", not a fault.
      if (res.status === 404 && /NO_DATA/.test(res.text)) { noData.push(key); ok++; continue; }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 120)}`);
      await saveRaw(`${rawDir}/${key.replace(":", "-")}.json.gz`, res.text);
      const list = JSON.parse(res.text);
      // IMIS is every 30 min: keep snow depth at whole hours only (enough for daily truth, 2x smaller).
      for (const m of list) {
        if (p.network === "imis" && !/T\d\d:00:00/.test(m.measure_date)) continue;
        for (const r of measurementRows(m, p.station, p.network, { fetchedAt, runId })) { sink.write(r); rows++; }
      }
      ok++;
    } catch (e) {
      failures.push(`${key}: ${e.message}`);
      log(`  ✗ slf ${key} — ${e.message}`);
    }
  }
  // SLF's modelled daily new snow for all IMIS stations in one call (cheap; covers stations we didn't pick too).
  try {
    const res = await fetchText(`${API}/imis/daily-snow?period_in_days=${DAYS}`, { retries: 2 });
    if (res.status === 200) {
      await saveRaw(`${rawDir}/imis-daily-snow.json.gz`, res.text);
      const byCode = new Map(stationsBy.imis.map((s) => [s.code, s]));
      for (const m of JSON.parse(res.text)) {
        const st = byCode.get(m.station_code);
        if (!st || !wanted.has(`imis:${st.code}`)) continue;
        for (const r of measurementRows(m, st, "imis", { fetchedAt, runId })) {
          r.period_label = r.period_label === "24h" ? "daily-24h" : "daily-instant";
          sink.write(r); rows++;
        }
      }
    } else failures.push(`imis daily-snow: HTTP ${res.status}`);
  } catch (e) { failures.push(`imis daily-snow: ${e.message}`); }

  if (noData.length) log(`  · slf: no readings yet at ${noData.length} station(s): ${noData.join(", ")}`);
  log(`slf: ${ok}/${tried} stations (${noData.length} with no readings yet), ${rows} rows`);
  return { ok: tried > 0 && ok / tried >= 0.8, stations: ok, tried, rows, failures };
}
