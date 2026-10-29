/* ------------------------------------------------------------------ *
 * NRCS SNOTEL: what actually happened on the mountain.
 *
 * This is the archive's ground truth for US resorts — the only way any
 * forecast in it gets graded. SNOTEL stations are not AT the resorts, so
 * rather than pick one station per resort now, every run records up to
 * three active stations within 30 km of each resort, with their distance
 * (kind "mapping"). Which one stands in for a resort is decided later, in
 * the views, with a season of data to judge by.
 *
 * Observations are keyed by station, not resort. Each run takes the last
 * 36 hours hourly and the last 3 days daily; the overlap between runs is
 * deliberate (a late-arriving reading still lands) and views keep the
 * newest fetch of each (station, time, variable).
 *
 * AWDB reports in English units and station-local standard time. Rows are
 * converted to metric and UTC; the raw JSON is kept as received.
 * ------------------------------------------------------------------ */

import { coordsOf, fetchText, saveRaw } from "./common.js";

export const PARSER_VERSION = "snotel-1";
const API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const ELEMENTS = ["SNWD", "WTEQ", "TOBS", "PREC"];
const RADIUS_KM = 30;
const PER_RESORT = 3;
const CHUNK = 20;

const VARIABLE = { SNWD: "snow_depth", WTEQ: "swe", TOBS: "temp", PREC: "precip_accum" };

/** Convert one value to the archive's metric unit, by the unit AWDB says it
 *  sent. An unknown unit throws rather than storing a number in the wrong one. */
export function toMetric(element, value, unit = "in") {
  if (value == null || !Number.isFinite(value)) return null;
  const u = String(unit).toLowerCase();
  if (element === "TOBS") {
    if (u === "degf") return { value: Number(((value - 32) * 5 / 9).toFixed(2)), unit: "C" };
    if (u === "degc") return { value, unit: "C" };
  } else if (element === "SNWD") {
    if (u === "in") return { value: Number((value * 2.54).toFixed(2)), unit: "cm" };
    if (u === "cm") return { value, unit: "cm" };
  } else {
    if (u === "in") return { value: Number((value * 25.4).toFixed(2)), unit: "mm" };
    if (u === "mm") return { value, unit: "mm" };
  }
  throw new Error(`${element} arrived in unknown unit "${unit}"`);
}

const km = ([a, b], [c, d]) => {
  const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2);
  return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y));
};

/** Pick up to three active stations within 30 km of each US resort. */
export function pickStations(stations, resorts, now = new Date()) {
  const active = stations.filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude) &&
    (!s.endDate || Date.parse(s.endDate) > now.getTime()));
  const picks = [];
  for (const r of resorts) {
    const c = coordsOf(r);
    if (!c || r.region === "Canada") continue;
    active.map((s) => ({ s, d: km(c, [s.latitude, s.longitude]) }))
      .filter((x) => x.d <= RADIUS_KM).sort((a, b) => a.d - b.d).slice(0, PER_RESORT)
      .forEach((x) => picks.push({ resort: r.id, station: x.s, km: Number(x.d.toFixed(2)) }));
  }
  return picks;
}

/** AWDB local standard time "YYYY-MM-DD HH:mm" + an hours offset → UTC ISO. */
export function stationTimeToUtc(local, offsetHours) {
  const [d, t = "00:00"] = local.trim().split(/[ T]/);
  return new Date(Date.parse(`${d}T${t.slice(0, 5)}:00Z`) - offsetHours * 3600e3).toISOString();
}

