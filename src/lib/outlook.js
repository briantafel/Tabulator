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
   Canada, 2026-10-31 (Brian approved): the Columbia Mountains resorts move
   out of the Canadian Rockies into a new "BC Interior", split for the best
   bet into the Kootenays and the Okanagan — the names skiers use. Fernie is
   in the Rockies strictly but is filed with the Kootenays, as everyone does.
   Marmot joins the Canadian Rockies, Cypress the Coast Mountains, and the
   Quebec and Ontario resorts the Northeast, where the closing line names the
   province. Blue Mountain's snow is lake-effect off Georgian Bay, but one
   resort does not earn a range of its own. */
/* `warnIn`: the snowfall, in inches, at which the forecaster for that
   mountain issues a winter storm warning (Brian, 2026-10-30: "6\" on the
   east coast is a big day, but in Tahoe that's a moderate day"). US values
   are the NWS's own heavy-snow criteria for the forecast zone each resort's
   `nws` point falls in, read from weather.gov/snow-criteria (layer
   HeavySnowCriteria2026, field SnowCriter) on 2026-10-30: Wasatch UT110/111
   18; Sierra CA072/073/133/136 and NV002 12; Colorado CO004/010/012/018/
   034/068 12; Cascades WA301/302/304 12, OR509 12 above 5,000 ft; Tetons
   WY012 12; Sun Valley ID073 12; Taos NM213 10; Big Sky MT330 9; Vermont
   VT003/006/019 and Whiteface NY034 7. Snowbird and Solitude sit between
   Alta and Brighton, both read as UT111. Canada publishes no amounts any
   more (impact-based alerts since 2025), so Brian set them: 10" in the
   west, and 7" in the east to match the US Northeast. */
