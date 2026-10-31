/* Forecaster discussions for the read-out's "Looking ahead" line.
 *
 * Brian's rule (2026-10-30): editorial that is not current only talks about
 * storms beyond the radar's window. So this keeps only the forward-looking
 * parts — an AFD's long-term section and key messages, WPC's extended
 * discussion, CPC's 6–10 / 8–14 day discussion — and drops anything older
 * than FRESH_HOURS. A stale discussion is not shown at all.
 *
 * Sources are all US government work (public domain):
 *   AFD  api.weather.gov/products/types/AFD/locations/{office} → /products/{id}
 *   WPC  wpc.ncep.noaa.gov  …/hpcdiscussions.php?disc=pmdepd  (<pre> text)
 *   CPC  cpc.ncep.noaa.gov  …/610day/fxus06.html              (<pre> text)
 *
 * The parsers are exported for the tests; nothing here can reach NOAA from
 * the sandbox, so the fetch half is only ever exercised in the Action.
 */

import { load } from "cheerio";

export const FRESH_HOURS = 26; // twice-daily runs, plus GitHub's lateness
const API = "https://api.weather.gov";
const UA = "Tabulator/1.0 (personal ski-trip planner; github.com/briantafel/Tabulator)";
export const WPC_URL = "https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=pmdepd";
export const CPC_URL = "https://www.cpc.ncep.noaa.gov/products/predictions/610day/fxus06.html";
const AFD_CHARS = 1800;
const WPC_CHARS = 3000;
const CPC_CHARS = 2500;

const TZ = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10, UTC: 0, GMT: 0 };
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** The issuance line every NWS text product carries:
 *  "300 PM EST Thu January 08 2026", "1055 PM MDT Wed Oct 28 2026",
 *  and CPC's "3:00 PM EDT Fri October 30 2026".
 *  Returns an ISO string, or null when there is no such line. */
export function issuedAt(text) {
  // "300 PM" in most products; CPC writes "3:00 PM" (first live run, 2026-10-30).
  const m = String(text).match(/^\s*(\d{1,2}:\d{2}|\d{1,4})\s+(AM|PM)\s+([A-Z]{3,4})\s+[A-Za-z]{3}\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s*$/m);
  if (!m) return null;
  const [, rawHm, ap, tz, mon, day, year] = m;
  const hm = rawHm.replace(":", "");
  const off = TZ[tz.toUpperCase()];
  const month = MON[mon.slice(0, 3).toUpperCase()];
  if (off == null || month == null) return null;
  const n = Number(hm);
  let h = Math.floor(n / 100) % 12;
  if (ap.toUpperCase() === "PM") h += 12;
  const min = n % 100;
  return new Date(Date.UTC(Number(year), month, Number(day), h - off, min)).toISOString();
}

/** CPC's page also prints "Issued: Oct 30, 2026" above the text. Its
 *  discussions go out at 3 PM Eastern; that is close enough for a 26-hour
 *  freshness test when the full issuance line cannot be read. */
export function issuedDateLine(text) {
  const m = String(text).match(/Issued:\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MON[m[1].slice(0, 3).toUpperCase()];
  if (month == null) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[2]), 20, 0)).toISOString();
}

export const isFresh = (iso, now = new Date()) =>
  !!iso && now - new Date(iso) >= -3600e3 && now - new Date(iso) <= FRESH_HOURS * 3600e3;

/** The forward-looking sections of an Area Forecast Discussion. Sections
 *  open with ".NAME..." and close with "&&". */
export function afdAhead(text) {
  const keep = /^\.(LONG TERM|KEY MESSAGES|EXTENDED)/i;
  const out = [];
  let on = false;
  for (const line of String(text).split("\n")) {
    if (/^\.[A-Z]/.test(line)) on = keep.test(line);
    if (/^&&/.test(line)) on = false;
    if (on) out.push(line);
  }
  return squash(out.join("\n")).slice(0, AFD_CHARS);
}

const squash = (s) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
/* The discussion's own text: every <pre> on the page, or the whole page if
   it has none — the first live run could not find CPC's issuance line in
   the first <pre> alone. */
const pageText = (html) => {
  const $ = load(html);
  const pres = $("pre").map((_, el) => $(el).text()).get().join("\n");
  return pres.trim() ? pres : $("body").text();
};

export function wpcAhead(html) {
  const text = pageText(html);
  return { issuedAt: issuedAt(text), excerpt: squash(text).slice(0, WPC_CHARS), head: squash(text).slice(0, 160) };
}

export function cpcAhead(html) {
  const text = pageText(html);
  const start = text.search(/Prognostic Discussion|6-10 DAY OUTLOOK/i);
  const body = text.slice(Math.max(0, start)).split(/\bFORECASTER\b/)[0];
  return { issuedAt: issuedAt(text) ?? issuedDateLine(text), excerpt: squash(body).slice(0, CPC_CHARS), head: squash(text).slice(0, 160) };
}

async function get(url, accept) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return accept.includes("json") ? res.json() : res.text();
}

/** Fetch every fresh discussion for these offices, plus WPC and CPC.
 *  Never throws: a source that fails or is stale is logged and left out. */
export async function gatherAhead(offices, { now = new Date(), log = console.error } = {}) {
  const out = [];
  const add = (item) => {
    if (!item.excerpt) return log(`ahead: ${item.source} — nothing forward-looking in it, skipped`);
    if (!item.issuedAt) return log(`ahead: ${item.source} — could not read when it was issued, skipped. Page starts: ${JSON.stringify(item.head ?? item.excerpt.slice(0, 160))}`);
    if (!isFresh(item.issuedAt, now)) return log(`ahead: ${item.source} issued ${item.issuedAt} — older than ${FRESH_HOURS}h, skipped`);
    const { head, ...keep } = item; // eslint-disable-line no-unused-vars
    out.push(keep);
  };
  for (const office of offices) {
    try {
      const list = await get(`${API}/products/types/AFD/locations/${office}`, "application/ld+json");
      const id = (list?.["@graph"] ?? [])[0]?.id;
      if (!id) throw new Error("no AFD listed");
      const p = await get(`${API}/products/${id}`, "application/ld+json");
      add({ source: `NWS ${office} Area Forecast Discussion`, issuedAt: p.issuanceTime, url: `https://forecast.weather.gov/product.php?site=${office}&issuedby=${office}&product=AFD`, excerpt: afdAhead(p.productText) });
    } catch (e) { log(`ahead: NWS ${office} failed — ${e.message}`); }
  }
  for (const [source, url, parse] of [
    ["WPC Extended Forecast Discussion", WPC_URL, wpcAhead],
    ["CPC 6–10 and 8–14 Day Discussion", CPC_URL, cpcAhead],
  ]) {
    try { add({ source, url, ...parse(await get(url, "text/html")) }); }
    catch (e) { log(`ahead: ${source} failed — ${e.message}`); }
  }
  return out;
}
