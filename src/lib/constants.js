/* Tuning constants.
 *
 * Thresholds are authored in °F and mph — the units Brian set them in — and
 * converted to metric here, because forecast.json stores metric. Keeping the
 * authored numbers visible in the source is deliberate: they are judgement
 * calls about skiing, and a future reader needs to see them in the units they
 * were judged in. Set 2026-08-21. */

const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;

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

export const MARKER = { red: "#FF383C", amber: "#FFCC00" };

/* Chart series. Per the Figma: four resort curves in blue/teal/pink/orange.
 * Coral is NOT a series colour there — it is reserved for wind. */
export const SERIES = ["#4A90E2", "#63C2A8", "#E8709B", "#E8963C", "#8E7CC3"];
