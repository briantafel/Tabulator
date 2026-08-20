/* Tuning constants. These are judgement calls, not physics — see
 * docs/OPEN-ITEMS.md #4 for the unresolved question about how the
 * temp/wind warnings are colour-coded. */

export const PAST = 3;        // days of history behind today, feeds the "before" column
export const HORIZON = 16;    // Open-Meteo's free forecast ceiling
export const TODAY_IDX = PAST; // today's index inside the combined past+forecast series

export const WIND_LIMIT = 35; // mph — lifts commonly go on hold around here
export const WARM_LIMIT = 34; // °F — above this, precipitation turns unreliable
export const COLD_LIMIT = 0;  // °F — below this, it stops being fun

/* Chart series. The first is the coral accent; the rest are neutral
 * companions used only inside the chart, never in the app chrome. */
export const SERIES = ["#EF4A38", "#4A90E2", "#63C2A8", "#E8B62C", "#8E7CC3"];
