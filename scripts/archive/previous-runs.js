/* ------------------------------------------------------------------ *
 * Open-Meteo Previous Runs API: what a model forecast for each past hour
 * from the runs 0–7 days before it.
 *
 * Endpoint and series naming confirmed by a live run on 2026-10-29: the
 * API takes start_date / end_date / models / elevation, and answers each
 * variable as `<var>` (lead 0) and `<var>_previous_day<N>`.
 * ------------------------------------------------------------------ */

import { toBlocks } from "./ensembles.js";

export const PARSER_VERSION = "om-prev-2"; // 2: + hourly `temp` rows (the lift-hours low, 2026-11-15)
export const URL_BASE = process.env.OM_PREVIOUS_RUNS_URL ?? "https://previous-runs-api.open-meteo.com/v1/forecast"; // env: tests only
/* GEM — Environment Canada's model — added 2026-10-31 for every resort.
   Open-Meteo's docs page names it "GEM Seamless" but shows only
   `cmc_gem_seamless` in an example URL, and the sandbox cannot reach the
   API to check, so the backfill asks for `gem_seamless` first and falls
   back through MODEL_IDS when Open-Meteo rejects the name. The piece key
   and the archive's `model` column keep the canonical name either way. */
export const MODELS = ["ecmwf_ifs025", "gfs_seamless", "gem_seamless"];
export const MODEL_IDS = { gem_seamless: ["gem_seamless", "cmc_gem_seamless"] };
/** A 400 that complains about the model name, not about anything else.
 *  Open-Meteo words this as "Cannot initialize MultiDomains from invalid
 *  String value <name>" — it never says "model" — so match both. */
export const unknownModel = (status, text) =>
  status === 400 && /model|MultiDomains|invalid String value/i.test(text ?? "");
export const VARS = ["snowfall", "precipitation", "temperature_2m"];
export const LEADS = [0, 1, 2, 3, 4, 5, 6, 7];
export const HOURLY = VARS.flatMap((v) => LEADS.map((l) => (l ? `${v}_previous_day${l}` : v)));
/* This season's nightly pieces: only what temps-v1 and blend-v1 read (16
   series, so 1.6 weighted calls instead of 2.4). Snowfall is Open-Meteo's
   own fixed-ratio conversion of these and isn't used by our models. */
export const LIVE_HOURLY = ["precipitation", "temperature_2m"].flatMap((v) => LEADS.map((l) => (l ? `${v}_previous_day${l}` : v)));

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
    // Hourly 2 m temperature as well (om-prev-2): the −10 °F veto reads the coldest hour 08–16
    // LOCAL, which 6-hour UTC blocks can't give. Same shape as NWS hourly: variable `temp`,
    // one-hour window, so scripts/verify/build.py scores it as the lift-hours low.
    const temps = series.temperature_2m;
    if (Array.isArray(temps)) {
      h.time.forEach((t, i) => {
        const v = temps[i];
        if (typeof v !== "number" || !Number.isFinite(v)) return;
        const vs = new Date(`${t}Z`).toISOString();
        rows.push({
          source: "open-meteo-previous-runs", kind: "forecast", resort_id: resort.id, tier: "mid",
          elevation_m: elevation ?? json.elevation ?? null, lat: json.latitude, lon: json.longitude,
          issued_at: new Date(Date.parse(vs) - lead * 86400e3).toISOString(),
          fetched_at: fetchedAt, valid_start: vs, valid_end: new Date(Date.parse(vs) + 3600e3).toISOString(),
          period_label: `previous_day${lead}`,
          variable: "temp", value: v, unit: "C", model, run_id: runId, parser_version: PARSER_VERSION,
        });
      });
    }
  }
  return rows;
}
