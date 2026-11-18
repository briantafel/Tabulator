/* Our own snowfall forecast, live (Brian, 2026-11-16).
 *
 * The same arithmetic the scoring job judges as "ours (blend × SLR)"
 * (scripts/model/blend.py, scripts/verify/digest.py), applied to today's
 * ECMWF / GFS / GEM forecasts:
 *   1. water per model per local day (sum of hourly precipitation; an hour's
 *      value is the hour ENDING at its timestamp, so it is dated by t − 1 h);
 *   2. × the model's wet/dry factor for the resort's region and lead
 *      (pooled factor when the region has none);
 *   3. weighted by the model's lead weight, re-normalised over the models
 *      present (missing is dropped, never zero);
 *   4. snow = water × SLR(T) ÷ 10, T = the models' mean precipitation-weighted
 *      2 m temperature; warmer than 2 °C → rain, no snow.
 * Leads outside the fitted 1–7 use the nearest fitted lead's weights.
 */
import { slrLineFor, slrOf } from "../projections/lib.js";

export const RAIN_ABOVE_C = 2;

export function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

/** Hourly series → Map(date → { water, t }), complete 24-hour local days only. */
export function dailyFromHourly(time, series, tz) {
  const days = new Map();
  time.forEach((ts, i) => {
    const start = Date.parse(`${ts}Z`) - 3600e3;
    const d = localDate(start, tz);
    if (!days.has(d)) days.set(d, { hours: 0, water: 0, pt: 0, tSum: 0, ok: true });
    const a = days.get(d);
    const p = series.precipitation?.[i], t = series.temperature_2m?.[i];
    if (typeof p !== "number" || typeof t !== "number" || !Number.isFinite(p) || !Number.isFinite(t)) { a.ok = false; return; }
    a.hours++; a.water += p; a.pt += p * t; a.tSum += t;
  });
  const out = new Map();
  for (const [d, a] of days) {
    // DST days have 23 or 25 hours; anything else is a partial day at the edges.
    if (!a.ok || a.hours < 23) continue;
    out.set(d, { water: a.water, t: a.water > 0 ? a.pt / a.water : a.tSum / a.hours });
  }
  return out;
}

const nearestLead = (table, lead) => {
  const leads = Object.keys(table ?? {}).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!leads.length) return null;
  return String(leads.reduce((b, l) => (Math.abs(l - lead) < Math.abs(b - lead) ? l : b), leads[0]));
};

/** perModel: { model: { water, t } } for one resort-day → { water, t, models } or null. */
export function blendDay(perModel, { lead, region, params }) {
  const key = nearestLead(params.weights, lead);
  if (key == null) return null;
  let wSum = 0, wWater = 0, tSum = 0, n = 0;
  for (const [model, v] of Object.entries(perModel)) {
    const w = params.weights[key]?.[model];
    if (!(w > 0) || v?.water == null) continue;
    const f = params.factors?.[`${model}|${key}|${region}`] ?? params.pooled_factors?.[`${model}|${key}`] ?? 1;
    wSum += w; wWater += w * v.water * f; tSum += v.t; n++;
  }
  if (!n) return null;
  return { water: wWater / wSum, t: tSum / n, models: n };
}

export function snowFrom(water, t, slrLine) {
  if (t > RAIN_ABOVE_C) return 0;
  return (water * slrOf(t, slrLine)) / 10;
}

/** One resort: { model: hourly series } + time → [{ date, lead, water, snow, t, models }]. */
export function resortDays({ time, byModel, tz, region, issueDate, params, slr, resortId, bands = null }) {
  const daily = {};
  for (const [m, s] of Object.entries(byModel)) daily[m] = dailyFromHourly(time, s, tz);
  const dates = [...new Set(Object.values(daily).flatMap((d) => [...d.keys()]))].sort();
  const line = slrLineFor(slr, resortId);
  const out = [];
  for (const date of dates) {
    const lead = Math.round((Date.parse(date) - Date.parse(issueDate)) / 864e5);
    if (lead < 0) continue;
    const perModel = {};
    for (const [m, d] of Object.entries(daily)) if (d.has(date)) perModel[m] = d.get(date);
    const b = blendDay(perModel, { lead, region, params });
    if (!b) continue;
    const r1 = (x) => Math.round(x * 10) / 10;
    /* Band (cm) through the SAME ratio and temperature as the number, so the
       chart's band and line always agree. */
    const bw = bands ? bandFor(bands, lead, b.water) : null;
    const band = bw && line ? Object.fromEntries(Object.entries(bw).map(([k, v]) => [k, r1(snowFrom(v, b.t, line))])) : null;
    out.push({ date, lead, water: r1(b.water), snow: line ? r1(snowFrom(b.water, b.t, line)) : null,
      t: r1(b.t), models: b.models, ...(band ? { band } : {}) });
  }
  return out;
}

/* ── Bands v1 (scripts/model/bands.py, 2026-11-18) ─────────────────────────
 * Likely / possible range for our water forecast, from our own past misses.
 * MUST match bands.py band_for() exactly; test/blend-bands.test.js pins it. */
const BAND_GROUP = (lead, groups) => {
  for (const [g, [lo, hi]] of Object.entries(groups)) if (lead >= lo && lead <= hi) return g;
  return Object.keys(groups).at(-1);
};
const BAND_BIN = (f, edges) => {
  let i = 0;
  while (i + 1 < edges.length && f >= edges[i + 1]) i++;
  return i;
};
/** Band in mm water for one day's blended water `f` at `lead`, or null. */
export function bandFor(bands, lead, f) {
  if (!bands?.table || typeof f !== "number" || !Number.isFinite(f)) return null;
  const c = bands.table[BAND_GROUP(lead, bands.groups)]?.[String(BAND_BIN(f, bands.edges_mm))];
  if (!c) return null;
  const s = c.kind === "ratio" ? f : 1;
  const q = Object.fromEntries(["p10", "p25", "p50", "p75", "p80", "p90"].map((k) => [k, Math.max(0, c[k] * s)]));
  const b = { p10: q.p10, p90: q.p10 > 0 ? q.p90 : q.p80, p25: q.p25, p75: q.p25 > 0 ? q.p75 : q.p50 };
  b.p25 = Math.min(b.p25, f); b.p75 = Math.max(b.p75, f);
  b.p10 = Math.min(b.p10, b.p25); b.p90 = Math.max(b.p90, b.p75);
  return b;
}
