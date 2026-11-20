/* Base depth, top depth and last snowfall for the resort sheet.
 *
 * Source: Snow-Forecast's own depths table, which the scrape has carried in
 * `depths` since August — "Bottom snow depth: 5 cm", "Top snow depth: 20 cm",
 * "Last snowfall: 27 Oct 2026". Snow-Forecast calls the base "Bottom".
 *
 * "Fresh snowfall depth" is how much fell in that last snowfall. Snow-Forecast
 * only publishes it while the snowfall is recent (22 of 56 resorts on
 * 2026-10-31; a week-old storm reads "—"), so it is shown beside the date
 * when present and simply left off when not. Zero reads as absent: "0 cm of
 * snow last fell" is not a snowfall.
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

const positive = (n) => (n != null && n > 0 ? n : null);

/* A depth of 0 beside fresh snowfall is the vendor's gap, not a bare
 * mountain. Kirkwood, 2026-11-18/19: Snow-Forecast printed "Bottom 0 cm, Top
 * 0 cm" next to "Fresh snowfall 81 cm" (SNOTEL depth rose 33 → 91 cm), and the
 * sheet showed Base 0" Top 0". Snow cannot fall on a mountain and leave it
 * with no depth, so a 0 is dropped (null → the sheet leaves it off) whenever
 * fresh snow is reported. 0 with no fresh snow is still a real 0. */
const depthOrNull = (cm, fresh) => (cm === 0 && fresh != null ? null : cm);

export function snowpack(resort) {
  const d = resort?.depths ?? {};
  const fresh = positive(parseDepthCm(d["Fresh snowfall depth"]));
  return {
    base: depthOrNull(parseDepthCm(d["Bottom snow depth"]), fresh),
    top: depthOrNull(parseDepthCm(d["Top snow depth"]), fresh),
    last: parseDay(d["Last snowfall"]),
    fresh,
  };
}
