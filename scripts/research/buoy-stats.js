/* ------------------------------------------------------------------ *
 * Does a "buoy pop" at NOAA buoy 51101 (NW of Kauai) predict a ski
 * storm about two weeks later? — the scoring, kept pure so it is tested.
 *
 * Brian, 2026-11-15: wants Powder Buoy (powderbuoy.com, Mike Ruzek) as a
 * far-out source — "it's great and dead accurate". We don't reuse Ruzek's
 * posts; we rebuild his signal from the public buoy record and score it
 * against SNOTEL, per the project rule "prove accuracy claims".
 *
 * The trap this test is built around: midwinter storms are frequent, so
 * "a storm about two weeks after a pop" comes true often by chance. Skill
 * means the storm is MORE likely after a pop than on a comparable day
 * without one. So every pop is compared with non-pop days at the same
 * time of winter (± MATCH_DAYS, all winters), and the uncertainty comes
 * from resampling whole winters, because days within a winter are not
 * independent.
 *
 * PRE-REGISTERED (fixed before any result was seen, 2026-11-15):
 *   pop       the day's highest significant wave height (WVHT) at 51101
 *             is ≥ 3.0 m AND at least 1.5 m above the lowest daily high of
 *             the 3 days before; Nov 1 – Mar 31; pops within 5 days of an
 *             earlier one are the same swell event.
 *   storm     a day whose regional SNOTEL precipitation (median of the
 *             stations' daily gauge gain) is ≥ 0.5 in of water (~6–8 in of
 *             snow).
 *   window    any storm day 11–17 days after the pop ("two weeks", ±3).
 *   verdict   skill only if the 90% interval of (P(storm | pop) − matched
 *             base rate) is above zero for the Wasatch, the region the
 *             method was built on.
 * Everything else in the report (other thresholds, regions, the lag
 * scan, the persistence split) is exploratory and labelled so.
 * ------------------------------------------------------------------ */

export const PRIMARY = Object.freeze({
  minHeightM: 3.0, riseM: 1.5, lookback: 3, gapDays: 5, popMonths: [11, 12, 1, 2, 3],
  stormIn: 0.5, from: 11, to: 17,
});
/* LIVE TEST, PRE-REGISTERED 2026-11-17 (Brian, "yes"), before any 2026-27 data.
 * The 2007–2026 history has been looked at many ways (two buoys, overlap,
 * winter by winter), so it can no longer test anything. This rule is scored
 * ONLY on winters from 2026-27 on:
 *   pop, storm, window   exactly PRIMARY (≥ 3.0 m and +1.5 m; ≥ 0.5 in; 11–17 days)
 *   base                 WITHIN THE SAME WINTER: each pop is compared with that
 *                        winter's non-pop days within ±MATCH_DAYS of its date
 *                        (the pooled base mixed dry winters, where pops cluster,
 *                        with wet ones)
 *   region / buoy        Wasatch; buoy 51001 decides, 51101 reported beside it
 *   verdict              not before 3 live winters; then skill iff the 90% range
 *                        of the within-winter difference (winter-block bootstrap)
 *                        is above zero
 * Do not edit these values. A different rule needs a new name and new winters. */
export const LIVE_TEST = Object.freeze({ firstWinter: "2026-27", minWinters: 3, buoy: "51001", region: "Wasatch" });
export const MATCH_DAYS = 10;
export const EXCLUDE_NEAR_POP = 3;
export const BOOTSTRAP = 2000;

const DAY = 86400e3;
export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const month = (ymd) => Number(ymd.slice(5, 7));

