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
export function resortDays({ time, byModel, tz, region, issueDate, params, slr, resortId }) {
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
    out.push({ date, lead, water: r1(b.water), snow: line ? r1(snowFrom(b.water, b.t, line)) : null,
      t: r1(b.t), models: b.models });
  }
  return out;
}
