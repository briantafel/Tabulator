/* The rolling archive behind the "-3 days" column.
 *
 * Kept separate from the scraper so the contamination guard is testable. The
 * dev fixture and the real scrape write the same file, and mixing them puts
 * invented snowfall in front of the user as fact — so a synthetic archive is
 * discarded rather than appended to. */

export const HISTORY_DAYS = 14;

/** Returns an archive safe to append real observations to.
 *  A synthetic archive is dropped entirely — never merged. */
export function openHistory(existing) {
  if (!existing || typeof existing !== "object" || existing.synthetic) {
    return { days: {}, discarded: !!existing?.synthetic };
  }
  return { days: existing.days ?? {}, discarded: false };
}

/** Records each resort's day-0 snowfall, then trims to the retention window. */
export function recordDay(history, resorts, now = new Date()) {
  const days = { ...history.days };
  for (const r of resorts) {
    const d0 = r.days?.[0];
    if (!d0?.date || typeof d0.snow !== "number") continue;
    days[d0.date] = { ...(days[d0.date] ?? {}), [r.id]: d0.snow };
  }
  const keep = Object.keys(days).sort().slice(-HISTORY_DAYS);
  return {
    days: Object.fromEntries(keep.map((k) => [k, days[k]])),
    updatedAt: now.toISOString(),
  };
}
