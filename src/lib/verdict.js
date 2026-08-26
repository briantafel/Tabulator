/* The sentence at the top of a trip.
 *
 * Brian's design writes it with the computed parts in brackets:
 *
 *   Your best bet is looking like [resort name], with [snowfall inches] over
 *   [number of days]. Temps look [good, warm, cold etc], and winds are
 *   [calm, moderate, a little high]. Overall, this is the move right now.
 *
 * Returned as segments rather than a string so the view can colour the
 * computed clauses without parsing its own prose back apart. `hot` marks the
 * ones his mock draws in coral — note the day count is NOT one of them: it is
 * context, and four highlights in a sentence is already the limit.
 */

import { tempSeverity, windSeverity } from "./scoring.js";
import { snowWithUnit } from "./units.js";

/** Worst severity across a window — a single dicey day is worth saying. */
const worst = (days, fn) => {
  let out = null;
  for (const d of days) {
    const s = fn(d);
    if (s === "red") return "red";
    if (s === "amber") out = "amber";
  }
  return out;
};

/** Which way the temperature misbehaves matters: "warm" and "cold" are
 *  different trips, and calling both of them "dicey" would lose the point. */
export function tempWord(days) {
  const flagged = days.filter((d) => tempSeverity(d.tempMax, d.tempMin));
  if (!flagged.length) return "good";
  const warm = flagged.filter((d) => tempSeverity(d.tempMax, null)).length;
  const cold = flagged.length - warm;
  if (warm && !cold) return "warm";
  if (cold && !warm) return "cold";
  return "all over the place";
}

export function windWord(days) {
  const s = worst(days, (d) => windSeverity(d.windMax));
  return s === "red" ? "a little high" : s === "amber" ? "moderate" : "calm";
}

/** `rows` are scored resorts, already narrowed to this trip.
 *  Returns null when there is nothing to have an opinion about. */
export function tripVerdict(rows, metric) {
  const usable = rows.filter((r) => r?.win?.length);
  if (!usable.length) return null;

  const best = usable.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a));
  const days = best.win;

  return [
    { t: "Your best bet is looking like " },
    { t: best.name, hot: true },
    { t: ", with " },
    { t: snowWithUnit(best.total, metric), hot: true },
    { t: ` over ${days.length} days. ` },
    { t: `Temps look ${tempWord(days)}`, hot: true },
    { t: ", and " },
    { t: `winds are ${windWord(days)}`, hot: true },
    { t: ". Overall, this is the move right now." },
  ];
}
