import { WIND_LIMIT, WARM_LIMIT, COLD_LIMIT, HISTORY_DAYS } from "./constants.js";

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
  return {
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
}

/** Warning flags. A null metric raises nothing — absence of data is not a
 *  warning, and pretending otherwise would put dots on every resort during a
 *  partial scrape. */
export const flags = (r) => ({
  wind: r.wind != null && r.wind >= WIND_LIMIT,
  warm: r.hi != null && r.hi >= WARM_LIMIT,
  cold: r.lo != null && r.lo <= COLD_LIMIT,
});

/** Snow-Forecast gives freezing level per period, so rain-vs-snow can be read
 *  rather than inferred from temperature. True when the freezing level sits
 *  above the mid station for the whole window — precipitation arrives as rain. */
export const rainRisk = (r) =>
  r.freezeMin != null && r.elevation?.mid != null && r.freezeMin > r.elevation.mid;
