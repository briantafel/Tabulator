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
export const snowUnit = (metric) => (metric ? "cm" : "″");

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
