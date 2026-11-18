import { bandAround } from "./projections.js";
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

/** Is the blend file recent enough to use? Same 36 h rule as the mark. */
export function blendFresh(blend, now = Date.now()) {
  if (!blend?.resorts) return false;
  const t = Date.parse(blend.fetchedAt ?? blend.generatedAt);
  return Number.isFinite(t) && now - t <= MAX_AGE_H * 3600e3;
}

/* The Snowfall switch (Brian, 2026-11-18): our number IN PLACE OF
   Snow-Forecast's on its six days, so the totals, the radar ranking, the
   verdicts and the chart all read ours. Why now: on the Wasatch storm of
   11-17 to 11-21 Snow-Forecast had Alta at ~6" Wed–Sat against NWS Salt
   Lake's 23–37" and our ~25". Not yet proven head-to-head; flags.json
   `snowfall` reverts it for everyone.
   - All or nothing per resort: a resort keeps Snow-Forecast's numbers unless
     ours covers every one of its forecast days, so one resort's total never
     mixes two sources. (New resorts, e.g. Park City, until the blend has them.)
   - Snow-Forecast's figure is kept as `sfSnow` for anyone debugging; nothing
     draws it, and the light `ours` mark is dropped (it would equal the bar).
   - Stale or missing file: the feed comes back unchanged and `snowfall`
     stays unset, so Settings can say so. Never an old number as today's.
   Projected days (7–10) are ours already and are left alone. */
export function applySnowfall(feed, blend, now = Date.now(), { bands = true } = {}) {
  if (!feed || !blendFresh(blend, now)) return feed;
  return {
    ...feed,
    snowfall: "tabulator",
    resorts: feed.resorts.map((r) => {
      const days = blend.resorts[r.id]?.days;
      if (!days?.length) return r;
      const byDate = new Map(days.filter((d) => d.snow != null).map((d) => [d.date, d.snow]));
      const bandBy = new Map(days.filter((d) => d.band).map((d) => [d.date, d.band]));
      if (!r.days.every((d) => d.projected || byDate.has(d.date))) return r;
      return {
        ...r,
        snowfall: "tabulator",
        days: r.days.map((d) => {
          if (d.projected) return d;
          const { ours: _drop, ...rest } = d;
          const snow = byDate.get(d.date);
          /* Re-centre the likely/possible band on OUR number. It was built
             around Snow-Forecast's, so a day where the two disagreed drew our
             line far outside its own band, with the value label stuck at the
             band (Snowbird Thu 11-19: ours 9.2", SF 2.4"; Brian 2026-11-18). */
          /* Bands v1 (2026-11-18): calibrated from our own past misses when the
             blend file carries them and flags.json `bands` isn't "off";
             otherwise the ensemble spread re-centred on our number. */
          const cal = bands ? bandBy.get(d.date) : null;
          const range = cal ? { ...cal } : d.spread ? bandAround(snow, d.spread) : undefined;
          return { ...rest, snow, sfSnow: d.snow, ...(range ? { range } : { range: undefined }) };
        }),
      };
    }),
  };
}
