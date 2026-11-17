/* ------------------------------------------------------------------ *
 * Season to date, per resort: the "Shaping up" numbers
 * (claude/calendar-shaping-up-plan.md).
 *
 * Pure functions only — no network — so the arithmetic is tested on its own.
 * build.js does the fetching and calls these.
 *
 * Input is one SNOTEL station's daily series since the water year began
 * (Oct 1), oldest first:
 *   { date, depthCm, sweMm, precipMm, tmaxC, tminC, depthMedCm, sweMedMm }
 * precipMm is AWDB's accumulated precipitation (PREC), so a day's rain or
 * snow water is the difference from the day before. Any field may be null:
 * missing is never zero (settled rule), it is skipped.
 * ------------------------------------------------------------------ */

/** Fresh snow from a day's new water: our SLR (public/slr.json, pooled
 *  form) at the day's mean station temperature. An estimate, labelled so in
 *  the app — station temperature is not the precipitation-weighted
 *  temperature the fit used. */
export function slrAt(t, slr) {
  const a = slr?.a ?? 11.558, b = slr?.b ?? -0.368;
  const [lo, hi] = slr?.clamp ?? [5, 25];
  if (typeof t !== "number") return slr?.median_observed_slr ?? 13;
  return Math.min(hi, Math.max(lo, a + b * t));
}

const num = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (a, b) => (num(a) && num(b) ? (a + b) / 2 : null);

/** One day's new snow in cm, or null when it cannot be told.
 *  Water comes from the snow pillow (SWE gain) — the PREC gauge under-catches
 *  snow in wind — and falls back to the gauge when the pillow has no reading.
 *  A day warmer than +1 °C mean is rain, not snow. */
export function dayNewSnowCm(prev, day, slr) {
  if (!prev || !day) return null;
  let water = num(day.sweMm) && num(prev.sweMm) ? day.sweMm - prev.sweMm : null;
  if (water == null && num(day.precipMm) && num(prev.precipMm)) water = day.precipMm - prev.precipMm;
  if (water == null) return null;
  if (water <= 0) return 0;
  /* SNOTEL reports SWE and precipitation in steps of 0.1" (2.54 mm). One
     step of pillow drift times an SLR of ~12 became ~3 cm of snow that never
     fell (Crested Butte, Steamboat, Sun Valley against 0 reported, checked
     2026-11-17). A day counts only with two steps, or one step and the snow
     depth rising with it. */
  const depthRose = num(day.depthCm) && num(prev.depthCm) && day.depthCm - prev.depthCm >= 1;
  if (water < 5 && !depthRose) return 0;
  const t = mean(day.tmaxC, day.tminC);
  if (num(t) && t > 1) return 0;
  return (water * slrAt(t, slr)) / 10;
}

/** What the surface has been through, day by day:
 *  warm      high above +2 °C at the station (sun/warmth crusts, wet snow)
 *  freezeThaw high above 0 and low below −2 (melt then refreeze: hard layers)
 *  rainOnSnow water fell with a mean above +1 °C onto existing snow
 *  dump      15 cm or more of new snow (the app's powder threshold) */
export function dayFlags(prev, day, newCm) {
  const t = mean(day.tmaxC, day.tminC);
  const water = num(day.precipMm) && num(prev?.precipMm) ? day.precipMm - prev.precipMm : null;
  return {
    warm: num(day.tmaxC) && day.tmaxC > 2,
    freezeThaw: num(day.tmaxC) && num(day.tminC) && day.tmaxC > 0 && day.tminC < -2,
    rainOnSnow: num(water) && water >= 2.5 && num(t) && t > 1 && num(day.depthCm) && day.depthCm > 0,
    dump: num(newCm) && newCm >= 15,
  };
}