/** "2015-11-20" → "2015-16" (a winter runs Oct–Sep). */
export const seasonOf = (ymd) => {
  const y = Number(ymd.slice(0, 4));
  const s = month(ymd) >= 10 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, "0")}`;
};
/** Days since Oct 1 of the winter. */
export const dayOfSeason = (ymd) => {
  const s = Number(seasonOf(ymd).slice(0, 4));
  return Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.parse(`${s}-10-01T00:00:00Z`)) / DAY);
};

/* ---------------------------------------------------------------- buoy */

/** One NDBC standard-meteorological text file → [{ date, wvhtM }].
 *  Columns are found by the header row, not by position: old files have
 *  no minute column. 99 / 99.00 is NDBC's "missing". */
export function parseNdbc(text) {
  const lines = String(text).split(/\r?\n/);
  const head = lines.find((l) => /^#?\s*(YY|YYYY)\b/.test(l));
  if (!head) throw new Error("NDBC file has no header row");
  const cols = head.replace(/^#/, "").trim().split(/\s+/);
  const at = (name) => cols.indexOf(name);
  const iY = at("YY") >= 0 ? at("YY") : at("YYYY"), iM = at("MM"), iD = at("DD"), iW = at("WVHT");
  if ([iY, iM, iD, iW].some((i) => i < 0)) throw new Error(`NDBC header lacks a needed column: ${head}`);
  const out = [];
  for (const l of lines) {
    if (!l.trim() || l.startsWith("#") || /^\s*(YY|YYYY)\b/.test(l)) continue;
    const f = l.trim().split(/\s+/);
    let y = Number(f[iY]);
    if (y < 100) y += 1900;
    const w = Number(f[iW]);
    if (!Number.isFinite(w) || w >= 99) continue;
    out.push({ date: `${y}-${String(f[iM]).padStart(2, "0")}-${String(f[iD]).padStart(2, "0")}`, wvhtM: w });
  }
  return out;
}

/** Highest reading per UTC day. */
export function dailyMax(readings) {
  const m = new Map();
  for (const { date, wvhtM } of readings) m.set(date, Math.max(m.get(date) ?? -Infinity, wvhtM));
  return m;
}

/** Pop days from daily highs, per the definition in `def`. */
export function findPops(daily, def = PRIMARY) {
  const days = [...daily.keys()].sort();
  const pops = [];
  for (const d of days) {
    if (!def.popMonths.includes(month(d))) continue;
    const h = daily.get(d);
    if (h < def.minHeightM) continue;
    const before = Array.from({ length: def.lookback }, (_, i) => daily.get(addDays(d, -(i + 1)))).filter((v) => v != null);
    if (before.length < def.lookback) continue; // gaps: no pop can be judged
    if (h - Math.min(...before) < def.riseM) continue;
    const last = pops[pops.length - 1];
    if (last && (Date.parse(d) - Date.parse(last)) / DAY <= def.gapDays) continue;
    pops.push(d);
  }
  return pops;
}

/* ---------------------------------------------------------------- snow */

/** Station daily gauge gains (inches of water) → region daily value: the
 *  median of the stations reporting that day, if at least half do.
 *  Missing is never zero (project rule). */
export function regionDaily(stationGains) {
  const n = stationGains.length;
  const dates = new Set(stationGains.flatMap((s) => [...s.keys()]));
  const out = new Map();
  for (const d of dates) {
    const v = stationGains.map((s) => s.get(d)).filter((x) => x != null).sort((a, b) => a - b);
    if (v.length * 2 < n) continue;
    const mid = v.length >> 1;
    out.set(d, v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
  }
  return out;
}

/** Accumulated-precipitation readings (PREC, resets Oct 1) → daily gain.
 *  Negative steps (resets, gauge drift) and implausible jumps are dropped,
 *  not zeroed. */
export function gainsFromAccum(values) {
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (addDays(a.date, 1) !== b.date) continue;
    const g = b.value - a.value;
    if (g < 0 || g > 6) continue;
    out.set(b.date, g);
  }
  return out;
}

/** Was there a storm day in [d+from, d+to]? null when too much of the
 *  window is missing to say (more than a third). */
export function stormWithin(d, region, def = PRIMARY) {
  let seen = 0, missing = 0;
  for (let k = def.from; k <= def.to; k++) {
    const v = region.get(addDays(d, k));
    if (v == null) { missing++; continue; }
    if (v >= def.stormIn) seen++;
  }
  if (missing * 3 > def.to - def.from + 1) return null;
  return seen > 0;
}

/* ---------------------------------------------------------------- scoring */

/** A seeded generator, so a rerun gives the same intervals. */
function rng(seed = 12345) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs, q) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/** Candidate days: inside the pop months, with a judgeable outcome. */
function caseDays(region, popSet, def) {
  const near = (d) => [...Array(2 * EXCLUDE_NEAR_POP + 1)].some((_, i) => popSet.has(addDays(d, i - EXCLUDE_NEAR_POP)));
  const out = [];
  for (const d of region.keys()) {
    if (!def.popMonths.includes(month(d))) continue;
    const y = stormWithin(d, region, def);
    if (y == null) continue;
    out.push({ d, season: seasonOf(d), dos: dayOfSeason(d), y: y ? 1 : 0, pop: popSet.has(d), near: !popSet.has(d) && near(d) });
  }
  return out;
}

/**
 * P(storm | pop) against the base rate of non-pop days at the same time of
 * winter, with a 90% interval from resampling whole winters.
 */
export function score(pops, region, def = PRIMARY, { boot = BOOTSTRAP, seed = 12345, within = false } = {}) {
  const popSet = new Set(pops);
  const all = caseDays(region, popSet, def);
  const popCases = all.filter((c) => c.pop);
  const base = all.filter((c) => !c.pop && !c.near);
  const bySeason = (xs) => xs.reduce((m, c) => m.set(c.season, [...(m.get(c.season) ?? []), c]), new Map());

  const stat = (pc, bc) => {
    if (!pc.length || !bc.length) return { pPop: NaN, pBase: NaN, diff: NaN, lift: NaN };
    // Matched base: for each pop, the base rate of days within ±MATCH_DAYS
    // of its day of winter, across the winters in this sample.
    // within: only the pop's own winter (LIVE_TEST); otherwise every winter in the sample.
    const key = (season, dos) => (within ? `${season}|${dos}` : String(dos));
    const byDos = new Map();
    for (const c of bc) byDos.set(key(c.season, c.dos), [...(byDos.get(key(c.season, c.dos)) ?? []), c.y]);
    const matched = pc.map((c) => {
      const ys = [];
      for (let k = c.dos - MATCH_DAYS; k <= c.dos + MATCH_DAYS; k++) ys.push(...(byDos.get(key(c.season, k)) ?? []));
      return mean(ys);
    }).filter(Number.isFinite);
    const pPop = mean(pc.map((c) => c.y)), pBase = mean(matched);
    return { pPop, pBase, diff: pPop - pBase, lift: pPop / pBase };
  };

  const point = stat(popCases, base);
  const P = bySeason(popCases), B = bySeason(base);
  const seasons = [...new Set(all.map((c) => c.season))].sort();
  const r = rng(seed), diffs = [], lifts = [];
  for (let b = 0; b < boot; b++) {
    const pick = seasons.map(() => seasons[Math.floor(r() * seasons.length)]);
    const s = stat(pick.flatMap((x) => P.get(x) ?? []), pick.flatMap((x) => B.get(x) ?? []));
    diffs.push(s.diff); lifts.push(s.lift);
  }
  return {
    ...point,
    nPops: popCases.length, nBase: base.length, seasons: seasons.length,
    diff90: [quantile(diffs, 0.05), quantile(diffs, 0.95)],
    lift90: [quantile(lifts, 0.05), quantile(lifts, 0.95)],
    skill: quantile(diffs, 0.05) > 0,
  };
}

/** Exploratory: is a pop just a marker of an already-stormy pattern?
 *  Split pop and base days by whether a storm hit in the 7 days before. */
export function persistenceSplit(pops, region, def = PRIMARY) {
  const popSet = new Set(pops);
  const all = caseDays(region, popSet, def);
  const prior = (d) => [...Array(7)].some((_, i) => (region.get(addDays(d, -(i + 1))) ?? 0) >= def.stormIn);
  const cell = (pop, pr) => {
    const xs = all.filter((c) => (pop ? c.pop : !c.pop && !c.near) && prior(c.d) === pr);
    return { n: xs.length, p: mean(xs.map((c) => c.y)) };
  };
  return {
    afterStorm: { pop: cell(true, true), base: cell(false, true) },
    afterQuiet: { pop: cell(true, false), base: cell(false, false) },
  };
}

/** Exploratory: storm chance on the single day d+L after a pop, against
 *  all non-pop days, for L = 0..maxLag. A real two-week signal shows a
 *  bump near 14; a flat line means the window result is chance. */
export function lagScan(pops, region, def = PRIMARY, maxLag = 28) {
  const popSet = new Set(pops);
  const days = [...region.keys()].filter((d) => def.popMonths.includes(month(d)));
  const out = [];
  for (let L = 0; L <= maxLag; L++) {
    const at = (d) => region.get(addDays(d, L));
    const pv = days.filter((d) => popSet.has(d)).map(at).filter((v) => v != null).map((v) => (v >= def.stormIn ? 1 : 0));
    const bv = days.filter((d) => !popSet.has(d)).map(at).filter((v) => v != null).map((v) => (v >= def.stormIn ? 1 : 0));
    out.push({ lag: L, pPop: mean(pv), pBase: mean(bv), n: pv.length });
  }
  return out;
}
