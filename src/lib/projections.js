/* Projections in the app: days 7–10 from public/projections.json, merged
 * into the feed ONLY when the projections switch is on for this phone.
 *
 * Rules (claude/range-chart-spec.md):
 *  - Snow-Forecast's own days are untouched. They gain a `range` (likely /
 *    possible band) centred on SF's number, using the ensemble's spread.
 *  - Projected days are appended and flagged `projected: true`. Snow is the
 *    ensemble median; temp and wind are the corrected values from the builder.
 *  - Stale or missing projections are ignored: the app falls back to the
 *    six-day forecast rather than showing old purple days.
 */

export const MAX_DAYS = 10;
export const STALE_HOURS = 36;

/** Snow-Forecast's number with the ensemble's spread around it. The spread
 *  is applied as offsets from the ensemble median, clamped at zero, so a
 *  dry SF day stays dry-ish and the band never claims negative snow. */
export function bandAround(sf, s) {
  if (typeof sf !== "number" || !s || typeof s.p50 !== "number") return null;
  const at = (q) => (typeof s[q] === "number" ? Math.max(0, round1(sf + (s[q] - s.p50))) : null);
  const b = { p10: at("p10"), p25: at("p25"), p75: at("p75"), p90: at("p90") };
  // Never let the band exclude SF's own number.
  b.p10 = Math.min(b.p10 ?? sf, sf); b.p25 = Math.min(b.p25 ?? sf, sf);
  b.p75 = Math.max(b.p75 ?? sf, sf); b.p90 = Math.max(b.p90 ?? sf, sf);
  return b;
}
const round1 = (v) => Math.round(v * 10) / 10;

export function isFresh(projections, now = Date.now()) {
  const t = Date.parse(projections?.generatedAt ?? "");
  return Number.isFinite(t) && now - t <= STALE_HOURS * 3600e3;
}

/** The feed as the projections view sees it. Returns the feed unchanged
 *  (plus `sfDates`) when there is nothing usable to add. */
export function extendFeed(feed, now = Date.now()) {
  if (!feed) return feed;
  const sfDates = feed.dates ?? [];
  const P = feed.projections;
  if (!P?.resorts || !isFresh(P, now) || !sfDates.length) return { ...feed, sfDates };

  const lastSf = sfDates[sfDates.length - 1];
  /* The builder makes a couple of spare days (it and the SF feed run on
     different schedules); keep only what fits in MAX_DAYS. */
  const room = Math.max(0, MAX_DAYS - sfDates.length);
  const fits = new Set(
    [...new Set(Object.values(P.resorts).flatMap((p) => (p.days ?? []).map((d) => d.date)))]
      .filter((d) => d > lastSf).sort().slice(0, room),
  );
  const extra = new Set();
  const resorts = feed.resorts.map((r) => {
    const p = P.resorts[r.id];
    /* Each resort carries its own issue time since 2026-11-11 (the builder
       carries a resort's last good entry forward when a pass misses it).
       Too old, or none at all: no projected days, and say so in the sheet
       rather than quietly showing six days. */
    const pAge = p?.issuedAt ? now - Date.parse(p.issuedAt) : 0;
    if (!p || pAge > STALE_HOURS * 3600e3) return { ...r, projMissing: true };
    const days = r.days.map((d) => {
      const s = p.spread?.[d.date];
      const range = s ? bandAround(d.snow, s) : null;
      return range ? { ...d, range } : d;
    });
    for (const pd of p.days ?? []) {
      if (!fits.has(pd.date) || !pd.snow) continue;
      const snow = pd.snow.p50 ?? 0;   // cm; rounded to whole inches only when shown
      days.push({
        date: pd.date, projected: true, snow,
        range: { p10: pd.snow.p10, p25: pd.snow.p25, p75: pd.snow.p75, p90: pd.snow.p90 },
        tempMax: pd.tempMax, tempMin: pd.tempMin, windMax: pd.windMax, periods: [],
      });
      extra.add(pd.date);
    }
    /* Per-member snow for the projected dates, so a window's projected
       total can be added up member by member (see projectedTotalRange). */
    const members = p.members && p.days?.length
      ? { dates: p.days.map((d) => d.date), models: p.members }
      : null;
    return { ...r, days, projMembers: members };
  });
  const dates = [...sfDates, ...[...extra].sort()].slice(0, MAX_DAYS);
  return { ...feed, resorts, dates, sfDates };
}

/** Weighted quantile; each model's members share equal total weight. */
function wq(items, q) {
  const xs = items.filter((x) => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
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

/** The range of the TOTAL over some projected dates, added up member by
 *  member — the honest way: summing each day's own band would claim every
 *  day hits its high end at once. Returns { p25, p75, p90 } in cm, or null. */
export function projectedTotalRange(projMembers, dates) {
  if (!projMembers || !dates.length) return null;
  const idx = dates.map((d) => projMembers.dates.indexOf(d));
  if (idx.some((i) => i < 0)) return null;
  const models = Object.values(projMembers.models).filter((m) => m?.length);
  const items = [];
  for (const members of models) {
    const w = 1 / (models.length * members.length);
    for (const row of members) {
      const vals = idx.map((i) => row[i]);
      if (vals.some((v) => typeof v !== "number")) continue;
      items.push({ v: vals.reduce((a, b) => a + b, 0), w });
    }
  }
  if (!items.length) return null;
  return { p25: wq(items, 0.25), p75: wq(items, 0.75), p90: wq(items, 0.9) };
}