/** Summarise one station's season. `today` is the last date to count. */
export function summarise(series, { slr, today } = {}) {
  const days = series.filter((d) => !today || d.date <= today);
  if (!days.length) return null;
  const out = [];
  for (let i = 0; i < days.length; i++) {
    const newCm = i === 0 ? null : dayNewSnowCm(days[i - 1], days[i], slr);
    out.push({ ...days[i], newCm, ...dayFlags(days[i - 1], days[i], newCm) });
  }
  const last = [...out].reverse().find((d) => num(d.depthCm) || num(d.sweMm)) ?? out[out.length - 1];
  const lastIdx = out.indexOf(last);
  const window = (n) => {
    const w = out.slice(Math.max(0, lastIdx - n + 1), lastIdx + 1);
    const known = w.filter((d) => num(d.newCm));
    // Half the window unknown and the total is not a total. Say so.
    if (known.length < Math.ceil(w.length / 2)) return null;
    return Math.round(known.reduce((s, d) => s + d.newCm, 0));
  };
  const dumpIdx = out.map((d, i) => (d.dump ? i : -1)).filter((i) => i >= 0).pop();
  const since = out.slice(dumpIdx == null ? 0 : dumpIdx + 1, lastIdx + 1);
  const count = (k) => since.filter((d) => d[k]).length;
  const pct = (v, m) => (num(v) && num(m) && m > 0 ? Math.round((100 * v) / m) : null);
  return {
    asOf: last.date,
    depthCm: num(last.depthCm) ? Math.round(last.depthCm) : null,
    depthMedianCm: num(last.depthMedCm) ? Math.round(last.depthMedCm) : null,
    depthPctMedian: pct(last.depthCm, last.depthMedCm),
    sweMm: num(last.sweMm) ? Math.round(last.sweMm) : null,
    sweMedianMm: num(last.sweMedMm) ? Math.round(last.sweMedMm) : null,
    swePctMedian: pct(last.sweMm, last.sweMedMm),
    /* Early in the season the median is a few millimetres and the ratio
       swings wildly (Vail read 18% with 10 mm of normal). Below 25 mm of
       median SWE the app shows amounts, not the percentage. */
    pctReliable: num(last.sweMedMm) && last.sweMedMm >= 25,
    new7Cm: window(7),
    new14Cm: window(14),
    new30Cm: window(30),
    lastDump: dumpIdx == null ? null : out[dumpIdx].date,
    daysSinceDump: dumpIdx == null ? null : lastIdx - dumpIdx,
    sinceDump: { warmDays: count("warm"), freezeThaw: count("freezeThaw"), rainOnSnow: count("rainOnSnow") },
    // The sparkline: depth and the median depth for each day since Nov 1.
    depthSeries: out.filter((d) => d.date.slice(5) >= "11-01" || d.date.slice(5) < "07-01")
      .map((d) => [d.date, num(d.depthCm) ? Math.round(d.depthCm) : null, num(d.depthMedCm) ? Math.round(d.depthMedCm) : null]),
  };
}

/** Which station speaks for a resort: the highest of its nearby stations
 *  that has a current depth or SWE reading. Higher is closer to the skiing;
 *  a station with no reading today says nothing about today. */
export function pickPrimary(candidates) {
  return candidates
    .filter((c) => c.summary && (c.summary.depthCm != null || c.summary.sweMm != null))
    .sort((a, b) => (b.elevationM ?? -1) - (a.elevationM ?? -1))[0] ?? null;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
export { ordinal };

/** Against the station's own history (scripts/season/normals.js): the
 *  1991–2020 median depth for the date, and where this season's SWE ranks
 *  among every season on record for the same calendar day (1 = most).
 *  A rank stays meaningful in November, when the median is a few mm. */
export function againstHistory(hist, { date, depthCm, sweMm }) {
  const day = hist?.days?.[date?.slice(5, 10)];
  if (!day) return {};
  const wy = Number(date.slice(5, 7)) >= 10 ? Number(date.slice(0, 4)) + 1 : Number(date.slice(0, 4));
  const past = Object.entries(day.swe ?? {}).filter(([y]) => Number(y) !== wy).map(([, v]) => v);
  const rank = num(sweMm) && past.length >= 10
    ? { position: 1 + past.filter((v) => v > sweMm).length, of: past.length + 1 }
    : null;
  const med = day.depthMed;
  return {
    depthMedianCm: num(med) ? med : null,
    depthPctMedian: num(depthCm) && num(med) && med >= 25 ? Math.round((100 * depthCm) / med) : null,
    rank,
  };
}
