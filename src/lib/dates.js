/* Dates are handled as bare YYYY-MM-DD strings, anchored at midday so that
 * timezone offsets can't shunt a day across a boundary. */

export const iso = (d) => d.toISOString().slice(0, 10);
export const fromIso = (s) => new Date(s + "T12:00:00");

export const monthName = (d) => d.toLocaleDateString(undefined, { month: "long" });

export const shortDate = (s) =>
  fromIso(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export const weekdayShort = (s) =>
  fromIso(s).toLocaleDateString(undefined, { weekday: "short" });
