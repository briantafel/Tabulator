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
 *  is the full-strength red. 0.8 is where the red reads as dark — black still
 *  has the higher contrast mathematically all the way up, so this is a design
 *  call, not a contrast rule. */
export const CELL_KO_FROM = 0.8;
