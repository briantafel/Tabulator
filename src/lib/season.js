/* Shaping up: how a region is doing before the forecast reaches a trip
 * (claude/calendar-shaping-up-plan.md). Reads public/season.json
 * (scripts/season), never a paid source except Snow-Forecast's base/top
 * depths, which Brian ruled stay in until ours are as close (2026-11-17).
 *
 * Plain arithmetic, so every sentence can be traced to a number.
 */
import { RANGES } from "./outlook.js";
import { snowWithUnit } from "./units.js";
import { shortDate } from "./dates.js";

/** The range a resort belongs to, as the radar names it; the resort's own
 *  region label when the radar has none for it. */
export const regionOf = (r) => RANGES[r.id]?.range ?? r.region ?? null;

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Rank resorts within a region: recent snow first (what a powder chaser
 *  is buying), snowpack against normal as the tie-break. Missing values sort
 *  last, never as zero. */
export function rankResorts(rows) {
  const k = (x) => (typeof x === "number" ? x : -Infinity);
  return [...rows].sort((a, b) =>
    k(b.s.new14Cm) - k(a.s.new14Cm) || k(b.s.swePctMedian) - k(a.s.swePctMedian));
}

/** Every region with season data, best first, each with its resorts.
 *  A region needs two resorts with data to be ranked on its own: one
 *  station is a point, not a region. */
export function regionTable(resorts, season, { minResorts = 2 } = {}) {
  const by = new Map();
  for (const r of resorts) {
    const s = season?.resorts?.[r.id];
    const g = regionOf(r);
    if (!s || !g) continue;
    if (!by.has(g)) by.set(g, []);
    by.get(g).push({ r, s });
  }
  const out = [];
  for (const [name, rows] of by) {
    if (rows.length < minResorts) continue;
    const ranked = rankResorts(rows);
    out.push({
      name, rows: ranked,
      new14Cm: median(rows.map((x) => x.s.new14Cm)),
      new7Cm: median(rows.map((x) => x.s.new7Cm)),
      swePctMedian: median(rows.filter((x) => x.s.pctReliable).map((x) => x.s.swePctMedian)),
      depthCm: median(rows.map((x) => x.s.depthCm)),
      daysSinceDump: median(rows.map((x) => x.s.daysSinceDump)),
      warmDays: median(rows.map((x) => x.s.sinceDump?.warmDays)),
      freezeThaw: median(rows.map((x) => x.s.sinceDump?.freezeThaw)),
      rainOnSnow: median(rows.map((x) => x.s.sinceDump?.rainOnSnow)),
      asOf: rows.map((x) => x.s.asOf).filter(Boolean).sort().pop() ?? null,
      /* Rank as a share of seasons (1 = best), so stations with different
         record lengths combine: the region's median, turned back into a
         place out of the typical record length. */
      rankShare: median(rows.filter((x) => x.s.rank).map((x) => x.s.rank.position / x.s.rank.of)),
      rankOf: median(rows.filter((x) => x.s.rank).map((x) => x.s.rank.of)),
      depthPctMedian: median(rows.map((x) => x.s.depthPctMedian)),
    });
  }
  const k = (x) => (typeof x === "number" ? x : -Infinity);
  return out.sort((a, b) => k(b.new14Cm) - k(a.new14Cm) || k(b.swePctMedian) - k(a.swePctMedian));
}

/** Which regions a trip shows, in order.
 *
 *  First, always, the leading region right now — dynamic: it moves as other
 *  regions pull ahead (Brian, 2026-11-17: "it should begin with the region
 *  that's the top performer"; "dynamic, unless manually saved to the trip").
 *  Then each region the trip pins through resorts added by hand, narrowed to
 *  those resorts. Pinning never replaces the leader: adding a Utah resort to
 *  a trip the Sierra leads used to swap the Sierra out (Brian found it).
 *  A pinned region that is also the leader appears once, as both. */
