import { WIND_LIMIT, WARM_LIMIT, COLD_LIMIT } from "./constants.js";

/** Everything recomputes against the chosen window. `before` is the snow that
 *  fell in the three days prior — the base you'd be landing on. 20" on rock is
 *  not 20" on 20". */
export function score(resort, a, b) {
  const win = resort.all.slice(a, b + 1);
  const prior = resort.all.slice(Math.max(0, a - 3), a);
  let cum = 0;
  return {
    ...resort,
    win,
    cumulative: win.map((x) => (cum += x.snow)),
    before: prior.reduce((s, x) => s + x.snow, 0),
    total: win.reduce((s, x) => s + x.snow, 0),
    hi: Math.max(...win.map((x) => x.hi)),
    lo: Math.min(...win.map((x) => x.lo)),
    wind: Math.max(0, ...win.map((x) => x.wind ?? 0)),
  };
}

export const flags = (r) => ({
  wind: r.wind >= WIND_LIMIT,
  warm: r.hi >= WARM_LIMIT,
  cold: r.lo <= COLD_LIMIT,
});
