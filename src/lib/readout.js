/* The radar read-out — a few short paragraphs under the forecaster's
 * paragraph, one per region that is actually getting snow.
 *
 * Brian's rules, 2026-10-30 (claude/radar-readout-spec.md):
 *   1. Current data drives it and it must agree with the radar. The regions,
 *      their order and every total come from forecast.json, ranked by the
 *      very code the paragraph uses (snowRows / unitsOf in outlook.js).
 *   2. Only regions we have resorts in — no national forecast.
 *   3. Skip regions with no or minimal snow (CUTOFF_IN).
 *   4. "Right now" colour comes from the NWS point forecasts issued in the
 *      same run (weather.json).
 *   5. Forecaster discussions that are not current only feed "Looking ahead",
 *      about storms past the radar's window.
 *   6. Inches always come from our table, never from anyone's prose.
 *
 * Three pieces, all pure so they run in the Action and in the tests alike:
 *   readoutFacts()    — the fact sheet. Everything the read-out may say.
 *   templateReadout() — prose from the fact sheet with no model at all.
 *   validateReadout() — the gate any writer's output must pass: same regions
 *                       in the same order, no number that is not in the fact
 *                       sheet, no place that is not in it, length caps.
 */

import { snowRows, unitsOf, titleOf, QUIET_IN } from "./outlook.js";
import { cmToIn } from "./units.js";

/** A region joins the read-out when one of its resorts gets this much over
 *  the window. Proposed 2026-10-30; Brian has not confirmed the number. The
 *  paragraph's best bet is always included, whatever its total, so the
 *  read-out never fails to mention the place the sentence above it names. */
export const CUTOFF_IN = 6;

const MAX_RESORTS = 3;          // per region, strongest first
const NWS_RESORTS = 2;          // whose NWS periods go in the fact sheet
const MAX_PERIODS = 8;
const DETAIL_CHARS = 240;
export const REGION_TEXT_MAX = 420;
export const AHEAD_TEXT_MAX = 320;

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dowOf = (date) => DOW[new Date(`${date}T12:00:00Z`).getUTCDay()];
const inch = (cm) => Math.round(cmToIn(cm));
const WET = /snow|rain|sleet|flurr|freezing|mix|storm|shower/i;

/** The NWS periods worth quoting for one resort: wet ones, inside the window. */
function nwsFor(wx, from, to) {
  return (wx?.periods ?? [])
    .filter((p) => {
      const d = String(p.startTime ?? "").slice(0, 10);
      return d >= from && d <= to && (WET.test(p.shortForecast ?? "") || /accumulation/i.test(p.detailedForecast ?? ""));
    })
    .slice(0, MAX_PERIODS)
    .map((p) => ({
      name: p.name,
      short: p.shortForecast,
      ...(p.detailedForecast ? { detail: p.detailedForecast.slice(0, DETAIL_CHARS) } : {}),
      tempF: p.temperature,
    }));
}

/**
 * @param resorts  forecast.json resorts (cm)
 * @param weather  weather.json `resorts` map (may be empty)
 * @param ahead    [{ source, issuedAt, url, excerpt }] — fresh discussions only;
 *                 the caller decides freshness
 */
export function readoutFacts({ resorts, weather = {}, generatedAt = null, now = new Date(), ahead = [] }) {
  const rows = snowRows(resorts, now);
  const all = rows.map((r) => r.days.map((d) => d.date)).find((d) => d.length) ?? [];
  const window = { from: all[0] ?? null, to: all[all.length - 1] ?? null, days: all.length };
  const biggest = Math.max(0, ...rows.map((r) => r.total));

  if (cmToIn(biggest) < QUIET_IN) {
    return { generatedAt, window, quiet: true, regions: [], ahead: [], offLimits: [] };
  }

  const units = [...unitsOf(rows).entries()];
  const regions = [];
  units.forEach(([name, rs], i) => {
    const sorted = [...rs].sort((a, b) => b.total - a.total);
    if (i > 0 && cmToIn(sorted[0].total) < CUTOFF_IN) return;
    const top = sorted.filter((r) => inch(r.total) >= 1).slice(0, MAX_RESORTS);
    if (!top.length) return;
    regions.push({
      key: name,
      title: titleOf({ key: name }),
      range: rs[0].range,
      bestBet: i === 0,
      resorts: top.map((r, j) => {
        const days = r.days
          .map((d) => ({ date: d.date, dow: dowOf(d.date), in: inch(d.snow ?? 0) }))
          .filter((d) => d.in >= 1);
        const peak = days.reduce((a, b) => (b.in > (a?.in ?? -1) ? b : a), null);
        const wx = weather[r.id];
        return {
          id: r.id,
          name: r.name,
          state: r.state,
          totalIn: inch(r.total),
          days,
          ...(peak ? { peak: { dow: peak.dow, in: peak.in } } : {}),
          ...(j < NWS_RESORTS && wx ? {
            nws: nwsFor(wx, window.from, window.to),
            ...(wx.alerts?.length ? { alerts: wx.alerts.map((a) => a.event) } : {}),
          } : {}),
        };
      }),
    });
  });

  /* Every place name the read-out must NOT use: anything belonging only to
     a region that did not make the cut. The validator reads this; the model
     never sees it. */
  const inRegions = new Set(regions.map((g) => g.key));
  const allowed = new Set();
  const universe = new Set();
  const bare = (s) => String(s).replace(/^the /, "");
  for (const r of rows) {
    const names = [r.name, r.state, bare(r.range), r.sub && bare(r.sub)].filter(Boolean);
    names.forEach((n) => universe.add(n));
    if (inRegions.has(r.sub ?? r.range)) names.forEach((n) => allowed.add(n));
  }
  const offLimits = [...universe].filter((n) => !allowed.has(n) && ![...allowed].some((a) => a.includes(n)));

  return { generatedAt, window, quiet: false, regions, ahead, offLimits };
}