export function tripRegions(trip, resorts, season) {
  const ranked = regionTable(resorts, season);
  const all = regionTable(resorts, season, { minResorts: 1 });
  const leader = ranked[0] ?? null;
  const inTrip = new Set((trip.resorts ?? []).map((e) => e.name));
  const pinnedNames = [...new Set((trip.resorts ?? [])
    .map((e) => regionOf(resorts.find((r) => r.name === e.name) ?? {})).filter(Boolean))];
  const out = [];
  if (leader) {
    const pinned = pinnedNames.includes(leader.name);
    out.push({ ...leader, leading: true, pinned, mine: leader.rows.filter((x) => inTrip.has(x.r.name)) });
  }
  for (const n of pinnedNames) {
    if (leader && n === leader.name) continue;
    const g = all.find((x) => x.name === n);
    if (!g) continue;
    const mine = g.rows.filter((x) => inTrip.has(x.r.name));
    if (mine.length) out.push({ ...g, leading: false, pinned: true, rows: mine, mine });
  }
  return { regions: out, pinnedCount: pinnedNames.length };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The regional paragraph, as segments ({ t, hot }). Each clause comes from
 *  one number in the table; a missing number drops its clause. */
export function regionParagraph(g, metric) {
  const segs = [];
  const name = cap(g.name);
  if (typeof g.swePctMedian === "number") {
    segs.push({ t: `${name} is running at ` }, { t: `${Math.round(g.swePctMedian)}% of its normal snowpack`, hot: true });
    /* The rank keeps a big early percentage honest: 236% of a small November
       normal was only the 11th-biggest start in 37 seasons. */
    if (typeof g.rankShare === "number" && g.rankOf) {
      const pos = Math.max(1, Math.round(g.rankShare * g.rankOf));
      segs.push({ t: ` to date, its ${pos === 1 ? "biggest start" : `${ordinal(pos)}-biggest start`} in ${Math.round(g.rankOf)} seasons.` });
    } else {
      segs.push({ t: " to date." });
    }
  } else if (typeof g.rankShare === "number" && g.rankOf) {
    const pos = Math.max(1, Math.round(g.rankShare * g.rankOf));
    segs.push({ t: `${name} is having its ` }, { t: pos === 1 ? "biggest start" : `${ordinal(pos)}-biggest start`, hot: pos <= 5 },
      { t: ` in ${Math.round(g.rankOf)} seasons at a typical station here, for the date.` });
  } else {
    segs.push({ t: `${name}: it is too early in the season for a fair comparison with normal.` });
  }
  if (typeof g.depthPctMedian === "number") {
    segs.push({ t: ` Snow on the ground is ${g.depthPctMedian}% of its normal depth for the date.` });
  }
  if (typeof g.new14Cm === "number") {
    segs.push({ t: " About " }, { t: snowWithUnit(g.new14Cm, metric), hot: true }, { t: " of new snow has fallen in the last two weeks at a typical station here" });
    segs.push({ t: typeof g.new7Cm === "number" ? `, ${snowWithUnit(g.new7Cm, metric)} of it in the last seven days.` : "." });
  }
  if (typeof g.daysSinceDump === "number") {
    const d = Math.round(g.daysSinceDump);
    segs.push({ t: ` The last big snow day (${metric ? "15 cm" : '6"'} or more) was ${d === 0 && g.asOf ? "on " : ""}` },
      { t: d === 0 ? (g.asOf ? shortDate(g.asOf) : "the latest day reported") : `${plural(d, "day")} ago`, hot: d <= 3 }, { t: "." });
    const bits = [];
    if (g.warmDays >= 1) bits.push(plural(Math.round(g.warmDays), "warm day"));
    if (g.freezeThaw >= 1) bits.push(plural(Math.round(g.freezeThaw), "freeze–thaw cycle"));
    if (g.rainOnSnow >= 1) bits.push(plural(Math.round(g.rainOnSnow), "day") + " of rain on snow");
    if (bits.length) segs.push({ t: ` Since then: ${bits.join(", ")}, so expect ` }, { t: "firmer or crusted snow", hot: true }, { t: " on sunny and lower slopes until it snows again." });
    else if (d > 0) segs.push({ t: " It has stayed cold since, so that snow should have kept well." });
  }
  return segs;
}

/** Surface flags for one resort's card, as short labels. */
export function surfaceChips(s) {
  const out = [];
  const x = s?.sinceDump ?? {};
  if (x.warmDays) out.push(plural(x.warmDays, "warm day"));
  if (x.freezeThaw) out.push(plural(x.freezeThaw, "freeze–thaw"));
  if (x.rainOnSnow) out.push(plural(x.rainOnSnow, "rain-on-snow day"));
  return out;
}

export const DANGER = [null, "Low", "Moderate", "Considerable", "High", "Extreme"];

/** The avalanche forecasts behind a region's resorts, one per zone (resorts
 *  in the same zone share one forecast). Zones Avalanche Canada names with a
 *  hash read as the center alone. */
export function regionAvalanche(rows, season) {
  const out = new Map();
  for (const { r } of rows) {
    const a = season?.avalanche?.[r.id];
    if (!a) continue;
    const zone = a.zone && !/^[0-9a-f]{20,}$/i.test(a.zone) && a.zone !== "CAIC zone" ? a.zone : null;
    /* Group on the raw zone (Canada's hashed ids are distinct regions even
       though they show as the center). CAIC answers per point under one
       label, so its resorts group only when rating and problems match: rows
       that rate differently must never merge into one. */
    const key = `${a.center}|${a.zone ?? ""}|${a.zone === "CAIC zone" ? JSON.stringify([a.max, a.problems ?? []]) : ""}`;
    if (!out.has(key)) out.set(key, { ...a, zone, resorts: [] });
    out.get(key).resorts.push(r.name);
  }
  return [...out.values()].sort((a, b) => (b.max ?? -1) - (a.max ?? -1));
}

/** How the danger has moved, from the 14-day history of [date, max] pairs:
 *  "Up from Moderate yesterday", "Moderate for 5 days". Null with one day or
 *  none, or when today has no rating. A gap in the history (a day the center
 *  did not publish) is not read as a change. */
export function avalancheTrend(history) {
  const h = (history ?? []).filter(([, v]) => typeof v === "number" && v > 0);
  if (h.length < 2) return null;
  const [lastDate, now] = h[h.length - 1];
  const [prevDate, prev] = h[h.length - 2];
  const gap = Math.round((Date.parse(lastDate) - Date.parse(prevDate)) / 86400000);
  const when = gap === 1 ? "yesterday" : `${gap} days earlier`;
  if (now > prev) return `Up from ${DANGER[prev]} ${when}.`;
  if (now < prev) return `Down from ${DANGER[prev]} ${when}.`;
  let n = 1;
  for (let i = h.length - 2; i >= 0 && h[i][1] === now; i -= 1) n += 1;
  return `${DANGER[now]} for ${n} forecasts in a row.`;
}

/** Trips past the forecast carry no danger ratings: a rating is for today
 *  and tomorrow, and weeks out it reads as a prediction it is not (Brian,
 *  2026-11-18). A persistent weak layer is different: it can last weeks or
 *  the season, so it is the one avalanche fact that carries to a trip. One
 *  sentence per center listing one; null when none does. */
export function persistentLayerSegs(rows, season) {
  const zones = regionAvalanche(rows, season).filter((z) => z.persistent);
  if (!zones.length) return null;
  const centers = [...new Map(zones.map((z) => [z.center, z])).values()];
  const segs = [{ t: " " }];
  centers.forEach((z, i) => {
    if (i) segs.push({ t: i === centers.length - 1 ? " and " : ", " });
    /* "The Sierra Avalanche Center", but "Avalanche Canada". */
    const name = /center$/i.test(z.center) && !/^the /i.test(z.center) ? `the ${z.center}` : z.center;
    segs.push({ t: i === 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name, href: z.link ?? null });
  });
  segs.push({ t: `${centers.length > 1 ? " are" : " is"} tracking a persistent weak layer. These can last for weeks, so it is worth watching all the way to your trip.` });
  return segs;
}

const ordinal = (n) => {
  const t = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (t[(v - 20) % 10] || t[v] || t[0]);
};

/** How a resort stands against normal, in a few words, for cards and rows:
 *  % of median SWE once that is meaningful, else the season's rank. */
export function vsNormal(s, { short = false } = {}) {
  if (s?.pctReliable && typeof s.swePctMedian === "number") return short ? `${s.swePctMedian}%` : `${s.swePctMedian}% of normal`;
  if (s?.rank) return short ? `${ordinal(s.rank.position)} of ${s.rank.of}` : `${ordinal(s.rank.position)}-biggest start of ${s.rank.of}`;
  return short ? "—" : "early season";
}
