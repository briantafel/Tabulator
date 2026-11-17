/* Our own snowfall number (scripts/blend → public/blend-forecast.json), set
   as `ours` (cm) on Snow-Forecast's days so the range chart can draw it as a
   light mark beside theirs (Brian, 2026-11-16). Nothing else reads it: the
   ranking, dots, verdicts and totals stay Snow-Forecast's until the scoring
   gate says ours is better.
   A file older than MAX_AGE_H is ignored, so a broken pass never shows an
   old number as today's. Projected days (7–10) are already ours: no mark. */
export const MAX_AGE_H = 36;

export function applyOurs(feed, blend, now = Date.now()) {
  if (!feed || !blend?.resorts) return feed;
  const t = Date.parse(blend.fetchedAt ?? blend.generatedAt);
  if (!Number.isFinite(t) || now - t > MAX_AGE_H * 3600e3) return feed;
  return {
    ...feed,
    resorts: feed.resorts.map((r) => {
      const days = blend.resorts[r.id]?.days;
      if (!days?.length) return r;
      const byDate = new Map(days.map((d) => [d.date, d.snow]));
      return { ...r, days: r.days.map((d) => (d.projected || !byDate.has(d.date) || byDate.get(d.date) == null
        ? d : { ...d, ours: byDate.get(d.date) })) };
    }),
  };
}
