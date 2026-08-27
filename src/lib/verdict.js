/* The sentence at the top of a trip.
 *
 * Brian's design writes it with the computed parts in brackets:
 *
 *   Your best bet is looking like [resort name], with [snowfall inches] over
 *   [number of days]. Temps look [good, warm, cold etc], and winds are
 *   [calm, moderate, a little high]. Overall, this is the move right now.
 *
 * The bracketed words are no longer a fixed set. Brian, 2026-08-26: "I'd like
 * to add some flexible language that reflects the actual conditions … if the
 * weather is going to be much over 32º, the text should say Temps look pretty
 * damn warm, or almost too warm to ski if pushing 40 … If it's very cold,
 * some language like temps look frigid. A combination of low temps and wind
 * would read a Temps look fairly miserable. But if there's a ton of incoming
 * snow, you could add a caveat that says 'but if you can hack it, it's gonna
 * be a powderpalooza.'"
 *
 * So the words are chosen from the numbers, not from the severity buckets —
 * the markers answer "is this dicey", which is a coarser question than "what
 * would you say about it". The thresholds live in constants.js with the rest
 * of the authored numbers.
 *
 * Returned as segments rather than a string so the view can colour the
 * computed clauses without parsing its own prose back apart. `hot` marks the
 * ones his mock draws in coral — still exactly four. The closing line is not
 * one of them: his mock draws it grey, and it is a summary rather than a
 * reading.
 */

import { tempSeverity, windSeverity, rainRisk } from "./scoring.js";
import { snowWithUnit } from "./units.js";
import { rank, byRank } from "./rank.js";
import {
  COLD_RED, COLD_DEEP, COLD_AMBER_HI,
  WARM_AMBER_LO, WARM_RED, TOO_WARM, WARM_SPRING, PLEASANT_LO,
  WIND_LIGHT, WIND_AMBER, WIND_HIGH, WIND_RED, WIND_HOWLING,
  DUMP_RATE, THIN_TOTAL,
} from "./constants.js";

/** Temperature, read off the window's extremes rather than day by day: `hi`
 *  is the warmest afternoon in the trip and `lo` the coldest night, which is
 *  what you would actually complain about.
 *
 *  Wind is an argument because cold and wind together are a different trip
 *  from cold alone — the wind is what makes it hurt, and Brian named that
 *  case specifically. It only bends the cold half of the ladder; a warm windy
 *  day is still a warm day, and the wind clause that follows says the rest.
 *
 *      hi > 40°F                      (see tempClause — its own sentence)
 *      hi ≥ 38°F                      almost too warm to ski
 *      hi > 34°F                      pretty damn warm
 *      hi ≥ 31°F                      a bit warm
 *      warm AND cold in one window    all over the place
 *      lo ≤ -16°F, wind ≥ 31mph       downright miserable
 *      lo ≤ -16°F                     frigid
 *      lo ≤ 10°F, wind ≥ 18mph        fairly miserable
 *      lo ≤ 0°F                       properly cold
 *      lo ≤ 10°F                      cold
 *      nothing flagged, hi ≥ 20°F     pleasant
 *      nothing flagged                good
 */
export function tempWord({ hi, lo, wind }) {
  const warm = hi != null && hi >= WARM_AMBER_LO;
  const cold = lo != null && lo <= COLD_AMBER_HI;
  const breezy = wind != null && wind >= WIND_AMBER;
  const gale = wind != null && wind >= WIND_RED;

  // Both ends misbehaving in one window is worth admitting rather than
  // picking a side — it is also a real forecast, not a contrived one:
  // a thaw on Tuesday and a clear -20°F night on Friday.
  if (warm && cold) return "all over the place";

  if (warm) {
    if (hi >= TOO_WARM) return "almost too warm to ski";
    if (hi > WARM_RED) return "pretty damn warm";
    return "a bit warm";
  }

  if (cold) {
    // Frigid is the headline at -16°F and below; adding wind to it earns the
    // stronger word rather than replacing the cold one.
    if (lo <= COLD_RED) return gale ? "downright miserable" : "frigid";
    if (breezy) return "fairly miserable";
    return lo <= COLD_DEEP ? "properly cold" : "cold";
  }

  // Nothing flagged. There is still a difference between a fine day and a
  // genuinely nice one, and the sentence is worth reading when the answer is
  // yes — "good" was doing both jobs and neither of them well.
  return hi != null && hi >= PLEASANT_LO ? "pleasant" : "good";
}

/** Brian, mid-build: "Anything over 40 should be something like 'it's spring,
 *  baby!'"
 *
 *  That one does not fit the frame. Every other reading slots into "Temps look
 *  ___"; this is a whole sentence with its own exclamation mark, so it
 *  replaces the frame rather than filling it and the clause after it starts a
 *  new sentence instead of continuing this one. Hence a clause, not a word:
 *  the caller needs to know which of the two shapes it got back. */
export function tempClause(x) {
  if (x.hi != null && x.hi > WARM_SPRING) return { t: "It's spring, baby!", bang: true };
  return { t: `Temps look ${tempWord(x)}`, bang: false };
}

/** Brian's three words, with the range opened up at both ends.
 *
 *      ≥ 45mph    absolutely howling
 *      ≥ 31mph    howling
 *      ≥ 25mph    a little high
 *      ≥ 18mph    moderate
 *      ≥ 12mph    light
 *      else       calm
 *
 *  The old version called the whole red band "a little high", which is what
 *  his mock says — but that left 31mph and 60mph sharing a phrase, and 60 is
 *  not a little anything. His phrase keeps the place it describes: the top of
 *  the dicey band, before the lifts start holding. */
