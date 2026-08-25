/* First-hand skier reports.
 *
 * Same shape as the forecast: a scheduled scrape writes reports.json, the
 * browser only ever reads a static file. OnTheSnow blocks cross-origin
 * requests exactly like Snow-Forecast does, so a live fetch from the page
 * was never on the table. See docs/SCRAPING.md.
 *
 * Photos are inlined as data URIs rather than left as remote <img> src.
 * A report card whose photo 404s six months from now is worse than no card,
 * and the published snapshot has to run with no network at all. */

/** Reports older than this are not "conditions", they are history. */
export const REPORT_DAYS = 5;

const ms = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime();

/* OnTheSnow prints "4 months ago", not a date. That is all the page gives, so
   it is what the scrape can carry — and it is enough for a five-day window,
   because every unit above "day" is already outside it. Deliberately coarse:
   this decides whether a report is shown, never what it says. */
const UNIT = {
  minute: 6e4, hour: 36e5, day: 864e5,
  week: 6048e5, month: 2592e6, year: 31536e6,
};
export function ageMs(age) {
  const m = /^\s*(?:(a|an|\d+)\s+)?(minute|hour|day|week|month|year)s?\s+ago\s*$/i
    .exec(String(age ?? ""));
  if (!m) return null;
  const n = !m[1] || /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  return n * UNIT[m[2].toLowerCase()];
}

/** When a report has a real date, use it. Otherwise fall back to the relative
 *  age, resolved against `now`. Never guesses: no date and no age means no
 *  position in time, and the report is dropped from a windowed feed. */
function whenMs(r, now) {
  const exact = ms(r.at);
  if (Number.isFinite(exact)) return exact;
  const age = ageMs(r.age);
  return age == null ? null : now.getTime() - age;
}

/** Reports for one resort, newest first, inside the REPORT_DAYS window.
 *
 *  Sample data is exempt from the window on purpose: the fixture carries the
 *  real April reports Brian pulled from OnTheSnow, and silently filtering them
 *  to an empty list would look like a broken feature rather than like sample
 *  data. Real feeds are always filtered. */
export function reportsFor(feed, resortId, now = new Date(), days = REPORT_DAYS) {
  const all = feed?.resorts?.[resortId];
  if (!Array.isArray(all) || !all.length) return [];
  const at = new Map(all.map((r) => [r, whenMs(r, now)]));
  const sorted = [...all].sort((a, b) => (at.get(b) ?? -Infinity) - (at.get(a) ?? -Infinity));
  /* Two different reasons to skip the window, kept distinct on purpose.
     `synthetic` means the data is invented — filtering it would leave an
     empty section that reads as a broken feature rather than as sample data.
     `demo` means the data is REAL but deliberately shown outside its window:
     the shipped fixture is a genuine April harvest, and in August every
     report is months old. Marking real reports "synthetic" to get the same
     effect would be a lie about where they came from. */
  if (feed.synthetic || feed.demo) return sorted;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return sorted.filter((r) => at.get(r) != null && at.get(r) >= cutoff);
}

/** "Apr 24" — the label OnTheSnow itself uses on the card.
 *
 *  Falls back to the relative age when there is no date to format. Showing
 *  "4 months ago" is what the source page shows; inventing "Apr 24" from a
 *  month-granularity age would be a fabricated date on a real person's report. */
export function reportDate(at, age) {
  const d = new Date(`${String(at).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(+d)) return age ? String(age) : "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
