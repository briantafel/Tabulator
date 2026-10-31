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
