/* Dates are handled as bare YYYY-MM-DD strings, anchored at midday so that
 * timezone offsets can't shunt a day across a boundary. */

export const iso = (d) => d.toISOString().slice(0, 10);
export const fromIso = (s) => new Date(s + "T12:00:00");

export const monthName = (d) => d.toLocaleDateString(undefined, { month: "long" });

export const shortDate = (s) =>
  fromIso(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const weekdayShort = (s) =>
  fromIso(s).toLocaleDateString(undefined, { weekday: "short" });

/** Blank cells before the 1st in a month grid. Weeks run Sunday to Saturday —
 *  Brian, 2026-10-31: "the weeks begin with Sunday and end with Saturday".
 *  Both calendars (mountains and the trip editor) take it from here so they
 *  cannot disagree. */
export const leadingBlanks = (firstOfMonth) => firstOfMonth.getDay();

/** Today's date in the phone's own time zone, as YYYY-MM-DD — the key format
 *  history.json uses. toISOString() would give tomorrow's date to anyone west
 *  of UTC in the evening. */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "Dec 20" or "Dec 20–Dec 27": how a range is written everywhere. */
export const rangeLabel = (a, b) => (!b || a === b ? shortDate(a) : `${shortDate(a)}–${shortDate(b)}`);

/** The `n` days before `today` as "Nov 18–20" — what the "-3 days" number covers. */
export function priorSpan(today, n = 3) {
  const t = new Date(`${today}T12:00:00Z`);
  const f = (k) => { const d = new Date(t); d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); };
  return rangeLabel(f(n), f(1));
}
