/* ------------------------------------------------------------------ *
 * CoCoRaHS: volunteer daily reports (24 h snowfall, its water, snow depth,
 * precipitation) for US and Canadian resorts. Added 2026-11-11
 * (claude/lean-data-plan.md).
 *
 * Endpoints (official CoCoRaHS exports, CSV):
 *   data.cocorahs.org/export/exportstations.aspx?State=UT&Format=CSV
 *   data.cocorahs.org/export/exportreports.aspx?ReportType=Daily&dtf=1&Format=CSV
 *     &State=UT&ReportDateType=reportdate&Date=MM/DD/YYYY&TimesInGMT=True
 * Licence/terms: free for non-commercial use with credit to CoCoRaHS. Credit:
 * "Community Collaborative Rain, Hail and Snow Network (CoCoRaHS)".
 *
 * Every run fetches the last 3 report dates (reports arrive late; overlap is
 * deliberate). A report usually covers the 24 h ending at its observation
 * time (often ~7 am local), so valid_end is that time in UTC and the window
 * is 24 h. "T" (trace) is stored as 0 with value_text "T". NA writes no row.
 * Up to 5 stations within 30 km of each resort are recorded as mapping rows.
 *
 * Caveat: volunteers live in towns and valleys, below the slopes. The
 * station elevation is stored so views can see the gap.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "cocorahs-1";
const BASE = "https://data.cocorahs.org/export";
const RADIUS_KM = 30;
const PER_RESORT = 5;
const DAYS = 3;

const STATE = {
  California: "CA", Nevada: "NV", Washington: "WA", Oregon: "OR", Colorado: "CO", Utah: "UT",
  Wyoming: "WY", Idaho: "ID", Montana: "MT", "New Mexico": "NM", "New York": "NY", Vermont: "VT",
  "New Hampshire": "NH", Maine: "ME", Arizona: "AZ", Alaska: "AK", Michigan: "MI",
};
const CANADA = ["BC", "AB", "QC", "ON"];

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};

/** Report column → [variable, convert, unit]. Inches → cm (snow) or mm (water). */
const FIELDS = {
  TotalPrecipAmt: ["precip_24h", 25.4, "mm"],
  NewSnowDepth: ["new_snow_24h", 2.54, "cm"],
  NewSnowSWE: ["new_snow_water_24h", 25.4, "mm"],
  TotalSnowDepth: ["snow_depth", 2.54, "cm"],
  TotalSnowSWE: ["swe", 25.4, "mm"],
};

/** Simple CSV (the exports have no quoted commas) → array of objects. Throws if headers are missing. */
export function parseCsv(text, need) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(",").map((h) => h.trim());
  for (const h of need) if (!head.includes(h)) throw new Error(`CoCoRaHS CSV has no "${h}" column — the format changed (header: ${head.join(",")})`);
  return lines.slice(1).filter(Boolean).map((l) => {
    const v = l.split(",").map((x) => x.trim());
    return Object.fromEntries(head.map((h, i) => [h, v[i] ?? ""]));
  });
}

export function statesFor(resorts) {
  const s = new Set();
  for (const r of resorts) {
    if (r.archiveOnly && r.country && r.country !== "US" && r.country !== "CA") continue;
    if (r.region === "Canada" || r.country === "CA") CANADA.forEach((c) => s.add(c));
    else if (STATE[r.region]) s.add(STATE[r.region]);
  }
  return [...s].sort();
}

/** "2026-11-10" + "02:00 PM" (GMT) → ISO. */
export function obsTime(date, time) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim()) || !m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return new Date(`${date.trim()}T${String(h).padStart(2, "0")}:${m[2]}:00Z`).toISOString();
}

