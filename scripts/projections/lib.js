/* ------------------------------------------------------------------ *
 * Projections: days 7–10 from the Open-Meteo ensembles, made to agree
 * with Snow-Forecast where the two overlap.
 *
 * Brian, 2026-11-03: "it begins to make my predictions smarter, which is
 * the ultimate goal. To have my own accurate predictions."
 *
 * What this is, honestly: the ensembles answer out to 16 days, but their
 * wind is at 10 m above a smoothed model ground and their temperature is
 * downscaled, so on a mountain they read differently from Snow-Forecast.
 * For days 1–6 we have BOTH for every resort, every run. The gap between
 * them, per resort, is learned run over run and applied to days 7+.
 *
 * That makes the projections CONSISTENT with Snow-Forecast — it does not
 * yet make them accurate against what actually happened. That needs the
 * verification table (observed snow, wind, temp). The calibration file is
 * written so a truth-based correction can replace it later without the app
 * changing.
 *
 * Pure functions only; build.js does the files.
 * ------------------------------------------------------------------ */

export const MODEL_WEIGHT_EQUAL = true;   // ECMWF (51 members) and GFS (31) count equally
export const PROJECTION_DAYS = 10;        // total days shown: SF's 6 + projections
/* Days built past PROJECTION_DAYS. Snow-Forecast's feed (forecast.yml) and
   this builder (archive.yml) run on separate, often-delayed schedules; when
   SF rolls forward a day first, a file built to exactly day 10 only reaches
   day 9. The spare days keep the app at 10; it trims to 10 itself. */
export const PROJECTION_BUFFER_DAYS = 2;
export const EWMA_ALPHA = 0.2;            // how fast the learned correction moves per run
export const WIND_FACTOR_LIMITS = [0.5, 3];
export const TEMP_OFFSET_LIMIT = 10;      // °C
const MIN_WIND_KMH = 5;                   // below this a ratio is noise

/** YYYY-MM-DD for an instant, in a resort's own time zone. */
export function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));
}

/** One Open-Meteo ensemble response → per member, per resort-local day:
 *  { snow (cm, sum), tempMax, tempMin (°C), windMax (km/h) }.
 *  An hourly value describes the hour ENDING at its timestamp, so it is
 *  dated by t − 1h. A day counts only if all 24 of its hours are present
 *  (a partial snow sum would read as less snow). */
export function dailyByMember(json, tz) {
  const h = json?.hourly;
  if (!h?.time?.length) return new Map();
  const members = new Map(); // member → { var → series }
  for (const [key, series] of Object.entries(h)) {
    const m = key.match(/^(snowfall|temperature_2m|wind_speed_10m)(?:_member(\d+))?$/);
    if (!m) continue;
    const n = m[2] ? Number(m[2]) : 0;
    if (!members.has(n)) members.set(n, {});
    members.get(n)[m[1]] = series;
  }
  const dayOf = h.time.map((t) => localDate(Date.parse(`${t}Z`) - 3600e3, tz));
  const out = new Map(); // member → Map(date → agg)
  for (const [n, s] of members) {
    const days = new Map();
    dayOf.forEach((d, i) => {
      if (!days.has(d)) days.set(d, { hours: 0, snow: 0, tMax: -Infinity, tMin: Infinity, wMax: -Infinity, ok: true });
      const a = days.get(d);
      const sn = s.snowfall?.[i], t = s.temperature_2m?.[i], w = s.wind_speed_10m?.[i];
      const num = (v) => typeof v === "number" && Number.isFinite(v);
      if (!num(sn) || !num(t) || !num(w)) { a.ok = false; return; }
      a.hours++; a.snow += sn; a.tMax = Math.max(a.tMax, t); a.tMin = Math.min(a.tMin, t); a.wMax = Math.max(a.wMax, w);
    });
    const clean = new Map();
    for (const [d, a] of days) {
      if (a.ok && a.hours === 24) {
        clean.set(d, { snow: Number(a.snow.toFixed(2)), tempMax: a.tMax, tempMin: a.tMin, windMax: a.wMax });
      }
    }
    out.set(n, clean);
  }
  return out;
}

/** Weighted quantile. `items` = [{ v, w }]. Linear interpolation on the
 *  cumulative weight, so 0.5 of an even split lands between the two. */
export function wQuantile(items, q) {
  const xs = items.filter((x) => Number.isFinite(x.v) && x.w > 0).sort((a, b) => a.v - b.v);
  if (!xs.length) return null;
  const total = xs.reduce((s, x) => s + x.w, 0);
  let cum = 0;
  const pts = xs.map((x) => { const mid = (cum + x.w / 2) / total; cum += x.w; return [mid, x.v]; });
  if (q <= pts[0][0]) return pts[0][1];
  if (q >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (q <= pts[i][0]) {
      const [q0, v0] = pts[i - 1], [q1, v1] = pts[i];
      return v0 + ((q - q0) / (q1 - q0)) * (v1 - v0);
    }
  }
  return pts[pts.length - 1][1];
}

