/* The forecaster's paragraph under the radar grid.
 *
 * Brian's design (Figma 2142:872) and his wording, 2026-10-29:
 *
 *   A moderate storm is moving through the Rockies, with up to 17" falling
 *   over the next 5 days. The best bet for snow is the northern Rockies, with
 *   Montana the strongest move right now.
 *
 * Every word in a slot is read off the scraped numbers — no model, no prose
 * from anywhere else. It zooms in step by step: the storm, the ranges it
 * crosses, the best part of one range, then the state or resort inside it.
 *
 * Returned as segments, like verdict.js, so the view colours the computed
 * parts without parsing its own sentence. `hot` marks the five his mock draws
 * in red; the storm's strength is drawn grey there, so it stays grey here.
 */

import { cmToIn } from "./units.js";

/* Ranges, as Brian drew the lines: the Wasatch apart from the Rockies, the
   Canadian Rockies apart from both, and the coast — Whistler — on its own.
   The Rockies split into northern, central and southern; the Sierra into
   Tahoe and the Eastern Sierra (Mammoth) — a different trip, a different
   airport, and often a different storm. Splits only ever name the best bet;
   the "moving through" list stays at range level.
   Revelstoke and Kicking Horse sit in the Columbia Mountains, strictly, but
   skiers file them with Lake Louise and so does he. */
export const RANGES = {
  palisades: { range: "the Sierra", sub: "Tahoe", state: "California" },
  heavenly: { range: "the Sierra", sub: "Tahoe", state: "California" },
  kirkwood: { range: "the Sierra", sub: "Tahoe", state: "California" },
  mammoth: { range: "the Sierra", sub: "the Eastern Sierra", state: "California" },
  "mt-baker": { range: "the Cascades", state: "Washington" },
  crystal: { range: "the Cascades", state: "Washington" },
  "stevens-pass": { range: "the Cascades", state: "Washington" },
  "mt-bachelor": { range: "the Cascades", state: "Oregon" },
  whistler: { range: "the Coast Mountains", state: "British Columbia" },
  snowbird: { range: "the Wasatch", state: "Utah" },
  alta: { range: "the Wasatch", state: "Utah" },
  "big-sky": { range: "the Rockies", sub: "the northern Rockies", state: "Montana" },
  "jackson-hole": { range: "the Rockies", sub: "the northern Rockies", state: "Wyoming" },
  "grand-targhee": { range: "the Rockies", sub: "the northern Rockies", state: "Wyoming" },
  "sun-valley": { range: "the Rockies", sub: "the northern Rockies", state: "Idaho" },
  telluride: { range: "the Rockies", sub: "the central Rockies", state: "Colorado" },
  "crested-butte": { range: "the Rockies", sub: "the central Rockies", state: "Colorado" },
  "aspen-highlands": { range: "the Rockies", sub: "the central Rockies", state: "Colorado" },
  steamboat: { range: "the Rockies", sub: "the central Rockies", state: "Colorado" },
  taos: { range: "the Rockies", sub: "the southern Rockies", state: "New Mexico" },
  revelstoke: { range: "the Canadian Rockies", state: "British Columbia" },
  "kicking-horse": { range: "the Canadian Rockies", state: "British Columbia" },
  "lake-louise": { range: "the Canadian Rockies", state: "Alberta" },
  whiteface: { range: "the Northeast", state: "New York" },
  stowe: { range: "the Northeast", state: "Vermont" },
  killington: { range: "the Northeast", state: "Vermont" },
  "jay-peak": { range: "the Northeast", state: "Vermont" },
};

/* Below QUIET (inches, biggest total anywhere) there is nothing worth a
   paragraph. A range joins the "moving through" list when its best resort
   gets at least a quarter of the biggest total.

   The storm's strength is read off its heaviest single DAY, not its total:
   Brian's own example calls 17" over five days "moderate", and it is — that
   is a steady few inches a day. A foot in one day is what reads as strong. */
const QUIET_IN = 1;
const LIGHT_BELOW_IN_DAY = 3;
const STRONG_ABOVE_IN_DAY = 8;
const JOIN_SHARE = 0.25;
const MAX_RANGES = 3;
const WET_DAY_CM = 1; // a day counts toward "over the next N days" from here

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Mean of a group's two best totals — one lucky resort should not make a
 *  range the best bet on its own. */
const strength = (totals) => {
  const top = [...totals].sort((a, b) => b - a).slice(0, 2);
  return top.reduce((s, v) => s + v, 0) / top.length;
};

/**
 * @param resorts  forecast.json resorts (cm)
 * @param opts.now     defaults to now; days before today are ignored
 * @param opts.metric  amount in cm rather than inches
 * @returns segments [{ t, hot }] — never null
 */
