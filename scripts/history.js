/* The rolling archive behind the "-3 days" column.
 *
 * Kept separate from the scraper so the contamination guard is testable. The
 * dev fixture and the real scrape write the same file, and mixing them puts
 * invented snowfall in front of the user as fact — so a synthetic archive is
 * discarded rather than appended to.
 *
 * Shape: { days: { date: { id: cm } }, parts: { date: { id: { am, pm, night } } } }
 *
 * WHY PER PERIOD. Snow-Forecast's table opens at whatever period is current, so
 * "day 0" of a late scrape holds only the periods still to come: at 7 pm local
 * it is the night alone. Overwriting the day's total with each scrape meant the
 * last scrape of the day won, and that one saw the least. Kirkwood's 11-16
 * storm day was archived as 3 cm (it had been 14 cm all morning) and 11-18 as
 * 41 cm (66 earlier), so "-3 days" read 17" when the three days held about 31".
 * Now each period keeps the latest value seen while it was still ahead, and a
 * day is a total only once all three periods are known. */

export const HISTORY_DAYS = 14;
export const PERIOD_NAMES = ["am", "pm", "night"];

/** Returns an archive safe to append real observations to.
 *  A synthetic archive is dropped entirely — never merged. */
export function openHistory(existing) {
  if (!existing || typeof existing !== "object" || existing.synthetic) {
    return { days: {}, parts: {}, discarded: !!existing?.synthetic };
  }
  return { days: existing.days ?? {}, parts: existing.parts ?? {}, discarded: false };
}

/** A day's total from its recorded periods — or null, never a partial sum.
 *  Two of three periods is a missing day, not a quiet one. */
export function dayTotal(parts) {
  if (!parts) return null;
  let sum = 0;
  for (const name of PERIOD_NAMES) {
    if (typeof parts[name] !== "number") return null;
    sum += parts[name];
  }
  return Number(sum.toFixed(2));
}

/** Records each resort's day-0 snowfall by period, then derives the daily
 *  totals and trims to the retention window. Later scrapes replace a period's
 *  value (closer to the event, so a better nowcast) but can never remove a
 *  period that has already passed out of the table. */
export function recordDay(history, resorts, now = new Date()) {
  const parts = {};
  for (const [date, byResort] of Object.entries(history.parts ?? {})) {
    parts[date] = Object.fromEntries(
      Object.entries(byResort).map(([id, p]) => [id, { ...p }]),
    );
  }
  for (const r of resorts) {
    const d0 = r.days?.[0];
    if (!d0?.date || !Array.isArray(d0.periods)) continue;
    for (const p of d0.periods) {
      if (!PERIOD_NAMES.includes(p?.name) || typeof p.snow !== "number") continue;
      parts[d0.date] ??= {};
      parts[d0.date][r.id] ??= {};
      parts[d0.date][r.id][p.name] = p.snow;
    }
  }

  const keep = Object.keys(parts).sort().slice(-HISTORY_DAYS);
  const days = {};
  const keptParts = {};
  for (const date of keep) {
    keptParts[date] = parts[date];
    for (const [id, p] of Object.entries(parts[date])) {
      const total = dayTotal(p);
      if (total != null) (days[date] ??= {})[id] = total;
    }
  }
  return { days, parts: keptParts, updatedAt: now.toISOString() };
}