/** Pool every model's members for one resort into per-day weighted samples.
 *  `byModel` = { modelId: Map(member → Map(date → agg)) }. */
export function pool(byModel) {
  const days = new Map(); // date → { snow:[], tempMax:[], tempMin:[], windMax:[], members:[] }
  const models = Object.keys(byModel).filter((k) => byModel[k]?.size);
  for (const model of models) {
    const members = byModel[model];
    const w = MODEL_WEIGHT_EQUAL ? 1 / (models.length * members.size) : 1;
    for (const [, perDay] of members) {
      for (const [d, a] of perDay) {
        if (!days.has(d)) days.set(d, { snow: [], tempMax: [], tempMin: [], windMax: [], n: 0 });
        const p = days.get(d);
        p.snow.push({ v: a.snow, w }); p.tempMax.push({ v: a.tempMax, w });
        p.tempMin.push({ v: a.tempMin, w }); p.windMax.push({ v: a.windMax, w });
        p.n++;
      }
    }
  }
  return days;
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Summary of one pooled day. */
export function summarize(p) {
  const q = (k, x) => r1(wQuantile(p[k], x));
  return {
    snow: { p10: q("snow", 0.1), p25: q("snow", 0.25), p50: q("snow", 0.5), p75: q("snow", 0.75), p90: q("snow", 0.9) },
    tempMax: q("tempMax", 0.5), tempMin: q("tempMin", 0.5), windMax: q("windMax", 0.5),
    members: p.n,
  };
}

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** This run's evidence for one resort: on every date both sources have,
 *  how Snow-Forecast's wind and temperature compare with the ensemble
 *  median. Wind is a ratio (SF ÷ ensemble), temperature a difference. */
export function runEvidence(sfDays, pooledSummary) {
  const ratios = [], diffs = [];
  for (const d of sfDays ?? []) {
    const e = pooledSummary.get(d.date);
    if (!e) continue;
    if (Number.isFinite(d.windMax) && Number.isFinite(e.windMax) && e.windMax >= MIN_WIND_KMH) ratios.push(d.windMax / e.windMax);
    if (Number.isFinite(d.tempMax) && Number.isFinite(e.tempMax)) diffs.push(d.tempMax - e.tempMax);
  }
  return {
    wind: ratios.length ? { factor: median(ratios), days: ratios.length } : null,
    temp: diffs.length ? { offset: median(diffs), days: diffs.length } : null,
  };
}

/** Fold one run's evidence into the learned correction (EWMA). The first
 *  run seeds it; later runs nudge it by EWMA_ALPHA. `runs` counts how many
 *  runs have contributed, so the app (or a person) can see how settled it is. */
export function learn(prev, ev, alpha = EWMA_ALPHA) {
  const next = { wind: prev?.wind ?? null, temp: prev?.temp ?? null };
  if (ev.wind) {
    const f = clamp(ev.wind.factor, WIND_FACTOR_LIMITS);
    next.wind = prev?.wind
      ? { factor: r3(prev.wind.factor + alpha * (f - prev.wind.factor)), runs: prev.wind.runs + 1 }
      : { factor: r3(f), runs: 1 };
  }
  if (ev.temp) {
    const o = clamp(ev.temp.offset, [-TEMP_OFFSET_LIMIT, TEMP_OFFSET_LIMIT]);
    next.temp = prev?.temp
      ? { offset: r3(prev.temp.offset + alpha * (o - prev.temp.offset)), runs: prev.temp.runs + 1 }
      : { offset: r3(o), runs: 1 };
  }
  return next;
}
function r3(v) { return Math.round(v * 1000) / 1000; }

/** Apply the learned correction to one projected day. Raw ensemble values
 *  are kept alongside, so the correction can always be inspected or undone. */
export function correct(day, cal) {
  const f = cal?.wind?.factor ?? 1, o = cal?.temp?.offset ?? 0;
  return {
    ...day,
    tempMax: day.tempMax == null ? null : r1(day.tempMax + o),
    tempMin: day.tempMin == null ? null : r1(day.tempMin + o),
    windMax: day.windMax == null ? null : r1(day.windMax * f),
    raw: { tempMax: day.tempMax, tempMin: day.tempMin, windMax: day.windMax },
  };
}

/** The dates to project: the days after Snow-Forecast's last date, up to
 *  PROJECTION_DAYS counted from its first. */
export function projectionDates(sfDates, available) {
  if (!sfDates?.length) return [];
  const first = sfDates[0], last = sfDates[sfDates.length - 1];
  const want = [];
  const d = new Date(`${first}T12:00:00Z`);
  for (let i = 0; i < PROJECTION_DAYS + PROJECTION_BUFFER_DAYS; i++) {
    const s = d.toISOString().slice(0, 10);
    if (s > last) want.push(s);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return want.filter((s) => available.has(s));
}
