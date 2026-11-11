/* Our temperature model, applied live (Brian, 2026-11-11; claude/temp-wind-plan.md).
 *
 * Pure functions, tested in test/temps.test.js. build.js does the fetching.
 *
 * Per resort × local day, from each model's HOURLY 2 m temperature at the
 * resort's Snow-Forecast mid elevation (the slope — Brian's choice):
 *   hi      warmest hour of the day, minus the model's per-resort high bias
 *   lo      coldest hour of the day (no correction; SNOTEL lows unresolved)
 *   liftLo  coldest hour from 08:00 to 16:00 local — the −10 °F veto, the
 *           cold dot and the temperature ranking read this (Brian's choice)
 * then a weighted mean over the models present that day (weights per lead
 * from scripts/model/temps.py). A model without that day is dropped and the
 * weights re-normalised; no model at all → the day is absent, never 0.
 *
 * The high correction is only applied at leads the judge winter promoted
 * (params.promote.hi[lead]); without parameters the models get equal weight
 * and no correction, and the file says so (`validated: false`).
 */

export const MODELS = ["ecmwf_ifs025", "gem_seamless", "gfs_seamless"];
export const LIFT_FROM = 8;
export const LIFT_TO = 16; // inclusive: the 16:00 reading is still lift hours
export const DAYS = 11; // today + 10

/** Hourly series → { date: { hi, lo, liftLo, hours } } for one model.
 *  `times` are local ISO strings ("2026-11-12T08:00") from timezone=<tz>. */
export function dailyFromHourly(times, temps) {
  const out = {};
  times.forEach((t, i) => {
    const v = temps[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    const date = t.slice(0, 10);
    const hour = Number(t.slice(11, 13));
    const d = (out[date] ??= { hi: -Infinity, lo: Infinity, liftLo: Infinity, hours: 0, lift: 0 });
    d.hi = Math.max(d.hi, v);
    d.lo = Math.min(d.lo, v);
    d.hours++;
    if (hour >= LIFT_FROM && hour <= LIFT_TO) { d.liftLo = Math.min(d.liftLo, v); d.lift++; }
  });
  // A day needs all 24 hours (23/25 on DST days) for hi/lo, and all 9 lift hours for liftLo.
  for (const [date, d] of Object.entries(out)) {
    if (d.hours < 23) { delete out[date]; continue; }
    if (d.lift < LIFT_TO - LIFT_FROM + 1) d.liftLo = null;
    delete d.hours; delete d.lift;
  }
  return out;
}

const leadKey = (lead) => String(Math.min(Math.max(lead, 1), 7));
const round1 = (x) => Math.round(x * 10) / 10;

/** Blend the models for one resort. `perModel` = { model: dailyFromHourly(...) }.
 *  `issueDate` is the resort-local date the forecast was fetched. */
export function blendResort(perModel, { resortId, issueDate, params }) {
  const dates = [...new Set(Object.values(perModel).flatMap((d) => Object.keys(d)))].sort();
  const days = [];
  for (const date of dates) {
    const lead = Math.round((Date.parse(date) - Date.parse(issueDate)) / 86400e3);
    if (lead < 0) continue;
    const k = leadKey(lead);
    const acc = { hi: [0, 0], lo: [0, 0], liftLo: [0, 0] };
    const used = [];
    for (const m of MODELS) {
      const d = perModel[m]?.[date];
      if (!d) continue;
      used.push(m);
      const wHi = params?.weights?.hi?.[k]?.[m] ?? 1;
      const wLo = params?.weights?.lo?.[k]?.[m] ?? 1;
      const correct = params?.promote?.hi?.[k] === true;
      const bias = correct ? params?.high_bias?.[`${m}|${resortId}`] ?? 0 : 0;
      acc.hi[0] += wHi * (d.hi - bias); acc.hi[1] += wHi;
      acc.lo[0] += wLo * d.lo; acc.lo[1] += wLo;
      if (d.liftLo != null) { acc.liftLo[0] += wLo * d.liftLo; acc.liftLo[1] += wLo; }
    }
    if (!used.length) continue;
    const v = (a) => (a[1] > 0 ? round1(a[0] / a[1]) : null);
    days.push({ date, hi: v(acc.hi), lo: v(acc.lo), liftLo: v(acc.liftLo), models: used.length });
  }
  return days;
}
