/* ------------------------------------------------------------------ *
 * Open-Meteo Previous Runs API: what a model forecast for each past hour
 * from the runs 0–7 days before it.
 *
 * Endpoint and series naming confirmed by a live run on 2026-10-29: the
 * API takes start_date / end_date / models / elevation, and answers each
 * variable as `<var>` (lead 0) and `<var>_previous_day<N>`.
 * ------------------------------------------------------------------ */

import { toBlocks } from "./ensembles.js";

export const PARSER_VERSION = "om-prev-1";
export const URL_BASE = "https://previous-runs-api.open-meteo.com/v1/forecast";
export const MODELS = ["ecmwf_ifs025", "gfs_seamless"];
export const VARS = ["snowfall", "precipitation", "temperature_2m"];
export const LEADS = [0, 1, 2, 3, 4, 5, 6, 7];
export const HOURLY = VARS.flatMap((v) => LEADS.map((l) => (l ? `${v}_previous_day${l}` : v)));

/** Open-Meteo's free tier counts a request with more than 10 variables, or
 *  more than 2 weeks for one location, as several calls: variables / 10 ×
 *  weeks / 2, each at least 1 (open-meteo.com/en/pricing, 2026-10-29). */
export function callWeight(nVariables, nDays) {
  return Math.max(1, nVariables / 10) * Math.max(1, nDays / 14);
}

/** One response → rows. Lead time is not a column: period_label carries the
 *  source's own exact label (previous_dayN), and issued_at is valid_start
 *  minus N days, which is approximate. */
export function previousRunsToRows(json, { resort, model, elevation, fetchedAt, runId }) {
  const h = json.hourly;
  if (!h?.time?.length) throw new Error("no hourly.time in response");
  const want = { snowfall: "cm", precipitation: "mm", temperature_2m: "°C" };
  for (const [k, u] of Object.entries(json.hourly_units ?? {})) {
    const base = k.replace(/_previous_day\d+$/, "");
    if (want[base] && u !== "undefined" && u !== want[base]) throw new Error(`${k} came back in ${u}, expected ${want[base]}`);
  }
  const byLead = new Map();
  for (const [key, series] of Object.entries(h)) {
    const m = key.match(/^([a-z0-9_]+?)(?:_previous_day(\d+))?$/);
    if (!m || !VARS.includes(m[1])) continue;
    if (json.hourly_units?.[key] === "undefined") continue;
    const lead = m[2] ? Number(m[2]) : 0;
    if (!byLead.has(lead)) byLead.set(lead, {});
    byLead.get(lead)[m[1]] = series; // toBlocks reads Open-Meteo's own names
  }
  if (![...byLead.keys()].some((l) => l > 0)) throw new Error("no _previous_dayN series — the response shape may have changed");
  const rows = [];
  for (const [lead, series] of byLead) {
    for (const b of toBlocks(h.time, series)) {
      for (const [variable, value, unit] of b.values) {
        if (value == null) continue;
        rows.push({
          source: "open-meteo-previous-runs", kind: "forecast", resort_id: resort.id, tier: "mid",
          elevation_m: elevation ?? json.elevation ?? null, lat: json.latitude, lon: json.longitude,
          issued_at: new Date(Date.parse(b.valid_start) - lead * 86400e3).toISOString(),
          fetched_at: fetchedAt, valid_start: b.valid_start, valid_end: b.valid_end,
          period_label: `previous_day${lead}`,
          variable, value, unit, model, run_id: runId, parser_version: PARSER_VERSION,
        });
      }
    }
  }
  return rows;
}
