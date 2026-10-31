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
const DETAIL_CHARS = 200;
export const REGION_TEXT_MAX = 320; // about 50 words; the prompt asks for 40
export const AHEAD_TEXT_MAX = 320;

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-05" → "Thursday Nov 5". */
export const dateLabel = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** "Saturday Night" → "Saturday night", "Tonight" → "tonight". */
const when = (name) => String(name).replace(/ Night$/, " night").replace(/^(Tonight|This Afternoon|Today|Overnight)$/, (m) => m.toLowerCase());
const dowOf = (date) => DOW[new Date(`${date}T12:00:00Z`).getUTCDay()];
const inch = (cm) => Math.round(cmToIn(cm));
const WET = /snow|rain|sleet|flurr|freezing|mix|storm|shower/i;

/** The NWS periods worth quoting for one resort: wet ones, inside the window. */
const inWindow = (wx, from, to) => (wx?.periods ?? []).filter((p) => {
  const d = String(p.startTime ?? "").slice(0, 10);
  return d >= from && d <= to;
});

/* NWS inch figures never reach the writer as loose text: they sat beside our
   totals in the first live read-out (2026-10-30) and made it contradict
   itself — "6\" total" next to "8 to 12 inches possible overnight". They go
   in only through `nwsHigher`, below, which code works out. */
const ACCUM = /[^.]*\b(accumulation|inches|inch)\b[^.]*\.\s*/gi;

/** A period's name as a day: "Tonight" is only true until morning, and the
 *  read-out is read for a day or more. "Tonight" → "Friday night". */
function periodName(p) {
  if (!/^(Tonight|This Afternoon|Today|Overnight|This Morning)$/i.test(p.name ?? "")) return p.name;
  const day = DOW[new Date(`${String(p.startTime).slice(0, 10)}T12:00:00Z`).getUTCDay()];
  return /night|overnight/i.test(p.name) ? `${day} Night` : day;
}

/** The useful part of the NWS sentence: its first clause, plus anything on
 *  snow level, wind or heavy snow. Drops the hour-by-hour chance-of lists. */
function detailOf(text) {
  const sentences = String(text ?? "").replace(ACCUM, "").split(/(?<=\.)\s+/).filter(Boolean);
  const keep = sentences.filter((x, i) => i === 0 || /snow level|gust|heavy|blowing|wind chill/i.test(x));
  return keep.join(" ").replace(/ between \d.*$/, ".").trim().slice(0, DETAIL_CHARS);
}

function nwsFor(wx, from, to) {
  return inWindow(wx, from, to)
    .filter((p) => WET.test(p.shortForecast ?? "") || /accumulation/i.test(p.detailedForecast ?? ""))
    .slice(0, MAX_PERIODS)
    .map((p) => {
      const detail = detailOf(p.detailedForecast);
      return { name: periodName(p), short: p.shortForecast, ...(detail ? { detail } : {}), tempF: p.temperature };
    });
}

const WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, half: 0.5, "a half": 0.5 };
/** "New snow accumulation of 8 to 12 inches possible" → [8, 12];
 *  "around 2 inches" → [2, 2]; "less than one inch" → [0, 1]. */
export function accumulation(text) {
  const t = String(text ?? "");
  if (!/snow accumulation/i.test(t)) return null;
  let m = t.match(/accumulation of (\d+) to (\d+) inch/i);
  if (m) return [Number(m[1]), Number(m[2])];
  m = t.match(/accumulation of around (\d+|one|two|three|four|five) inch/i);
  if (m) { const n = Number(m[1]) || WORD_N[m[1].toLowerCase()]; return [n, n]; }
  m = t.match(/accumulation of less than (\d+|one|two|half|a half)\b/i);
  if (m) return [0, Number(m[1]) || WORD_N[m[1].toLowerCase()]];
  return null;
}

/** Where the NWS calls for clearly more than our table: its summed range
 *  over the window, and the period that carries most of it. Brian,
 *  2026-10-30: the read-out says so, once. */
export const NWS_HIGHER_BY_IN = 3;
export const NWS_HIGHER_RATIO = 1.5;
function nwsHigher(wx, from, to, totalIn) {
  const amounts = inWindow(wx, from, to)
    .map((p) => ({ name: periodName(p), a: accumulation(p.detailedForecast) }))
    .filter((x) => x.a);
  if (!amounts.length) return null;
  const lo = Math.round(amounts.reduce((s, x) => s + x.a[0], 0));
  const hi = Math.round(amounts.reduce((s, x) => s + x.a[1], 0));
  if (hi < totalIn + NWS_HIGHER_BY_IN || hi < totalIn * NWS_HIGHER_RATIO) return null;
  const big = amounts.reduce((a, b) => (b.a[1] > a.a[1] ? b : a));
  const wet = amounts.filter((x) => x.a[1] >= 1).map((x) => x.name);
  return {
    fromIn: lo, toIn: hi,
    over: wet.length > 1 ? `${when(wet[0])} through ${when(wet[wet.length - 1])}` : when(wet[0] ?? big.name),
  };
}

