/* Tuning constants.
 *
 * Thresholds are authored in °F and mph — the units Brian set them in — and
 * converted to metric here, because forecast.json stores metric. Keeping the
 * authored numbers visible in the source is deliberate: they are judgement
 * calls about skiing, and a future reader needs to see them in the units they
 * were judged in. Set 2026-08-21. */

const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;
const IN = (i) => i * 2.54;

export const HORIZON_DAYS = 6;   // Snow-Forecast's free horizon
export const HISTORY_DAYS = 3;   // the "-3 days" lookback

/* Severity, not category. The column says which variable is misbehaving;
 * the marker says how badly. Amber (triangle) = dicey. Red (circle) = crappy.
 * Shape carries the meaning alongside colour so the table still reads in
 * greyscale and for a colourblind viewer. */

// Temperature — bad in both directions, evaluated against the window's
// min (cold) and max (warm).
export const COLD_RED = F(-16);       // ≤ -16°F  — brutal
export const COLD_AMBER_LO = F(-15);  // -15°F …
export const COLD_AMBER_HI = F(10);   // … to 10°F — dicey
export const WARM_AMBER_LO = F(31);   // 31°F …
export const WARM_AMBER_HI = F(34);   // … to 34°F — dicey
export const WARM_RED = F(34);        // > 34°F   — raining

// Wind — bad in one direction, evaluated against the window's max.
export const WIND_AMBER = MPH(18);    // ≥ 18 mph — dicey
export const WIND_RED = MPH(31);      // ≥ 31 mph — lifts hold. Open-ended:
                                      // Brian wrote 31-45, but 46 must not
                                      // fall out the bottom into no warning.

/* The trip verdict's own vocabulary — a second, finer set of thresholds, used
 * only to choose words. The markers above answer "is this dicey", three
 * values wide. That is too coarse to write with: -14°F and 8°F are both amber
 * and only one of them is frigid. Authored in °F, mph and inches, Brian's
 * units, and set from his own wording on 2026-08-26:
 *
 *   "much over 32º … pretty damn warm, or almost too warm to ski if pushing
 *    40 … If it's very cold, some language like temps look frigid. A
 *    combination of low temps and wind would read Temps look fairly
 *    miserable … cold, warm, pleasant, calm, windy, storming, miserable,
 *    unskiable etc."
 *
 * TOO_WARM is 38 because 40 itself would leave "pushing 40" nowhere to fire
 * below it. WIND_HOWLING is 45 because he had already written the red band as
 * "31-45"; that top number was in his head, it just had no word attached. */
export const WARM_SPRING = F(40);     // "it's spring, baby!" — his words, his number
export const TOO_WARM = F(38);        // "almost too warm to ski"
export const PLEASANT_LO = F(20);     // cold enough to keep, warm enough to enjoy
export const COLD_DEEP = F(0);        // "properly cold" — below the amber midpoint

export const WIND_LIGHT = MPH(12);    // above calm, below noticeable
export const WIND_HIGH = MPH(25);     // top half of the amber band
export const WIND_HOWLING = MPH(45);  // above the top of his own red band

/* Snow, judged as a RATE rather than a total: 18" is a storm cycle over three
 * days and an ordinary week over six, and the sentence already tells you how
 * many days it is counting. */
export const DUMP_RATE = IN(4);       // ≥ 4"/day — powderpalooza territory
export const THIN_TOTAL = IN(4);      // < 4" across the whole window

/* Ranking. Brian, 2026-08-27: "Rather than relying on snowfall alone, I would
 * like to balance temperature, wind and snow. Two resorts with similar
 * snowfalls but better weather and higher -3 days snowfall should edge out the
 * resort with purely better snowfall and/or poor weather or low recent
 * snowfall."
 *
 * The weights below are the whole model, and they are set so that "similar"
 * is the word that does the work. Forecast snow is worth 70 of the 100 points
 * and runs linearly to 30"; the other three are worth 30 between them. So a
 * 2" gap in forecast snow is under 5 points and conditions decide it, while a
 * 16" gap is 37 points and nothing else can catch up. That is the behaviour he
 * described, expressed as two numbers rather than as a rule.
 *
 * Each term saturates: past its FULL value more is not better. 40" and 60" are
 * both simply a lot of snow, and a model that kept rewarding the difference
 * would let one freak number outvote everything else. */
export const RANK_SNOW = 70;          // forecast snow over the window
export const RANK_BASE = 12;          // the -3 days archive — something to ski on
export const RANK_TEMP = 12;
export const RANK_WIND = 6;

/* A RATE, like DUMP_RATE, not a total. 30" is a huge four-day window and an
 * ordinary six-day one; a fixed number would let a long window saturate
 * everybody and hand the whole ranking to the weather, and a short window
 * saturate nobody and hand it to the snow. Half a foot a day is a great week
 *  anywhere, and at 8 the depths that actually differ still differ. */
export const SNOW_FULL_RATE = IN(8);  // 8"/day earns all 70 — as good as it gets
export const BASE_FULL = IN(12);      // 12" in the three days before earns all 12

export const MARKER = { red: "#FF383C", amber: "#FFCC00" };

/* Chart series. Per the Figma: four resort curves in blue/teal/pink/orange.
 * Coral is NOT a series colour there — it is reserved for wind. */
export const SERIES = ["#4A90E2", "#63C2A8", "#E8709B", "#E8963C", "#8E7CC3"];
