/* Our temperature model in the app (Brian, 2026-11-11; claude/temp-wind-plan.md).
 *
 * public/temps.json (scripts/temps) holds, per resort and local day, the
 * blended model HIGH (bias-corrected where the past winter proved it), the
 * day's LOW and the LIFT-HOURS low (coldest 08:00–16:00). Behind the `temps`
 * switch, applyTemps() writes them into every day the feed carries — days
 * 1–6 and, with projections on, 7–10 — so the table, sheet, chart, dots,
 * ranking, vetoes and sentences all read one temperature.
 *
 *   tempMax  ← hi        (shown everywhere a temperature is shown)
 *   tempMin  ← lo        (the overnight/day low: the spring corn rule)
 *   liftMin  ← liftLo    (the −10 °F veto, the cold dot, the ranking)
 *
 * A day our model lacks keeps Snow-Forecast's values and gets no liftMin, so
 * readers fall back to its day low: stricter, never a missed cold veto.
 * Switch off → this is never called and the app is exactly as before.
 */

/** The low the cold checks read: lift hours when we have it, else the day low. */
export const coldLow = (d) => (typeof d?.liftMin === "number" ? d.liftMin : d?.tempMin);

export function applyTemps(feed, temps) {
  if (!feed || !temps?.resorts) return feed;
  const resorts = feed.resorts.map((r) => {
    const ours = temps.resorts[r.id];
    if (!ours?.days?.length) return r;
    const byDate = Object.fromEntries(ours.days.map((d) => [d.date, d]));
    return {
      ...r,
      days: r.days.map((d) => {
        const m = byDate[d.date];
        if (!m || typeof m.hi !== "number" || typeof m.lo !== "number") return d;
        return {
          ...d,
          tempMax: m.hi,
          tempMin: m.lo,
          ...(typeof m.liftLo === "number" ? { liftMin: m.liftLo } : {}),
          tempSource: "model",
        };
      }),
    };
  });
  return { ...feed, resorts, tempsGeneratedAt: temps.generatedAt, tempsValidated: !!temps.validated };
}

/** The weather strip: keep NWS's (or Snow-Forecast's) sky and words, show
 *  our numbers — the high and the lift-hours low — for days we have. */
export function stripWithOurTemps(wxDays, days, toF) {
  const byDate = Object.fromEntries((days ?? []).filter((d) => d.tempSource === "model").map((d) => [d.date, d]));
  return wxDays.map((w) => {
    const d = byDate[w.date];
    return d ? { ...w, hi: toF(d.tempMax), lo: toF(coldLow(d)) } : w;
  });
}
