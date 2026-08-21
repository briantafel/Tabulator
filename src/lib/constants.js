/* Thresholds live in the source's own units — metric — because that is what
 * Snow-Forecast serves and what forecast.json stores. Conversion happens once,
 * at display. The imperial equivalents are noted so the intent stays legible:
 * these numbers were originally chosen in °F and mph. */

export const HORIZON_DAYS = 6;   // Snow-Forecast's free horizon
export const HISTORY_DAYS = 3;   // the "-3 days" lookback

export const WIND_LIMIT = 56.3;  // km/h — 35 mph, where lifts commonly go on hold
export const WARM_LIMIT = 1.1;   // °C — 34°F, above which precipitation turns unreliable
export const COLD_LIMIT = -17.8; // °C — 0°F, below which it stops being fun

/* Chart series. The first is the coral accent; the rest are neutral companions
 * used only inside the chart, never in the app chrome. */
export const SERIES = ["#EF4A38", "#4A90E2", "#63C2A8", "#E8B62C", "#8E7CC3"];