/** The fact sheet as the model sees it: without the validator's own list. */
export const factsForWriter = ({ offLimits, ...rest }) => rest; // eslint-disable-line no-unused-vars

/** "Saturday Night" → "Saturday night", "Tonight" → "tonight". */
const when = (name) => name.replace(/ Night$/, " night").replace(/^(Tonight|This Afternoon|Today|Overnight)$/, (m) => m.toLowerCase());

const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Plain prose straight from the fact sheet. No model; cannot invent. */
export function templateReadout(facts) {
  if (facts.quiet) return { regions: [], ahead: null };
  return {
    regions: facts.regions.map((g) => {
      const [top, ...rest] = g.resorts;
      const parts = [];
      let lead = `${top.name} is forecast for about ${top.totalIn}"`;
      if (top.peak && top.peak.in >= top.totalIn * 0.5 && top.peak.in < top.totalIn) lead += `, ${top.peak.in}" of it ${top.peak.dow}`;
      else if (top.peak && top.peak.in >= top.totalIn) lead += `, all of it ${top.peak.dow}`;
      parts.push(`${lead}.`);
      if (rest.length) parts.push(`${andList(rest.map((r) => `${r.name} about ${r.totalIn}"`))}.`);

      /* NWS colour, from the top two resorts: heavy snow wherever it is
         called, rain only when it falls on the big day itself. */
      const said = (pick) => g.resorts.slice(0, 2).map((r) => ({ r, ps: (r.nws ?? []).filter(pick) })).find((x) => x.ps.length);
      const heavy = said((p) => /heavy snow/i.test(p.short));
      const peakDow = top.peak?.dow ?? "";
      const mixed = said((p) => /rain/i.test(p.short) && /snow/i.test(p.short) && p.name.startsWith(peakDow) && peakDow);
      if (heavy) parts.push(`The National Weather Service has heavy snow at ${heavy.r.name} ${andList(heavy.ps.map((p) => when(p.name)))}.`);
      else if (mixed) parts.push(`The National Weather Service has rain mixed in at ${mixed.r.name} ${andList(mixed.ps.map((p) => when(p.name)))}.`);
      if (top.alerts?.length) parts.push(`${andList([...new Set(top.alerts)])} in effect at ${top.name}.`);
      return { key: g.key, text: parts.join(" ") };
    }),
    ahead: null, // summarising forecasters' prose needs a model
  };
}

const numbersIn = (s) =>
  (String(s).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ""))));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every reason a writer's output may not ship. Empty means it may. */
export function validateReadout(out, facts) {
  const problems = [];
  if (!out || !Array.isArray(out.regions)) return ["output has no regions array"];

  const want = facts.regions.map((g) => g.key);
  const got = out.regions.map((r) => r?.key);
  if (want.join("|") !== got.join("|")) problems.push(`regions must be exactly [${want.join(", ")}] in that order, got [${got.join(", ")}]`);

  const allowedNumbers = new Set(numbersIn(JSON.stringify(factsForWriter(facts))));
  const check = (label, text, max) => {
    if (typeof text !== "string" || !text.trim()) { problems.push(`${label}: empty`); return; }
    if (text.length > max) problems.push(`${label}: ${text.length} chars, limit ${max}`);
    for (const n of numbersIn(text)) {
      if (!allowedNumbers.has(n)) problems.push(`${label}: the number ${n} is not in the fact sheet`);
    }
    for (const place of facts.offLimits ?? []) {
      if (new RegExp(`\\b${escape(place)}\\b`, "i").test(text)) problems.push(`${label}: names ${place}, which is not in the read-out's regions`);
    }
  };
  out.regions.forEach((r, i) => check(`region ${i + 1} (${r?.key})`, r?.text, REGION_TEXT_MAX));

  if (out.ahead != null) {
    if (!facts.ahead?.length) problems.push("ahead: written with no fresh discussion to draw on");
    else check("ahead", out.ahead, AHEAD_TEXT_MAX);
  }
  return problems;
}

/** Only show a read-out written from the forecast on screen. A run that
 *  failed after the scrape leaves the old file behind; this hides it rather
 *  than letting it contradict the radar above. */
export const readoutMatches = (editorial, generatedAt) =>
  !!editorial && !editorial.quiet && !!editorial.regions?.length &&
  !!generatedAt && editorial.forecastGeneratedAt === generatedAt;

/** Behind a flag while Brian looks at it: ?readout=1 turns it on in this
 *  browser, ?readout=0 off. Same idea as the resort-sheet copy flag. */
export function readoutOn() {
  try {
    const q = new URLSearchParams(window.location.search).get("readout");
    if (q === "1" || q === "0") window.localStorage.setItem("tabulator.readout", q);
    return window.localStorage.getItem("tabulator.readout") === "1";
  } catch {
    return false;
  }
}