export function reportRows(rep, station, { fetchedAt, runId }) {
  const end = obsTime(rep.ObservationDate, rep.ObservationTime);
  if (!end) return [];
  const start = new Date(Date.parse(end) - 24 * 3600e3).toISOString();
  const rows = [];
  for (const [col, [variable, k, unit]] of Object.entries(FIELDS)) {
    const raw = (rep[col] ?? "").trim();
    let value, text = null;
    if (raw === "T" || raw === "t") { value = 0; text = "T"; }
    else if (raw === "" || /^(NA|M)$/i.test(raw)) continue;
    else { value = Number(raw); if (!Number.isFinite(value) || value < 0) continue; value = Number((value * k).toFixed(2)); }
    const instant = variable === "snow_depth" || variable === "swe";
    rows.push({
      source: "cocorahs", kind: "observation", resort_id: null, tier: null, station_id: rep.StationNumber,
      lat: station.lat, lon: station.lon, elevation_m: station.elevation_m, fetched_at: fetchedAt,
      valid_start: instant ? end : start, valid_end: end, period_label: instant ? "instant" : "24h",
      variable, value, unit, value_text: text, run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  return rows;
}

const mdY = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  const states = statesFor(resorts);
  const stations = new Map();
  for (const st of states) {
    const r = await fetchText(`${BASE}/exportstations.aspx?State=${st}&Format=CSV`, { retries: 2 });
    if (r.status !== 200) { failures.push(`stations ${st}: HTTP ${r.status}`); continue; }
    await saveRaw(`${rawDir}/stations-${st}.csv.gz`, r.text);
    if (!r.text.trim()) continue; // a province with no stations
    for (const s of parseCsv(r.text, ["StationNumber", "Latitude", "Longitude", "Elevation", "StationStatus"])) {
      const lat = Number(s.Latitude), lon = Number(s.Longitude), ft = Number(s.Elevation);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || s.StationStatus === "Closed") continue;
      stations.set(s.StationNumber, { lat, lon, elevation_m: Number.isFinite(ft) && ft > 0 ? Math.round(ft * 0.3048) : null, name: s.StationName });
    }
    await sleep(300);
  }
  if (!stations.size) throw new Error(`no CoCoRaHS stations loaded for ${states.join(",")}`);

  const reports = [];
  let fetched = 0, tried = 0;
  const today = new Date(fetchedAt);
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today.getTime() - i * 86400e3);
    for (const st of states) {
      tried++;
      const url = `${BASE}/exportreports.aspx?ReportType=Daily&dtf=1&Format=CSV&State=${st}&ReportDateType=reportdate&Date=${mdY(d)}&TimesInGMT=True`;
      const r = await fetchText(url, { retries: 2 });
      if (r.status !== 200) { failures.push(`reports ${st} ${mdY(d)}: HTTP ${r.status}`); continue; }
      fetched++;
      if (!r.text.trim()) continue;
      await saveRaw(`${rawDir}/reports-${st}-${d.toISOString().slice(0, 10)}.csv.gz`, r.text);
      reports.push(...parseCsv(r.text, ["ObservationDate", "ObservationTime", "StationNumber", ...Object.keys(FIELDS)]));
      await sleep(300);
    }
  }
  const reporting = new Set(reports.map((r) => r.StationNumber));

  const picked = new Set();
  let mapped = 0;
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || (r.country && r.country !== "US" && r.country !== "CA")) continue;
    const near = [...stations].map(([id, s]) => ({ id, s, km: km(c, [s.lat, s.lon]) }))
      .filter((x) => x.km <= RADIUS_KM).sort((a, b) => Number(reporting.has(b.id)) - Number(reporting.has(a.id)) || a.km - b.km)
      .slice(0, PER_RESORT);
    if (near.length) mapped++;
    for (const n of near) {
      picked.add(n.id);
      sink.write({
        source: "cocorahs", kind: "mapping", resort_id: r.id, station_id: n.id, lat: n.s.lat, lon: n.s.lon,
        elevation_m: n.s.elevation_m, fetched_at: fetchedAt, variable: "candidate_distance",
        value: Number(n.km.toFixed(2)), unit: "km", value_text: n.s.name ?? null, run_id: runId, parser_version: PARSER_VERSION,
      });
    }
  }
  let rows = 0;
  for (const rep of reports) {
    if (!picked.has(rep.StationNumber)) continue;
    for (const row of reportRows(rep, stations.get(rep.StationNumber), { fetchedAt, runId })) { sink.write(row); rows++; }
  }
  log(`cocorahs: ${states.length} states, ${stations.size} stations, ${picked.size} near ${mapped} resorts, ${fetched}/${tried} report files, ${rows} rows`);
  return { ok: fetched >= 0.8 * tried && mapped > 0, stations: picked.size, rows, failures };
}
