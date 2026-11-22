/* Long-range odds on the resort sheet (Brian, 2026-11-22): past the last day we show in inches, the calibrated chance of
   a big storm instead of a number. Data: public/longrange.json (scripts/longrange/build.py). Only the leads that beat
   climatology on held-out winters are in it (scripts/model/promote_longrange.py); a window with no promoted lead has no
   entry, and nothing is ever filled from the raw ensemble.
   Hidden — not zero, not stale — when the file is missing, older than MAX_AGE_H, has nothing for this resort, or has
   nothing past the sheet's last day. */
import { windowLabel } from "./terrainField.js";

export const MAX_AGE_H = 36;
export const LAST_ODDS_DAY = 14;
const DAY = 864e5;
const t = (s) => Date.parse(`${s}T12:00:00Z`);
const addDays = (s, n) => new Date(t(s) + n * DAY).toISOString().slice(0, 10);
export const dayNumber = (first, date) => Math.round((t(date) - t(first)) / DAY) + 1;

/** { rows, dayRange, note } for one resort, or null.
 *  `days` is the sheet's own date list (forecast then projected); the odds start the day after its last. */
export function oddsFor(lr, resortId, days, now = Date.now()) {
  if (!lr?.resorts || !days?.length) return null;
  const gen = Date.parse(lr.generatedAt ?? "");
  if (!Number.isFinite(gen) || now - gen > MAX_AGE_H * 3600e3) return null;
  const ws = lr.resorts[resortId]?.windows;
  if (!ws?.length) return null;
  const first = days[0], last = days[days.length - 1];
  const rows = ws
    .map((w) => ({ start: addDays(w.end, -2), end: w.end, p: w.p }))
    .filter((w) => Number.isFinite(w.p) && w.p >= 0 && w.p <= 1 && w.start > last && dayNumber(first, w.end) <= LAST_ODDS_DAY)
    .sort((a, b) => (a.end < b.end ? -1 : 1))
    .map((w) => ({
      label: windowLabel([w.start, w.end]),
      pct: Math.round(w.p * 100),
      steps: Math.round(w.p * 5),
      start: w.start, end: w.end,
    }));
  if (!rows.length) return null;
  const a = rows[0], b = rows[rows.length - 1];
  return {
    rows,
    from: dayNumber(first, a.start), to: dayNumber(first, b.end),
    dates: windowLabel([a.start, b.end]),
    winters: lr.calibration?.winters?.length ?? null,
  };
}
