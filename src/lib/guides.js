/* Value guides for the resort sheet's range chart.
 *
 * The chart scales so the tallest bar reaches the top of the plot, so the
 * guide step has to follow the week. A fixed 6" step left any week under
 * ~5" with no guides at all (Brian, 2026-11-10: "no frame of reference").
 *
 * Pick the smallest "nice" step that gives at most MAX guides up to `limit`
 * (the highest value that still sits inside the plot). Big weeks keep the
 * spec's 6/12/18 and 10/20/30; small weeks get 0.5/1 or 1/2/3.
 */
const STEPS_IN = [0.5, 1, 2, 3, 6, 10, 20, 30, 50, 100];
const STEPS_CM = [1, 2, 5, 10, 15, 25, 50, 100, 250];
const MAX = 3;

export function guideValues(limit, metric = false) {
  if (!(limit > 0)) return [];
  const steps = metric ? STEPS_CM : STEPS_IN;
  const step = steps.find((s) => Math.floor(limit / s + 1e-9) <= MAX) ?? steps[steps.length - 1];
  const out = [];
  // k * step, not repeated addition, so 0.5 steps don't drift.
  for (let k = 1; k * step <= limit + 1e-9; k++) out.push(Math.round(k * step * 10) / 10);
  return out;
}
