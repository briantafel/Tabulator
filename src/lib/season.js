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
export function regionTable(resorts, season) {
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
    if (rows.length < 2) continue;
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
    });
  }
  const k = (x) => (typeof x === "number" ? x : -Infinity);
  return out.sort((a, b) => k(b.new14Cm) - k(a.new14Cm) || k(b.swePctMedian) - k(a.swePctMedian));
}

/** Which regions a trip is about.
 *  Pinned: the trip holds resorts — their regions, in the trip's order.
 *  Dynamic: the trip holds none — the leading region right now, which moves
 *  as others pull ahead (Brian, 2026-11-17: "These far out trip contents
 *  should be dynamic, unless manually saved to the trip"). */
export function tripRegions(trip, resorts, season) {
  const table = regionTable(resorts, season);
  if (!trip.resorts?.length) return { dynamic: true, regions: table.slice(0, 1) };
  const names = trip.resorts.map((e) => regionOf(resorts.find((r) => r.name === e.name) ?? {})).filter(Boolean);
  const wanted = [...new Set(names)];
  const regions = wanted.map((n) => table.find((g) => g.name === n)).filter(Boolean);
  // Narrow a pinned region to the resorts actually in the trip.
  const inTrip = new Set(trip.resorts.map((e) => e.name));
  return {
    dynamic: false,
    regions: regions.map((g) => ({ ...g, rows: g.rows.filter((x) => inTrip.has(x.r.name)) })).filter((g) => g.rows.length),
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The regional paragraph, as segments ({ t, hot }). Each clause comes from
 *  one number in the table; a missing number drops its clause. */
export function regionParagraph(g, metric) {
  const segs = [];
  const name = cap(g.name);
  if (typeof g.swePctMedian === "number") {
    segs.push({ t: `${name} is running at ` }, { t: `${Math.round(g.swePctMedian)}% of its normal snowpack`, hot: true }, { t: " for the date." });
  } else {
    segs.push({ t: `${name}: it is too early in the season for a fair comparison with normal.` });
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
