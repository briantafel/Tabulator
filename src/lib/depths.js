/* Base depth, top depth and last snowfall for the resort sheet.
 *
 * Source: Snow-Forecast's own depths table, which the scrape has carried in
 * `depths` since August — "Bottom snow depth: 5 cm", "Top snow depth: 20 cm",
 * "Last snowfall: 27 Oct 2026". Snow-Forecast calls the base "Bottom".
 *
 * Every value is optional. A depth that is absent or unreadable is null, never
 * 0: a missing base and a bare mountain look identical as a number and mean
 * opposite things. */

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "20 cm" → 20. "—", "", "n/a" → null. */
export function parseDepthCm(raw) {
  const m = /(-?\d+(?:\.\d+)?)\s*cm/i.exec(String(raw ?? ""));
  return m ? Number(m[1]) : null;
}

/** "27 Oct 2026" → "2026-10-27". Anything else → null. */
export function parseDay(raw) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(String(raw ?? ""));
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon == null) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

export function snowpack(resort) {
  const d = resort?.depths ?? {};
  return {
    base: parseDepthCm(d["Bottom snow depth"]),
    top: parseDepthCm(d["Top snow depth"]),
    last: parseDay(d["Last snowfall"]),
  };
}
