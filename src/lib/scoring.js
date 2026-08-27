import { rank } from "./rank.js";
import {
  HISTORY_DAYS,
  COLD_RED, COLD_AMBER_LO, COLD_AMBER_HI,
  WARM_AMBER_LO, WARM_AMBER_HI, WARM_RED,
  WIND_AMBER, WIND_RED,
} from "./constants.js";

/** The three days before the window, summed from our own archive of
 *  Snow-Forecast's day-0 nowcast (public/history.json).
 *
 *  Returns null — never 0 — when the archive doesn't reach back far enough.
 *  A missing base and a bare mountain look identical as a number and are
 *  opposite as a decision, so the UI must be able to tell them apart. */
export function before(history, resortId, startDate, days = HISTORY_DAYS) {
  if (!history || !startDate) return null;
  const start = new Date(`${startDate}T12:00:00Z`);
  let sum = 0;
  let found = 0;
  for (let i = 1; i <= days; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i);
    const v = history[d.toISOString().slice(0, 10)]?.[resortId];
    if (typeof v === "number") { sum += v; found++; }
  }
  return found === days ? Number(sum.toFixed(2)) : null;
}

/** Scores one resort against a window of forecast days. All units metric,
 *  matching forecast.json. */
export function score(resort, a, b, history) {
  const win = resort.days.slice(a, b + 1);
  const nums = (arr) => arr.filter((x) => typeof x === "number" && Number.isFinite(x));

  const tempMax = nums(win.map((d) => d.tempMax));
  const tempMin = nums(win.map((d) => d.tempMin));
  const windMax = nums(win.map((d) => d.windMax));
  const freeze = nums(win.map((d) => d.freezeMin));

  let cum = 0;
  const out = {
    ...resort,
    win,
    cumulative: win.map((d) => (cum += d.snow ?? 0)),
    before: before(history, resort.id, win[0]?.date),
    total: Number(win.reduce((s, d) => s + (d.snow ?? 0), 0).toFixed(2)),
    hi: tempMax.length ? Math.max(...tempMax) : null,
    lo: tempMin.length ? Math.min(...tempMin) : null,
    wind: windMax.length ? Math.max(...windMax) : null,
    freezeMin: freeze.length ? Math.min(...freeze) : null,
  };
  /* Attached here rather than at the sort, so the table, the verdict and
     anything added later cannot disagree about which resort is best. */
  return { ...out, rank: rank(out) };
}

/** Severity of the temperature reading, worst-first.
 *
 *  Temperature is bad in two directions and shares one column, so the marker
 *  answers "is temperature a problem, and how much" rather than naming which
 *  direction — the number in the cell tells you that. Cold is judged on the
 *  window's minimum, warm on its maximum; whichever is worse wins. */
export function tempSeverity(hi, lo) {
  if (lo != null && lo <= COLD_RED) return "red";
  if (hi != null && hi > WARM_RED) return "red";
  if (lo != null && lo >= COLD_AMBER_LO && lo <= COLD_AMBER_HI) return "amber";
  if (hi != null && hi >= WARM_AMBER_LO && hi <= WARM_AMBER_HI) return "amber";
  return null;
}

/** Wind is bad in one direction only, so this is a simple ladder. */
export function windSeverity(w) {
  if (w == null) return null;
  if (w >= WIND_RED) return "red";
  if (w >= WIND_AMBER) return "amber";
  return null;
}

/** Absent data raises nothing — a partial scrape must not mark every resort
 *  dangerous. Both helpers return null rather than a severity for null input. */
export const flags = (r) => ({
  temp: tempSeverity(r.hi, r.lo),
  wind: windSeverity(r.wind),
});

/** Snow-Forecast gives freezing level per period, so rain-vs-snow can be read
 *  rather than inferred from temperature. True when the freezing level sits
 *  above the mid station for the whole window — precipitation arrives as rain. */
export const rainRisk = (r) =>
  r.freezeMin != null && r.elevation?.mid != null && r.freezeMin > r.elevation.mid;
