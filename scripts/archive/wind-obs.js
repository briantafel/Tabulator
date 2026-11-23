/* ------------------------------------------------------------------ *
 * Wind observations, the ground truth for the wind veto model
 * (claude/wind-model-plan-2026-11-23.md, W1). Hourly, own workflow wind-obs.yml.
 *
 *   ECCC SWOB-ML real time (Canada): every station within 40 km of each Canadian app resort,
 *     10-minute mean wind, 10-minute maximum wind (the gust) and direction. ECCC keeps only ~28 days,
 *     so a skipped day is lost for good: each run takes the last 6 h and runs overlap on purpose.
 *   NWS observation stations (US): the stations in src/data/wind-stations.json (from the W0 probe).
 *
 * Rows use the SLF names: wind_speed_mean, wind_gust_max, wind_dir_mean, in km/h and degrees.
 * Missing is no row, never 0. Stations are not at resorts, and most sit in valleys: station elevation
 * is stored on every row, and the choice of which stations count for which tier is made later (W0.5).
 * ------------------------------------------------------------------ */
import { readFile } from "node:fs/promises";
import { UA, sleep, saveRaw, coordsOf } from "./common.js";

export const PARSER_VERSION = "wind-obs-1";
const SWOB = "https://api.weather.gc.ca/collections/swob-realtime/items";
const NWS = "https://api.weather.gov";
const RADIUS_KM = 40;
const WINDOW_H = 6;

export const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};

/** Speed to km/h from the unit the source states. An unknown unit is an error, never a guess. */
export function toKmh(v, uom) {
  const u = String(uom ?? "").toLowerCase().replace(/\s/g, "");
  if (u === "km/h" || u === "kph" || u === "wmounit:km_h-1") return v;
  if (u === "m/s" || u === "wmounit:m_s-1") return v * 3.6;
  if (u === "kt" || u === "kts" || u === "wmounit:kt") return v * 1.852;
  throw new Error(`unknown wind unit "${uom}"`);
}

