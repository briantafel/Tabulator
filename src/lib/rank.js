/* How good a trip this resort is, all in — not just how deep it is.
 *
 * Brian, 2026-08-27: "Rather than relying on snowfall alone, I would like to
 * balance temperature, wind and snow. Two resorts with similar snowfalls but
 * better weather and higher -3 days snowfall should edge out the resort with
 * purely better snowfall and/or poor weather or low recent snowfall."
 *
 * Four terms out of 100, weighted in constants.js. Forecast snow is 70 of
 * them, so the other three settle close calls rather than overturning real
 * ones — which is what "similar snowfalls" asks for. Worked through:
 *
 *   22" in a gale at 38°F   →  51 + 0  + 0  + 0   =  51
 *   20" cold, calm, 8" base →  47 + 12 + 12 + 6   =  77   ← wins, correctly
 *    8" cold, calm, 8" base →  19 + 12 + 12 + 6   =  49   ← loses, correctly
 *
 * MISSING DATA IS NOT ZERO. `before()` returns null rather than 0 when the
 * archive does not reach back far enough, because a missing base and a bare
 * mountain look identical as a number and are opposite as a decision. Scoring
 * a null as zero would quietly punish every resort we happen to lack history
 * for. So an absent term is dropped and the remaining weights re-normalise —
 * a resort with no archive is ranked on what we do know about it.
 */

import {
  RANK_SNOW, RANK_BASE, RANK_TEMP, RANK_WIND, SNOW_FULL_RATE, BASE_FULL,
  VETO_WIND, VETO_COLD, VETO_WARM,
  COLD_RED, COLD_AMBER_HI, WARM_AMBER_LO, WARM_SPRING,
  WIND_AMBER, WIND_HOWLING,
} from "./constants.js";

/** The deal breakers, which sit outside the weighting entirely.
 *
 *  Brian: "winds over 45 mph would be a deal breaker entirely. Temps below
 *  -10º F and over 40º would also be a deal breaker."
 *
 *  A weight can always be outvoted by enough snow. That is the outcome he is
 *  ruling out, so these cannot be weights — no quantity of powder makes a
 *  mountain with its lifts on wind hold worth the flight. Returns the reason
 *  rather than a boolean, so the sentence can say which one it was instead of
 *  leaving a resort mysteriously last. */
export function vetoOf(r) {
  if (r.wind != null && r.wind > VETO_WIND) return "wind";
  if (r.lo != null && r.lo < VETO_COLD) return "cold";
  if (r.hi != null && r.hi > VETO_WARM) return "warm";
  return null;
}

/** 0 at `lo`, 1 at `hi`, clamped — the one shape every term is built from. */
const ramp = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

/** Temperature is bad in two directions and shares one score, so the worse
 *  direction wins. The break points are the marker bands: no penalty until a
 *  reading is dicey, total penalty once it is past what the sentence calls
 *  spring or frigid. */
export const tempScore = (hi, lo) => {
  const warm = hi == null ? 0 : ramp(hi, WARM_AMBER_LO, WARM_SPRING);
  const cold = lo == null ? 0 : 1 - ramp(lo, COLD_RED, COLD_AMBER_HI);
  return 1 - Math.max(warm, cold);
};

/** Wind is bad in one direction: free below the dicey line, nothing left by
 *  the time it is howling. */
export const windScore = (w) => (w == null ? null : 1 - ramp(w, WIND_AMBER, WIND_HOWLING));

/** The four terms, each as { got, max }, so the score can be explained rather
 *  than just asserted. An absent term is omitted entirely. */
export function rankParts(r) {
  const parts = {};
  // Judged against the window it fell in. A row with no window is assumed to
  // be the four-day default rather than scored against a single day, which
  // would saturate on almost anything.
  const days = r.win?.length || 4;
  parts.snow = { got: RANK_SNOW * ramp(r.total ?? 0, 0, SNOW_FULL_RATE * days), max: RANK_SNOW };
  if (r.before != null) parts.base = { got: RANK_BASE * ramp(r.before, 0, BASE_FULL), max: RANK_BASE };
  if (r.hi != null || r.lo != null) parts.temp = { got: RANK_TEMP * tempScore(r.hi, r.lo), max: RANK_TEMP };
  if (r.wind != null) parts.wind = { got: RANK_WIND * windScore(r.wind), max: RANK_WIND };
  return parts;
}

/** 0–100, or a flat 0 for anything vetoed.
 *
 *  Zero rather than a low score on purpose: a vetoed resort has to sit below
 *  every un-vetoed one no matter how deep it is, and scoring it on a curve
 *  would let a big enough number climb back over the line. rankParts() still
 *  reports the breakdown, so the reason it is at the bottom stays visible. */
export function rank(r) {
  if (vetoOf(r)) return 0;
  const parts = Object.values(rankParts(r));
  const got = parts.reduce((s, p) => s + p.got, 0);
  const max = parts.reduce((s, p) => s + p.max, 0);
  return max === 0 ? 0 : Number(((got / max) * 100).toFixed(2));
}

/** Deepest is still the tie-break: two identical scores should fall back to
 *  something stable and meaningful rather than to array order. It also gives
 *  the vetoed block, all sitting at zero, a sensible internal order. */
export const byRank = (x, y) => (y.rank - x.rank) || ((y.total ?? 0) - (x.total ?? 0));

/** The one place that decides which resort is "the pick".
 *
 *  Brian, 2026-08-27: "the resort in red is occasionally not the recommended
 *  resort using the weighted variables logic we developed."
 *
 *  It was picking the DEEPEST row. That was right when depth was the ranking;
 *  since the balance landed they are different rows, and the table was
 *  colouring one resort while the sentence recommended another.
 *
 *  Fixing the comparator alone would have left two copies of the same
 *  judgement in two files, free to drift apart again the next time one of
 *  them changes. So there is now exactly one: the table and the verdict both
 *  call this. Returns null for an empty list.
 *
 *  A vetoed resort is never the pick unless everything is vetoed, in which
 *  case the deepest of them is named — the same rule the verdict already
 *  used, now shared rather than duplicated. */
export function bestOf(rows) {
  const usable = (rows ?? []).filter(Boolean);
  if (!usable.length) return null;
  const open = usable.filter((r) => !vetoOf(r));
  return (open.length ? open : usable).reduce((a, b) => (byRank(a, b) <= 0 ? a : b));
}
