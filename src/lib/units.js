/* Metric is the stored unit throughout — forecast.json carries cm, °C, km/h
 * and metres, exactly as Snow-Forecast publishes them. Conversion happens only
 * at the point of display, so nothing is lossy and nothing is converted twice.
 *
 * This is inverted from the Open-Meteo build, which stored imperial. */

export const cmToIn = (cm) => cm / 2.54;
export const cToF = (c) => (c * 9) / 5 + 32;
export const kmhToMph = (k) => k / 1.60934;

/** The unit mark for snow. Previously hard-coded as `"` at every call site,
 *  which meant metric mode rendered centimetres with an inch mark. */
export const snowUnit = (metric) => (metric ? "cm" : '"');

export const snowTxt = (cm, metric) => {
  if (cm == null) return "—";
  const v = metric ? cm : cmToIn(cm);
  if (v < 0.05) return "0";
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
};

/** Snow with its unit attached — use this rather than appending a mark. */
export const snowWithUnit = (cm, metric) =>
  cm == null ? "—" : `${snowTxt(cm, metric)}${snowUnit(metric)}`;

export const tempTxt = (c, metric) =>
  c == null ? "—" : Math.round(metric ? c : cToF(c)).toString();

export const windTxt = (kmh, metric) =>
  kmh == null ? "—" : Math.round(metric ? kmh : kmhToMph(kmh)).toString();

export const elevTxt = (m, metric) =>
  m == null ? "—" : metric ? `${Math.round(m)}m` : `${Math.round(m * 3.28084)}ft`;

/** The amount printed inside a radar cell — Brian's Radar cell variants show
 *  ".25": no unit and no leading zero, because a 32-wide cell at 8px has room
 *  for four characters.
 *
 *  One decimal, not his placeholder's two. Snow-Forecast reports whole
 *  centimetres, so two decimals of inches print conversion noise — ".39" and
 *  ".79" for 1 and 2 cm — and claim a precision the forecast does not have.
 *  One decimal also matches the resort sheet ("0.4"). 10 and up: whole
 *  numbers. Returns null when there is nothing to print. */
export function cellSnowTxt(cm, metric) {
  if (cm == null || cm < 0.05) return null;
  const v = metric ? cm : cmToIn(cm);
  let s;
  if (v < 10) s = v.toFixed(1);
  else s = Math.round(v).toString();
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  s = s.replace(/^0\./, ".");
  return s === "0" || s === "" ? null : s;
}

/** White text from this fill opacity up; black below. Brian's SnowKO variant
 *  is the full-strength red. Black still has the higher contrast
 *  mathematically all the way up, so this is a design call, not a contrast
 *  rule. Was 0.8; Brian moved it down a step on 2026-11-03 because black on
 *  the step below full ("16" when the max is 22) was tough to read at 8px. */
export const CELL_KO_FROM = 0.7;

/** A projected day's radar cell (days 7+): whole numbers, and nothing under
 *  half a unit — the ensemble median does not earn a decimal
 *  (claude/range-chart-spec.md, "Rules"). */
export function farCellSnowTxt(cm, metric) {
  if (cm == null) return null;
  const v = metric ? cm : cmToIn(cm);
  return v < 0.5 ? null : Math.round(v).toString();
}

/* Purple cells are lightness-matched to coral, so equal amounts look equally
   deep: for a coral fill at opacity a (over white), the purple opacity whose
   blend has the same OKLab lightness. Tops out near 0.87. */
const CORAL = [239, 74, 56];
const PURPLE = [155, 89, 208];
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function okL([r, g, b]) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
const over = (c, a) => c.map((v) => v * a + 255 * (1 - a));
export function purpleAlpha(coralA) {
  const target = okL(over(CORAL, coralA));
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (okL(over(PURPLE, mid)) > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