/* SWOB field → [variable, is speed]. 10-minute fields; valid_end is the observation time. */
const SWOB_FIELDS = [
  ["avg_wnd_spd_10m_pst10mts", "wind_speed_mean", true],
  ["max_wnd_spd_10m_pst10mts", "wind_gust_max", true],
  ["avg_wnd_dir_10m_pst10mts", "wind_dir_mean", false],
];
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** One SWOB-ML feature → rows. A value ECCC flags as bad (-qa below 0 = missing/erroneous) is dropped. */
export function swobRows(f, { fetchedAt, runId }) {
  const p = f.properties ?? {}, g = f.geometry?.coordinates;
  const end = new Date(p["date_tm-value"] ?? p.obs_date_tm);
  if (!g || Number.isNaN(end.getTime())) throw new Error(`swob feature without time or position: ${f.id}`);
  const id = p["msc_id-value"] ?? p["stn_nam-value"];
  if (id == null) throw new Error(`swob feature without station id: ${f.id}`);
  const rows = [];
  for (const [field, variable, isSpeed] of SWOB_FIELDS) {
    let v = num(p[field]);
    if (v === null) continue;
    const qa = num(p[`${field}-qa`]);
    if (qa !== null && qa < 0) continue;
    const unit = isSpeed ? "km/h" : "deg";
    if (isSpeed) v = Number(toKmh(v, p[`${field}-uom`]).toFixed(2));
    if (isSpeed && (v < 0 || v > 400)) throw new Error(`implausible ${variable} ${v} at ${id}`);
    rows.push({
      source: "wind-obs", kind: "observation", resort_id: null, tier: null, station_id: `eccc:${id}`, lat: g[1], lon: g[0],
      elevation_m: num(p["stn_elev-value"]) !== null ? Math.round(num(p["stn_elev-value"])) : (Number.isFinite(g[2]) ? Math.round(g[2]) : null),
      fetched_at: fetchedAt, valid_start: new Date(end.getTime() - 600e3).toISOString(), valid_end: end.toISOString(),
      period_label: "10min", variable, value: v, unit, model: "eccc-swob", value_text: p["stn_nam-value"] ?? null,
      run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  return rows;
}

/** One NWS observation feature → rows. The period is not stated by NWS, so period_label is "obs". */
export function nwsRows(f, station, { fetchedAt, runId }) {
  const p = f.properties ?? {};
  const end = new Date(p.timestamp);
  if (Number.isNaN(end.getTime())) throw new Error(`nws observation without timestamp at ${station.id}`);
  const rows = [];
  for (const [field, variable, isSpeed] of [["windSpeed", "wind_speed_mean", true], ["windGust", "wind_gust_max", true], ["windDirection", "wind_dir_mean", false]]) {
    let v = num(p[field]?.value);
    if (v === null) continue;
    if (isSpeed) { v = Number(toKmh(v, p[field].unitCode).toFixed(2)); if (v < 0 || v > 400) throw new Error(`implausible ${variable} ${v} at ${station.id}`); }
    rows.push({
      source: "wind-obs", kind: "observation", resort_id: null, tier: null, station_id: `nws:${station.id}`, lat: station.lat ?? null, lon: station.lon ?? null,
      elevation_m: station.elev != null ? Math.round(station.elev) : null,
      fetched_at: fetchedAt, valid_start: end.toISOString(), valid_end: end.toISOString(), period_label: "obs",
      variable, value: v, unit: isSpeed ? "km/h" : "deg", model: "nws", value_text: station.name ?? null,
      run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  return rows;
}

async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json, application/json" }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      if (res.ok) return { text, json: JSON.parse(text) };
      err = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { err = e.message; }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`${url} -> ${err}`);
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log, root = new URL("../..", import.meta.url).pathname }) {
  const failures = [];
  const now = Date.parse(fetchedAt), iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  const from = iso(now - WINDOW_H * 3600e3), to = iso(now);
  let rows = 0, ecStations = new Set(), ecQueries = 0, ecOk = 0;

  // --- ECCC: one box query per Canadian resort, stations then picked by distance.
  for (const r of resorts.filter((x) => x.region === "Canada")) {
    const c = coordsOf(r); if (!c) continue;
    ecQueries++;
    const d = 0.45, bbox = [c[1] - d, c[0] - d, c[1] + d, c[0] + d].join(",");
    try {
      const { text, json } = await getJson(`${SWOB}?f=json&limit=2000&bbox=${bbox}&datetime=${from}/${to}`);
      await saveRaw(`${rawDir}/eccc-${r.id}.json.gz`, text);
      for (const f of json.features ?? []) {
        const g = f.geometry?.coordinates; if (!g) continue;
        const dist = km(c, [g[1], g[0]]);
        if (dist > RADIUS_KM) continue;
        for (const row of swobRows(f, { fetchedAt, runId })) {
          if (!ecStations.has(row.station_id)) { ecStations.add(row.station_id); }
          sink.write(row); rows++;
        }
        const id = `eccc:${f.properties?.["msc_id-value"]}`;
        if (!ecStations.has(`map:${r.id}:${id}`)) {
          ecStations.add(`map:${r.id}:${id}`);
          sink.write({ source: "wind-obs", kind: "mapping", resort_id: r.id, station_id: id, lat: g[1], lon: g[0], elevation_m: num(f.properties?.["stn_elev-value"]) !== null ? Math.round(num(f.properties["stn_elev-value"])) : null,
            fetched_at: fetchedAt, variable: "candidate_distance", value: Number(dist.toFixed(2)), unit: "km", value_text: f.properties?.["stn_nam-value"] ?? null, model: "eccc-swob", run_id: runId, parser_version: PARSER_VERSION });
        }
      }
      ecOk++;
    } catch (e) { failures.push(`eccc ${r.id}: ${e.message}`); log(`  ✗ wind-obs eccc ${r.id} — ${e.message}`); }
    await sleep(200);
  }

  // --- NWS: the curated station list. One request per distinct station.
  const list = JSON.parse(await readFile(`${root}src/data/wind-stations.json`, "utf8")).nws;
  const stations = new Map(), resortsOf = new Map();
  for (const [resort, ss] of Object.entries(list)) for (const s of ss) { stations.set(s.id, s); (resortsOf.get(s.id) ?? resortsOf.set(s.id, []).get(s.id)).push([resort, s.km]); }
  let nwsOk = 0, nwsTried = 0, nwsEmpty = 0;
  for (const [id, s] of stations) {
    nwsTried++;
    try {
      const { text, json } = await getJson(`${NWS}/stations/${id}/observations?start=${from}&end=${to}&limit=100`);
      await saveRaw(`${rawDir}/nws-${id}.json.gz`, text);
      const feats = json.features ?? [];
      if (!feats.length) nwsEmpty++;
      for (const f of feats) {
        const g = f.geometry?.coordinates;
        const st = { ...s, lat: g?.[1] ?? null, lon: g?.[0] ?? null };
        for (const row of nwsRows(f, st, { fetchedAt, runId })) { sink.write(row); rows++; }
      }
      for (const [resort, dist] of resortsOf.get(id)) sink.write({ source: "wind-obs", kind: "mapping", resort_id: resort, station_id: `nws:${id}`, elevation_m: s.elev != null ? Math.round(s.elev) : null,
        fetched_at: fetchedAt, variable: "candidate_distance", value: dist, unit: "km", value_text: s.name, model: "nws", run_id: runId, parser_version: PARSER_VERSION });
      nwsOk++;
    } catch (e) { failures.push(`nws ${id}: ${e.message}`); log(`  ✗ wind-obs nws ${id} — ${e.message}`); }
    await sleep(150);
  }
  const ecCount = [...ecStations].filter((x) => x.startsWith("eccc:")).length;
  log(`wind-obs: eccc ${ecOk}/${ecQueries} resort queries, ${ecCount} stations; nws ${nwsOk}/${nwsTried} stations (${nwsEmpty} with nothing in ${WINDOW_H} h); ${rows} rows`);
  // Loud: no ECCC wind at all, or too many failed queries, is a fault (the ~28-day origin window makes gaps unrecoverable).
  const ok = ecQueries > 0 && ecOk / ecQueries >= 0.8 && ecCount > 0 && nwsTried > 0 && nwsOk / nwsTried >= 0.8 && rows > 0;
  return { ok, rows, eccc_stations: ecCount, nws_stations: nwsOk, failures };
}
