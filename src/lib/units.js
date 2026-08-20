/* Imperial is the stored unit throughout — the API is asked for °F, mph and
 * inches, and conversion happens only at the point of display. */

export const toCm = (i) => i * 2.54;
export const toC = (f) => ((f - 32) * 5) / 9;
export const toKmh = (m) => m * 1.60934;

export const snowTxt = (inches, metric) => {
  const v = metric ? toCm(inches) : inches;
  if (v < 0.05) return "0";
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
};

export const tempTxt = (f, metric) =>
  f == null ? "—" : Math.round(metric ? toC(f) : f).toString();

export const windTxt = (m, metric) =>
  m == null ? "—" : Math.round(metric ? toKmh(m) : m).toString();
