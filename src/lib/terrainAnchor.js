/* An anchored terrain map (scripts/maps/anchor.py) is drawn so its total equals the sheet's forecast total: the same
   local days, the same blend run. Brian 2026-11-22: "There can never be a discrepancy between the totals on the map
   and the forecast." So the app checks it is the SAME number before showing the map, and hides the map otherwise:
   - the sheet must be showing our number (snowfall switch on and this resort on it), not Snow-Forecast's;
   - the sheet's forecast days must be exactly the map's days (a narrower trip window, or a day rolled over since
     the map was drawn, is a different total);
   - the sheet's sum over those days must equal the map's total (a newer blend run has landed and the map has not
     caught up yet: hidden for the few minutes until the refresh publishes).
   A map without an anchor (every resort but the ones being trialled) is unaffected. */
export const ANCHOR_TOL_CM = 0.05;

export function anchorMatches(anchor, sheet) {
  if (!anchor) return true;
  if (!sheet || sheet.snowfall !== "tabulator") return false;
  const days = sheet.win ?? [];
  const dates = days.map((d) => d.date);
  if (dates.length !== anchor.dates?.length || dates.some((d, i) => d !== anchor.dates[i])) return false;
  if (days.some((d) => typeof d.snow !== "number" || !Number.isFinite(d.snow))) return false;
  const sum = days.reduce((s, d) => s + d.snow, 0);
  return Math.abs(sum - anchor.total_cm) <= ANCHOR_TOL_CM;
}