export function outlook(resorts, { now = new Date(), metric = false } = {}) {
  const today = iso(now);
  const rows = (resorts ?? [])
    .filter((r) => RANGES[r.id])
    .map((r) => {
      const days = (r.days ?? []).filter((d) => d.date && d.date >= today);
      const snow = days.map((d) => d.snow ?? 0);
      const total = snow.reduce((s, v) => s + v, 0);
      // Snow-weighted mean day: where in the week this resort's snow lands.
      const when = total ? snow.reduce((s, v, i) => s + v * i, 0) / total : Infinity;
      return { ...r, ...RANGES[r.id], snow, total, when };
    });

  const nDays = Math.max(0, ...rows.map((r) => r.snow.length));
  const biggest = rows.reduce((a, b) => (b.total > (a?.total ?? -1) ? b : a), null);
  if (!biggest || cmToIn(biggest.total) < QUIET_IN) {
    return [{ t: `No significant snow anywhere in the next ${nDays || 6} days.`, hot: false }];
  }

  // The ranges the storm is crossing, in the order it reaches them.
  const byRange = new Map();
  for (const r of rows) {
    if (!byRange.has(r.range)) byRange.set(r.range, []);
    byRange.get(r.range).push(r);
  }
  const crossing = [...byRange.entries()]
    .map(([name, rs]) => {
      const top = Math.max(...rs.map((r) => r.total));
      const wet = rs.filter((r) => r.total > 0);
      const when = wet.reduce((s, r) => s + r.when * r.total, 0) / (wet.reduce((s, r) => s + r.total, 0) || 1);
      return { name, top, when };
    })
    .filter((g) => g.top >= Math.max(biggest.total * JOIN_SHARE, QUIET_IN * 2.54))
    .sort((a, b) => b.top - a.top)
    .slice(0, MAX_RANGES)
    .sort((a, b) => a.when - b.when || b.top - a.top);
  const crossingNames = new Set(crossing.map((g) => g.name));

  // Over how many days: up to the last day that range gets real snow.
  let lastWet = 0;
  for (const r of rows) {
    if (!crossingNames.has(r.range)) continue;
    r.snow.forEach((v, i) => { if (v >= WET_DAY_CM) lastWet = Math.max(lastWet, i); });
  }
  const span = lastWet + 1;
  const over = span === 1 ? "today" : `the next ${span} days`;

  // Best bet: ranges, with the Rockies broken into their parts.
  const units = new Map();
  for (const r of rows) {
    const key = r.sub ?? r.range;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(r);
  }
  const [bestName, bestRows] = [...units.entries()]
    .sort((a, b) => strength(b[1].map((r) => r.total)) - strength(a[1].map((r) => r.total)))[0];

  // Then one step closer: the state, or the resort when the unit is one state
  // — "the Sierra, with California" says the same place twice.
  const states = new Map();
  for (const r of bestRows) states.set(r.state, Math.max(states.get(r.state) ?? 0, r.total));
  const topResort = bestRows.reduce((a, b) => (b.total > a.total ? b : a));
  const closer = states.size > 1
    ? { t: [...states.entries()].sort((a, b) => b[1] - a[1])[0][0], link: { kind: "state" } }
    : { t: topResort.name, link: { kind: "resort", id: topResort.id } };
  closer.link.key = closer.t;

  const inches = cmToIn(biggest.total);
  const peakDay = cmToIn(Math.max(...rows.filter((r) => crossingNames.has(r.range)).flatMap((r) => r.snow)));
  const word = peakDay < LIGHT_BELOW_IN_DAY ? "light" : peakDay > STRONG_ABOVE_IN_DAY ? "strong" : "moderate";
  const amount = metric
    ? `${Math.max(1, Math.round(biggest.total))}cm`
    : `${Math.max(1, Math.round(inches))}"`;

  /* Brian, 2026-10-29: each range is tappable, and so is the place the
     sentence closes on. "the" stays outside the link — he bracketed
     "the [Sierra]" — but inside the red, which runs across the whole list. */
  const place = (label, link) => (label.startsWith("the ")
    ? [{ t: "the ", hot: true }, { t: label.slice(4), hot: true, link }]
    : [{ t: label, hot: true, link }]); // "Tahoe" takes no article
  const kindOf = (name) => (units.has(name) && rows.some((r) => r.sub === name) ? "sub" : "range");
  const through = [];
  crossing.forEach((g, i) => {
    if (i) through.push({ t: i === crossing.length - 1 ? " and " : ", ", hot: true });
    through.push(...place(g.name, { kind: "range", key: g.name }));
  });

  return [
    { t: `A ${word} storm is moving through `, hot: false },
    ...through,
    { t: ", with up to ", hot: false },
    { t: amount, hot: true },
    { t: " falling over ", hot: false },
    { t: over, hot: true },
    { t: ". The best bet for snow is ", hot: false },
    ...place(bestName, { kind: kindOf(bestName), key: bestName }),
    { t: ", with ", hot: false },
    { t: closer.t, hot: true, link: closer.link },
    { t: " the strongest move right now.", hot: false },
  ];
}

/** The resorts a tapped place stands for. */
export function membersOf(link) {
  if (!link) return [];
  if (link.kind === "resort") return [link.id];
  const field = link.kind === "sub" ? "sub" : link.kind === "state" ? "state" : "range";
  return Object.entries(RANGES).filter(([, v]) => v[field] === link.key).map(([id]) => id);
}

/** Heading for a place's card: "Sierra", "Northern Rockies", "Montana". */
export const titleOf = (link) => {
  const t = String(link?.key ?? "").replace(/^the /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