export function dataToRows(json, { stationsById, duration, fetchedAt, runId }) {
  const rows = [];
  for (const st of json) {
    const meta = stationsById.get(st.stationTriplet);
    if (!meta) continue;
    const offset = Number(meta.dataTimeZone);
    if (!Number.isFinite(offset)) throw new Error(`${st.stationTriplet} has no dataTimeZone`);
    for (const el of st.data ?? []) {
      const code = el.stationElement?.elementCode;
      if (!VARIABLE[code]) continue;
      const unit = el.stationElement?.storedUnitCode ?? el.stationElement?.unitCode ?? (code === "TOBS" ? "degF" : "in");
      for (const v of el.values ?? []) {
        const m = toMetric(code, v.value, unit);
        if (!m) continue;
        const start = stationTimeToUtc(v.date, offset);
        const end = duration === "DAILY" ? new Date(Date.parse(start) + 86400e3).toISOString() : start;
        rows.push({
          source: "snotel", kind: "observation", station_id: st.stationTriplet,
          lat: meta.latitude, lon: meta.longitude,
          elevation_m: Number.isFinite(meta.elevation) ? Math.round(meta.elevation * 0.3048) : null,
          fetched_at: fetchedAt, valid_start: start, valid_end: end, period_label: duration.toLowerCase(),
          variable: VARIABLE[code], value: m.value, unit: m.unit, run_id: runId, parser_version: PARSER_VERSION,
        });
      }
    }
  }
  return rows;
}

const fmt = (d, withTime) => {
  const iso = d.toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
};

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const failures = [];
  const now = new Date(fetchedAt);

  const { status, text } = await fetchText(`${API}/stations?stationTriplets=*:*:SNTL`);
  if (status !== 200) throw new Error(`stations HTTP ${status}`);
  await saveRaw(`${rawDir}/stations.json.gz`, text);
  const stations = JSON.parse(text);
  if (!Array.isArray(stations) || stations.length < 100) {
    throw new Error(`stations list has ${stations?.length ?? 0} entries — expected hundreds`);
  }

  const picks = pickStations(stations, resorts, now);
  for (const p of picks) {
    sink.write({
      source: "snotel", kind: "mapping", resort_id: p.resort, station_id: p.station.stationTriplet,
      lat: p.station.latitude, lon: p.station.longitude,
      elevation_m: Number.isFinite(p.station.elevation) ? Math.round(p.station.elevation * 0.3048) : null,
      fetched_at: fetchedAt, variable: "candidate_distance", value: p.km, unit: "km",
      value_text: p.station.name ?? null, run_id: runId, parser_version: PARSER_VERSION,
    });
  }
  const stationsById = new Map(picks.map((p) => [p.station.stationTriplet, p.station]));
  const ids = [...stationsById.keys()];
  const usResorts = resorts.filter((r) => coordsOf(r) && r.region !== "Canada");
  const covered = new Set(picks.map((p) => p.resort));
  usResorts.filter((r) => !covered.has(r.id)).forEach((r) => log(`  · snotel: no station within ${RADIUS_KM} km of ${r.id}`));
  if (!ids.length) throw new Error("no SNOTEL stations near any resort");

  let rowsOut = 0, ok = 0, tried = 0;
  for (const [duration, hoursBack] of [["HOURLY", 36], ["DAILY", 72]]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      tried++;
      const chunk = ids.slice(i, i + CHUNK);
      const q = new URLSearchParams({
        stationTriplets: chunk.join(","), elements: ELEMENTS.join(","), duration,
        beginDate: fmt(new Date(now - hoursBack * 3600e3), duration === "HOURLY"),
        endDate: fmt(now, duration === "HOURLY"),
      });
      try {
        const res = await fetchText(`${API}/data?${q}`);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        await saveRaw(`${rawDir}/data-${duration.toLowerCase()}-${i / CHUNK}.json.gz`, res.text);
        const rows = dataToRows(JSON.parse(res.text), { stationsById, duration, fetchedAt, runId });
        rows.forEach((r) => sink.write(r));
        rowsOut += rows.length;
        ok++;
      } catch (e) {
        failures.push(`${duration} chunk ${i / CHUNK}: ${e.message}`);
        log(`  ✗ snotel ${duration} chunk ${i / CHUNK} — ${e.message}`);
      }
    }
  }
  log(`snotel: ${ids.length} stations for ${covered.size}/${usResorts.length} US resorts, ${rowsOut} readings`);
  return { ok: ok === tried && rowsOut > 0, stations: ids.length, resortsCovered: covered.size, readings: rowsOut, failures };
}