export const RANGES = {
  palisades: { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  heavenly: { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  kirkwood: { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  mammoth: { range: "the Sierra", sub: "the Eastern Sierra", state: "California", warnIn: 12 },
  "sugar-bowl": { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  northstar: { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  "mt-rose": { range: "the Sierra", sub: "Tahoe", state: "Nevada", warnIn: 12 },
  "sierra-at-tahoe": { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  homewood: { range: "the Sierra", sub: "Tahoe", state: "California", warnIn: 12 },
  brighton: { range: "the Wasatch", state: "Utah", warnIn: 18 },
  solitude: { range: "the Wasatch", state: "Utah", warnIn: 18 },
  snowbasin: { range: "the Wasatch", state: "Utah", warnIn: 18 },
  "powder-mountain": { range: "the Wasatch", state: "Utah", warnIn: 18 },
  vail: { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  breckenridge: { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  "arapahoe-basin": { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  "wolf-creek": { range: "the Rockies", sub: "the southern Rockies", state: "Colorado", warnIn: 12 },
  "mt-baker": { range: "the Cascades", state: "Washington", warnIn: 12 },
  crystal: { range: "the Cascades", state: "Washington", warnIn: 12 },
  "stevens-pass": { range: "the Cascades", state: "Washington", warnIn: 12 },
  "mt-bachelor": { range: "the Cascades", state: "Oregon", warnIn: 12 },
  whistler: { range: "the Coast Mountains", state: "British Columbia", warnIn: 10 },
  snowbird: { range: "the Wasatch", state: "Utah", warnIn: 18 },
  alta: { range: "the Wasatch", state: "Utah", warnIn: 18 },
  "big-sky": { range: "the Rockies", sub: "the northern Rockies", state: "Montana", warnIn: 9 },
  "jackson-hole": { range: "the Rockies", sub: "the northern Rockies", state: "Wyoming", warnIn: 12 },
  "grand-targhee": { range: "the Rockies", sub: "the northern Rockies", state: "Wyoming", warnIn: 12 },
  "sun-valley": { range: "the Rockies", sub: "the northern Rockies", state: "Idaho", warnIn: 12 },
  telluride: { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  "crested-butte": { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  "aspen-highlands": { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  steamboat: { range: "the Rockies", sub: "the central Rockies", state: "Colorado", warnIn: 12 },
  taos: { range: "the Rockies", sub: "the southern Rockies", state: "New Mexico", warnIn: 10 },
  revelstoke: { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  "kicking-horse": { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  fernie: { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  "red-mountain": { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  whitewater: { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  panorama: { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  kimberley: { range: "the BC Interior", sub: "the Kootenays", state: "British Columbia", warnIn: 10 },
  "big-white": { range: "the BC Interior", sub: "the Okanagan", state: "British Columbia", warnIn: 10 },
  silverstar: { range: "the BC Interior", sub: "the Okanagan", state: "British Columbia", warnIn: 10 },
  "sun-peaks": { range: "the BC Interior", sub: "the Okanagan", state: "British Columbia", warnIn: 10 },
  "lake-louise": { range: "the Canadian Rockies", state: "Alberta", warnIn: 10 },
  sunshine: { range: "the Canadian Rockies", state: "Alberta", warnIn: 10 },
  norquay: { range: "the Canadian Rockies", state: "Alberta", warnIn: 10 },
  marmot: { range: "the Canadian Rockies", state: "Alberta", warnIn: 10 },
  cypress: { range: "the Coast Mountains", state: "British Columbia", warnIn: 10 },
  whiteface: { range: "the Northeast", state: "New York", warnIn: 7 },
  stowe: { range: "the Northeast", state: "Vermont", warnIn: 7 },
  killington: { range: "the Northeast", state: "Vermont", warnIn: 7 },
  "jay-peak": { range: "the Northeast", state: "Vermont", warnIn: 7 },
  tremblant: { range: "the Northeast", state: "Quebec", warnIn: 7 },
  "le-massif": { range: "the Northeast", state: "Quebec", warnIn: 7 },
  "mont-sainte-anne": { range: "the Northeast", state: "Quebec", warnIn: 7 },
  "blue-mountain": { range: "the Northeast", state: "Ontario", warnIn: 7 },
};

/* Below QUIET (inches, biggest total anywhere) there is nothing worth a
   paragraph. A range joins the "moving through" list when its best resort
   gets at least a quarter of the biggest total.

   The storm's strength — Brian, 2026-10-30, after "a strong storm" sat
   beside "up to 16\" over 5 days": let the forecasters decide, but only
   when the snow is really there.
     strong    a winter storm, blizzard or snowfall WARNING (NWS or
               Environment Canada) is in effect at a resort the storm is
               crossing, AND our table has that resort at or above its own
               region's warning amount (`warnIn`) over the window;
     moderate  a watch or advisory, a warning without the snow to back it,
               or 3"+ in a day with no alert;
     light     no alert and under 3" on the heaviest day.
   A feed with no weather at all (the demo, the tests) falls back to the
   old reading of the heaviest single day: under 3" light, over 8" strong.
   Brian's own example calls 17" over five days "moderate", and by either
   rule it is. */
export const QUIET_IN = 1;
const LIGHT_BELOW_IN_DAY = 3;
const STRONG_ABOVE_IN_DAY = 8;
/* Warnings and watches as either agency names them: NWS "Winter Storm
   Warning"; Environment Canada "Snowfall Warning", "Winter Storm Warning",
   "Blizzard Warning", "Snow Squall Warning". */
const WARNING = /^(Winter Storm|Blizzard|Lake Effect Snow|Heavy Snow|Snowfall|Snow Squall) Warning$/i;
const WATCH_OR_ADVISORY = /^(Winter Storm|Blizzard|Lake Effect Snow|Snowfall|Snow Squall) Watch$|^(Winter Weather|Lake Effect Snow) Advisory$/i;

/** "light" | "moderate" | "strong".
 *  rows     snowRows() for the resorts the storm is crossing
 *  weather  weather.json `resorts` map (NWS + Environment Canada)
 *  peakDayIn the storm's heaviest single day, inches */
export function stormWord(rows, weather, peakDayIn) {
  const covered = rows.filter((r) => weather?.[r.id]);
  if (!covered.length) {
    return peakDayIn < LIGHT_BELOW_IN_DAY ? "light" : peakDayIn > STRONG_ABOVE_IN_DAY ? "strong" : "moderate";
  }
  const events = (r) => (weather[r.id].alerts ?? []).map((a) => a.event ?? "");
  const warned = covered.filter((r) => events(r).some((e) => WARNING.test(e)));
  if (warned.some((r) => cmToIn(r.total) >= (RANGES[r.id]?.warnIn ?? Infinity))) return "strong";
  if (warned.length || covered.some((r) => events(r).some((e) => WATCH_OR_ADVISORY.test(e)))) return "moderate";
  return peakDayIn < LIGHT_BELOW_IN_DAY ? "light" : "moderate";
}
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

/** Each resort's snow from today on, with its range, sub-range and state.
 *  Shared with the radar read-out (readout.js) so the two can never rank
 *  the week differently. */
export function snowRows(resorts, now = new Date()) {
  const today = iso(now);
  return (resorts ?? [])
    .filter((r) => RANGES[r.id])
    .map((r) => {
      const days = (r.days ?? []).filter((d) => d.date && d.date >= today);
      const snow = days.map((d) => d.snow ?? 0);
      const total = snow.reduce((s, v) => s + v, 0);
      // Snow-weighted mean day: where in the week this resort's snow lands.
      const when = total ? snow.reduce((s, v, i) => s + v * i, 0) / total : Infinity;
      return { ...r, ...RANGES[r.id], days, snow, total, when };
    });
}

/** Rows grouped into the units the best bet is chosen from — ranges, with
 *  the Rockies and the Sierra broken into their parts — strongest first.
 *  The first entry IS the paragraph's best bet. */
export function unitsOf(rows) {
  const units = new Map();
  for (const r of rows) {
    const key = r.sub ?? r.range;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(r);
  }
  return new Map([...units.entries()]
    .sort((a, b) => strength(b[1].map((r) => r.total)) - strength(a[1].map((r) => r.total))));
}

/**
 * @param resorts  forecast.json resorts (cm)
 * @param opts.now     defaults to now; days before today are ignored
 * @param opts.metric  amount in cm rather than inches
 * @param opts.weather weather.json `resorts` map — its alerts decide how
 *                     strong the storm is (see stormWord)
 * @returns segments [{ t, hot }] — never null
 */
export function outlook(resorts, { now = new Date(), metric = false, weather = null } = {}) {
  const rows = snowRows(resorts, now);

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
  const units = unitsOf(rows);
  const [bestName, bestRows] = units.entries().next().value;

  // Then one step closer: the state, or the resort when the unit is one state
  // — "the Sierra, with California" says the same place twice. Tahoe always
  // names the resort: Mt. Rose puts it across a state line, but "Tahoe, with
  // Nevada" is not how anyone talks about a lake you can drive around.
  const states = new Map();
  for (const r of bestRows) states.set(r.state, Math.max(states.get(r.state) ?? 0, r.total));
  const topResort = bestRows.reduce((a, b) => (b.total > a.total ? b : a));
  const closer = states.size > 1 && bestName !== "Tahoe"
    ? { t: [...states.entries()].sort((a, b) => b[1] - a[1])[0][0], link: { kind: "state" } }
    : { t: topResort.name, link: { kind: "resort", id: topResort.id } };
  closer.link.key = closer.t;

  const inches = cmToIn(biggest.total);
  const peakDay = cmToIn(Math.max(...rows.filter((r) => crossingNames.has(r.range)).flatMap((r) => r.snow)));
  const word = stormWord(rows.filter((r) => crossingNames.has(r.range)), weather, peakDay);
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