export function windWord(wind) {
  if (wind == null) return "calm";
  if (wind >= WIND_HOWLING) return "absolutely howling";
  if (wind >= WIND_RED) return "howling";
  if (wind >= WIND_HIGH) return "a little high";
  if (wind >= WIND_AMBER) return "moderate";
  if (wind >= WIND_LIGHT) return "light";
  return "calm";
}

/** The closing line, which used to be the fixed "Overall, this is the move
 *  right now" — a sentence that cheerfully recommended a trip with no snow in
 *  it and 45mph winds.
 *
 *  "Rough" is deliberately the app's own definition of bad rather than a new
 *  judgement: a red marker in either column, the same thing the table draws a
 *  circle for. "Storming" is the one word that needs both halves at once —
 *  heavy snow AND a gale is the only thing that honestly earns it.
 *
 *  Snow is judged as a rate, not a total. 18" is a storm cycle over three days
 *  and an ordinary week over six, and the sentence has already told you which
 *  it is. */
export function closingWord({ total, days, hi, lo, wind, rain = false }) {
  const gale = wind != null && wind >= WIND_RED;
  const spring = hi != null && hi > WARM_SPRING;
  // Cold plus wind reads "miserable" up in the clause above, so the closing
  // cannot then call it the move — 20mph at 5°F is not a red marker but it is
  // not a good day either, and the two halves of the sentence have to agree.
  const miserable =
    lo != null && lo <= COLD_AMBER_HI && wind != null && wind >= WIND_AMBER;
  const rough =
    tempSeverity(hi, lo) === "red" || windSeverity(wind) === "red" || miserable;
  const dump = days > 0 && total / days >= DUMP_RATE;

  // The honest "unskiable" case is not a temperature at all — Snow-Forecast
  // publishes a freezing level, so rain can be read rather than guessed at.
  // Whatever is falling, if it lands as water there is nothing to ski.
  if (rain) return ". Overall, that is rain, not snow — sit this one out.";

  // Spring outranks the snow lines. A foot at 42°F is not powder, and after
  // "It's spring, baby!" a closing that calls it a fight is arguing with the
  // sentence it just finished.
  if (spring) return ". Overall, soft snow and sunshine.";

  // Two cases continue the sentence instead of starting a new one — they are
  // caveats on the conditions just described, not summaries of them.
  if (dump && gale) return ", so it's going to be storming, but if you can hack it, it's gonna be a powderpalooza.";
  if (dump && rough) return ", but if you can hack it, it's gonna be a powderpalooza.";
  if (dump) return ". Overall, this is the move right now.";
  if (total < THIN_TOTAL) {
    return rough
      ? ". Overall, this one's a skip."
      : ". Overall, there is not much falling right now.";
  }
  if (rough) return ". Overall, it's a fight for a decent day.";
  return ". Overall, this is the move right now.";
}

/** The window's extremes, read off the days themselves.
 *
 *  `score()` already puts hi/lo/wind on a scored resort and these are the
 *  same numbers — but deriving them here means the verdict is correct for any
 *  row carrying a window, rather than silently reading "good and calm" off a
 *  row that happens not to have been scored. Wrong prose that looks right is
 *  the worst failure this file has available to it. */
function extremes(win) {
  const nums = (k) => win.map((d) => d[k]).filter((x) => typeof x === "number" && Number.isFinite(x));
  const hi = nums("tempMax");
  const lo = nums("tempMin");
  const w = nums("windMax");
  return {
    hi: hi.length ? Math.max(...hi) : null,
    lo: lo.length ? Math.min(...lo) : null,
    wind: w.length ? Math.max(...w) : null,
  };
}

/** `rows` are scored resorts, already narrowed to this trip.
 *  Returns null when there is nothing to have an opinion about. */
export function tripVerdict(rows, metric) {
  const usable = rows.filter((r) => r?.win?.length);
  if (!usable.length) return null;

  /* "Best bet" means the same thing here as the order of the table below it —
     the balanced rank, not the deepest number. Brian asked for the two to
     agree, and a sentence that recommends the second row would read as a bug.
     Ranked here rather than trusted, for the same reason extremes() exists. */
  const ranked = usable.map((r) => (r.rank != null ? r : { ...r, ...extremes(r.win), rank: rank({ ...r, ...extremes(r.win) }) }));
  const best = ranked.reduce((a, b) => (byRank(a, b) <= 0 ? a : b));
  const days = best.win.length;
  const { hi, lo, wind } = extremes(best.win);
  const temp = tempClause({ hi, lo, wind });

  return [
    { t: "Your best bet is looking like " },
    { t: best.name, hot: true },
    { t: ", with " },
    { t: snowWithUnit(best.total, metric), hot: true },
    { t: ` over ${days} days. ` },
    { t: temp.t, hot: true },
    // "It's spring, baby!" has ended the sentence; the wind starts a new one.
    { t: temp.bang ? " " : ", and " },
    { t: `${temp.bang ? "W" : "w"}inds are ${windWord(wind)}`, hot: true },
    { t: closingWord({ total: best.total ?? 0, days, hi, lo, wind, rain: rainRisk(best) }) },
  ];
}
