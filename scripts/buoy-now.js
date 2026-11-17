/* ------------------------------------------------------------------ *
 * The Powder Buoy line in the radar read-out (Brian, 2026-11-17: put an
 * experimental Wasatch line in the editorial, no switch).
 *
 * Reads the last 45 days of NOAA NDBC realtime data for buoys 51001 and
 * 51101, finds "pops" with exactly the study's definition (PRIMARY in
 * scripts/research/buoy-stats.js), and when a pop's 11–17-day window has
 * not yet passed, writes one plain sentence. The sentence is a template,
 * never a model, and it states the evidence as it stands
 * (claude/buoy-study.md): promising, not proven. The live pre-registered
 * test (LIVE_TEST) decides later whether it stays.
 *
 * Failures are loud but never block the read-out: an unreachable buoy is a
 * warning and no line (missing is not "no pop").
 * ------------------------------------------------------------------ */

import { parseNdbc, dailyMax, findPops, addDays, PRIMARY } from "./research/buoy-stats.js";

export const BUOYS = ["51001", "51101"];
const URL_OF = (id) => `https://www.ndbc.noaa.gov/data/realtime2/${id}.txt`;
const UA = "Tabulator/1.0 (personal ski-forecast research; github.com/briantafel/Tabulator)";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const md = (ymd) => `${MON[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
/** "Nov 23–29", or "Nov 28–Dec 4" across a month end. */
export function span(a, b) {
  return a.slice(5, 7) === b.slice(5, 7) ? `${md(a)}–${Number(b.slice(8, 10))}` : `${md(a)}–${md(b)}`;
}

/** Pops (per buoy) whose storm window has not ended by `today` (YYYY-MM-DD). */
export function activePops(dailyByBuoy, today) {
  const out = [];
  for (const [buoy, daily] of Object.entries(dailyByBuoy)) {
    for (const d of findPops(daily, PRIMARY)) {
      if (addDays(d, PRIMARY.to) >= today && d <= today) out.push({ buoy, date: d });
    }
  }
  return out.sort((x, y) => (x.date < y.date ? 1 : -1));
}

/** The sentence for the newest active pop, or null. */
export function buoyText(pops) {
  if (!pops.length) return null;
  const date = pops[0].date;
  const same = pops.filter((p) => Math.abs(Date.parse(p.date) - Date.parse(date)) <= 3 * 864e5);
  const ids = [...new Set(same.map((p) => p.buoy))].sort();
  const who = ids.length > 1 ? `Buoys ${ids.join(" and ")} near Hawaii` : `Buoy ${ids[0]} near Hawaii`;
  const from = addDays(date, PRIMARY.from), to = addDays(date, PRIMARY.to);
  return `${who} popped ${md(date)}, the swell signal Powder Buoy watches for a Wasatch storm about two weeks later — here ${span(from, to)}. ` +
    "In past winters a pop raised the chance of a Wasatch storm in that window by roughly 6 to 12 points. Experimental: promising, not proven.";
}

/** Fetch both buoys and build the editorial's `buoy` block. Throws only on a bug, never on the network. */
export async function buoyNow({ now = new Date(), fetchImpl = fetch } = {}) {
  const today = now.toISOString().slice(0, 10);
  const daily = {}, failed = [];
  for (const id of BUOYS) {
    try {
      const res = await fetchImpl(URL_OF(id), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = dailyMax(parseNdbc(await res.text()));
      if (d.size < 10) throw new Error(`only ${d.size} days in the realtime file`);
      daily[id] = d;
    } catch (e) {
      failed.push(`${id}: ${e.message}`);
    }
  }
  if (!Object.keys(daily).length) return { block: null, warning: `buoy line skipped — no buoy data (${failed.join("; ")})` };
  const pops = activePops(daily, today);
  const text = buoyText(pops);
  return {
    block: text ? { text, pops, link: "https://powderbuoy.com", experimental: true } : null,
    warning: failed.length ? `buoy data missing for ${failed.join("; ")} — line built from the other buoy` : null,
  };
}