/** An alert's span as day names: "Saturday to Sunday night". */
function alertSpan(a) {
  const day = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    const h = Number(String(iso).slice(11, 13));
    const name = DOW[new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).getUTCDay()];
    return Number.isFinite(h) && h >= 18 ? `${name} night` : (Number.isFinite(d.getTime()) ? name : null);
  };
  const from = day(a.onset), to = day(a.ends);
  return { event: a.event, ...(from ? { from } : {}), ...(to && to !== from ? { to } : {}) };
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
  if (window.to) window.toLabel = dateLabel(window.to);
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
          ...(j < NWS_RESORTS && wx ? (() => {
            const higher = nwsHigher(wx, window.from, window.to, inch(r.total));
            return {
              nws: nwsFor(wx, window.from, window.to),
              ...(higher ? { nwsHigher: higher } : {}),
              ...(wx.alerts?.length ? { alerts: wx.alerts.map(alertSpan) } : {}),
            };
          })() : {}),
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

  /* The look-ahead may only talk about these days. Spelled out so the writer
     can turn a forecaster's "Friday" into a date, and so the check knows
     which dates are fair. */
  const afterWindow = window.to && ahead.length
    ? Array.from({ length: 9 }, (_, i) => {
      const d = new Date(`${window.to}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i + 1);
      const iso = d.toISOString().slice(0, 10);
      return { date: iso, label: dateLabel(iso) };
    })
    : [];

  return { generatedAt, window, quiet: false, regions, ahead, afterWindow, offLimits };
}

/** The fact sheet as the model sees it: without the validator's own list. */
export const factsForWriter = ({ offLimits, ...rest }) => rest; // eslint-disable-line no-unused-vars

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
      const hi = g.resorts.slice(0, 2).find((r) => r.nwsHigher);
      if (hi) parts.push(`The NWS is calling for more at ${hi.name}: ${hi.nwsHigher.fromIn} to ${hi.nwsHigher.toIn}" ${hi.nwsHigher.over}.`);
      const alert = top.alerts?.[0];
      if (alert) parts.push(`${alert.event} at ${top.name}${alert.from ? ` from ${alert.from}${alert.to ? ` to ${alert.to}` : ""}` : ""}.`);
      return { key: g.key, text: parts.join(" ") };
    }),
    ahead: null, // summarising forecasters' prose needs a model
  };
}

const numbersIn = (s) =>
  (String(s).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => String(Number(n.replace(/,/g, ""))));
const META = /\b(fact sheet|the data provided|provided (data|discussions?|sources?)|discussions? provided|not (in|included in) the|no (fresh |recent )?discussions?|JSON|the input)\b/i;
const RELATIVE = /\b(today|tonight|tomorrow|this weekend|this week|early next week|next few days)\b/i;
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/gi;
/** "Nov 7", "November 7" → ISO dates, in the year that keeps them nearest the window. */
function datesIn(text, ref) {
  const y = Number(String(ref).slice(0, 4));
  const refMonth = Number(String(ref).slice(5, 7));
  return [...String(text).matchAll(MONTH_RE)].map((m) => {
    const mon = MONTHS.indexOf(m[1].slice(0, 3)[0].toUpperCase() + m[1].slice(1, 3).toLowerCase()) + 1;
    const year = refMonth === 12 && mon === 1 ? y + 1 : y;
    return `${year}-${String(mon).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  });
}
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
    if (META.test(text)) problems.push(`${label}: talks about its own inputs ("${text.match(META)[0]}") — readers never see the fact sheet`);
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
    else {
      check("ahead", out.ahead, AHEAD_TEXT_MAX);
      /* Brian's rule 5: past the radar's window, never inside it. It must
         name at least one date, and every date it names must be after. */
      if (RELATIVE.test(out.ahead)) problems.push(`ahead: "${out.ahead.match(RELATIVE)[0]}" is inside the radar's window — name a date after ${facts.window.toLabel}`);
      const dates = datesIn(out.ahead, facts.window.to);
      if (!dates.length) problems.push(`ahead: names no date — say when, after ${facts.window.toLabel}`);
      for (const d of dates) if (d <= facts.window.to) problems.push(`ahead: ${d} is inside the radar's window (to ${facts.window.to})`);
    }
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
