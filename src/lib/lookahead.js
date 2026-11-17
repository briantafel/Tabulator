/* Looking ahead, for a region on a trip the forecast has not reached
 * (claude/calendar-shaping-up-plan.md). Nearest horizon first, each row
 * with how sure it is. Every number comes from a file the app already has:
 *
 *   forecast   the days the app shows (Snow-Forecast + our blend), not
 *              projected: "Likely".
 *   ensembles  the projected days' members (ECMWF + GEFS, projections.json),
 *              added up member by member for the region: a probability.
 *              Labelled Beta until scored over several storm cycles (Brian,
 *              2026-11-17).
 *   NOAA       CPC's 8–14 day outlook at the region's resorts (season.json):
 *              a tilt, "A lean".
 *   season     CPC's ENSO status (season.json): the backdrop.
 *
 * Plain arithmetic; the wording only restates the numbers (settled rule).
 */
import { snowWithUnit } from "./units.js";
import { shortDate, fromIso } from "./dates.js";

const weekday = (d) => fromIso(d).toLocaleDateString("en-US", { weekday: "long" });

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** The region's forecast days (not projected): typical total, the leader,
 *  and the day that carries most of it. */
export function forecastRow(feedRows, metric) {
  const withDays = feedRows.filter((r) => r?.days?.length);
  if (!withDays.length) return null;
  const days = withDays[0].days.filter((d) => !d.projected).map((d) => d.date);
  if (!days.length) return null;
  const total = (r) => {
    const v = r.days.filter((d) => !d.projected && typeof d.snow === "number").map((d) => d.snow);
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const totals = withDays.map((r) => ({ r, t: total(r) })).filter((x) => x.t != null);
  if (!totals.length) return null;
  const typical = median(totals.map((x) => x.t));
  const lead = totals.reduce((a, b) => (b.t > a.t ? b : a));
  const byDay = days.map((date) => ({ date, v: median(withDays.map((r) => r.days.find((d) => d.date === date)?.snow)) }));
  const peak = byDay.reduce((a, b) => ((b.v ?? -1) > (a.v ?? -1) ? b : a));
  const segs = typical < 1
    ? [{ t: `Little or no snow in the next ${days.length} days.` }]
    : [{ t: "About " }, { t: snowWithUnit(typical, metric), hot: true }, { t: ` at a typical resort here over the next ${days.length} days` },
       ...(peak.v >= 1 && peak.v >= typical * 0.4 ? [{ t: ", most of it " }, { t: weekday(peak.date), hot: true }] : []),
       { t: "." },
       ...(lead.t > typical * 1.25 ? [{ t: ` ${lead.r.name} leads with ${snowWithUnit(lead.t, metric)}.` }] : [])];
  return { horizon: `Next ${days.length} days`, conf: "likely", segs };
}

/** The projected days, member by member: each model's members carry equal
 *  total weight; a member's region figure is the mean of its window totals
 *  across the region's resorts. */
export function ensembleRow(feedRows, metric, { stormCm = 30 } = {}) {
  const pm = feedRows.map((r) => r?.projMembers).filter(Boolean);
  if (!pm.length) return null;
  const dates = pm[0].dates;
  if (!dates?.length) return null;
  const models = Object.keys(pm[0].models ?? {});
  const items = [];
  for (const m of models) {
    const rows = pm.map((p) => p.models?.[m]).filter((x) => x?.length);
    if (!rows.length) continue;
    const n = Math.min(...rows.map((x) => x.length));
    const w = 1 / (models.length * n);
    for (let k = 0; k < n; k++) {
      const sums = rows.map((x) => {
        const v = x[k];
        return v && v.every((y) => typeof y === "number") ? v.reduce((a, b) => a + b, 0) : null;
      }).filter((x) => x != null);
      if (sums.length) items.push({ v: sums.reduce((a, b) => a + b, 0) / sums.length, w });
    }
  }
  if (!items.length) return null;
  const wsum = items.reduce((a, b) => a + b.w, 0);
  const p = items.filter((x) => x.v >= stormCm).reduce((a, b) => a + b.w, 0) / wsum;
  const sorted = [...items].sort((a, b) => a.v - b.v);
  let acc = 0, mid = sorted[0].v;
  for (const x of sorted) { acc += x.w; if (acc >= wsum / 2) { mid = x.v; break; } }
  const tens = Math.round(p * 10);
  const conf = p >= 0.6 ? "likely" : p >= 0.3 ? "possible" : "lean";
  const segs = [
    { t: `${tens} in 10`, hot: tens >= 5 }, { t: ` ensemble runs bring ${snowWithUnit(stormCm, metric)} or more to a typical resort here between ` },
    { t: `${shortDate(dates[0])} and ${shortDate(dates[dates.length - 1])}` }, { t: `. The middle run brings about ${snowWithUnit(mid, metric)}.` },
  ];
  return { horizon: `${shortDate(dates[0])}–${shortDate(dates[dates.length - 1])}`, conf, beta: true, segs };
}

const LEAN = {
  above: { precip: "wetter than normal", temp: "warmer-than-normal temperatures" },
  below: { precip: "drier than normal", temp: "colder-than-normal temperatures" },
  near: { precip: "near-normal precipitation", temp: "near-normal temperatures" },
};

/** CPC 8–14 day outlook: the category most of the region's resorts sit in. */
export function noaaRow(ids, season) {
  const pick = (what) => {
    const xs = ids.map((id) => season?.outlook?.[id]?.d8_14?.[what]).filter(Boolean);
    if (!xs.length) return null;
    const count = new Map();
    for (const x of xs) count.set(x.category, (count.get(x.category) ?? 0) + 1);
    const cat = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const probs = xs.filter((x) => x.category === cat).map((x) => x.prob).filter((v) => typeof v === "number");
    return { cat, prob: probs.length ? Math.round(median(probs)) : null, start: xs[0].start, end: xs[0].end };
  };
  const pr = pick("precip"), tp = pick("temp");
  if (!pr && !tp) return null;
  const part = (x, what) => (!x ? null : x.cat === "equal" ? null : `${LEAN[x.cat][what]}${x.prob ? ` (${x.prob}% chance)` : ""}`);
  const pBit = part(pr, "precip"), tBit = part(tp, "temp");
  const bits = [pBit, tBit].filter(Boolean);
  const when = pr?.start && pr?.end ? `${shortDate(pr.start)}–${shortDate(pr.end)}` : "Days 8–14";
  const segs = bits.length
    ? [{ t: "NOAA's 8–14 day outlook leans " },
       ...(pBit ? [{ t: pBit, hot: pr.cat === "above" }] : []),
       ...(pBit && tBit ? [{ t: ", with " }] : []),
       ...(tBit ? [{ t: tBit }] : []),
       { t: ". A tilt in the odds, not a storm." }]
    : [{ t: "NOAA's 8–14 day outlook gives equal chances either way here: no tilt to go on yet." }];
  return { horizon: when, conf: "lean", segs };
}

/** Which checkpoint speaks to a trip: the first of the month after it starts
 *  (a December trip is judged on Jan 1), Apr 1 for spring trips or none. */
export function ensoCheckpoint(start) {
  const m = start ? Number(start.slice(5, 7)) : null;
  if (m === 10 || m === 11 || m === 12) return "01-01";
  if (m === 1) return "02-01";
  if (m === 2) return "03-01";
  return "04-01";
}
const CHECK_LABEL = { "01-01": "Jan 1", "02-01": "Feb 1", "03-01": "Mar 1", "04-01": "Apr 1" };

/** NOAA's status names the class we compare against: "strong" in the
 *  status or synopsis means strong El Niño winters, else any El Niño; La
 *  Niña likewise. Neutral or unknown: no comparison. */
export function currentEnso(e) {
  const t = `${e?.status ?? ""} ${e?.synopsis ?? ""}`;
  if (/El Ni(ñ|n)o/i.test(t) && !/La Ni(ñ|n)a/i.test(e?.status ?? "")) return /strong/i.test(t) ? "strongElNino" : "elNino";
  if (/La Ni(ñ|n)a/i.test(t)) return "laNina";
  return null;
}
const CLASS_NAME = { strongElNino: "strong El Niño", elNino: "El Niño", laNina: "La Niña" };

/** What past winters like this one did in this region (Brian, 2026-11-17:
 *  "state what El Niño means for that region"). Plain rules over our own
 *  SNOTEL history (season.ensoHistory):
 *    tended to favor:  ≥ 3 in 4 at or above normal and median ≥ 110%
 *    tended to short:  ≤ 1 in 4 at or above normal and median ≤ 90%
 *    otherwise: it has gone either way, and we say so.
 *  Fewer than 3 strong winters falls back to all El Niño winters. Under 8
 *  winters is called a small sample. */
export function ensoHistoryLine(region, season, start) {
  const cls = currentEnso(season?.enso);
  const reg = season?.ensoHistory?.regions?.[region];
  if (!cls || !reg) return null;
  const md = ensoCheckpoint(start);
  const at = reg[md];
  let key = cls;
  if (key === "strongElNino" && !(at?.strongElNino?.n >= 3)) key = "elNino";
  const g = at?.[key];
  if (!g?.n || g.n < 3) return null;
  const pcts = g.years.map(([, , p]) => p);
  const lo = Math.min(...pcts), hi = Math.max(...pcts);
  const Name = region.charAt(0).toUpperCase() + region.slice(1);
  const share = g.above / g.n;
  const verdict = share >= 0.75 && g.median >= 110 ? `Past ${CLASS_NAME[key]} winters have tended to favor ${region}.`
    : share <= 0.25 && g.median <= 90 ? `Past ${CLASS_NAME[key]} winters have tended to leave ${region} short.`
      : `Here it has gone either way: ${CLASS_NAME[key]} has not decided the season.`;
  const segs = [
    { t: ` In the ${g.n} ${CLASS_NAME[key]} winters since ${g.years[0][0]}, ${Name}'s snowpack on ${CHECK_LABEL[md]} ran ` },
    { t: `${lo}–${hi}% of normal`, hot: true },
    { t: `, ${g.above} of ${g.n} at or above it. ${verdict}` },
  ];
  if (g.n < 8) segs.push({ t: ` ${g.n} winters is a small sample.` });
  return { segs, years: g.years, checkpoint: md, key };
}

export function ensoRow(season, region = null, start = null) {
  const e = season?.enso;
  if (!e?.status) return null;
  const hist = region ? ensoHistoryLine(region, season, start) : null;
  const segs = [{ t: `${e.status}.`, hot: true }, ...(e.synopsis ? [{ t: ` ${e.synopsis}` }] : []), ...(hist?.segs ?? [])];
  return { horizon: "The season", conf: "backdrop", segs, source: hist ? "NOAA CPC, our SNOTEL history" : "NOAA CPC" };
}

/** All rows for a region, nearest horizon first; rows without data drop out. */
export function lookAhead(g, { resorts, season, metric, projections = null, start = null }) {
  const ids = g.rows.map((x) => x.r.id);
  /* Members straight from projections.json when the feed was not extended
     (the projections switch is per phone; this row is shown to everyone,
     labelled Beta). Same choice as lib/projections.js: our SLR members when
     every day has them. */
  const membersFor = (id) => {
    const p = projections?.resorts?.[id];
    if (!p?.days?.length) return null;
    const useSlr = !!p.membersSlr && p.days.every((d) => !d.snow || d.snowSlr);
    const mem = useSlr ? p.membersSlr : p.members;
    return mem ? { dates: p.days.map((d) => d.date), models: mem } : null;
  };
  const feedRows = ids.map((id) => resorts.find((r) => r.id === id)).filter(Boolean)
    .map((r) => (r.projMembers ? r : { ...r, projMembers: membersFor(r.id) }));
  return [forecastRow(feedRows, metric), ensembleRow(feedRows, metric), noaaRow(ids, season), ensoRow(season, g.name, start)].filter(Boolean);
}

export const CONF = {
  likely: { dots: "● ● ●", label: "Likely" },
  possible: { dots: "● ● ○", label: "Possible" },
  lean: { dots: "● ○ ○", label: "A lean" },
  backdrop: { dots: null, label: "Backdrop" },
};
