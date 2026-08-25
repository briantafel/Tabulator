import * as cheerio from "cheerio";

/* ------------------------------------------------------------------ *
 * Snow-Forecast.com parser
 *
 * Targets stable `data-row` attributes, never ordinal table position.
 * Ordinal indexing is what broke the spreadsheet: `IMPORTHTML(url,
 * "table", 3)` silently started returning the Bluebird-days table when
 * the page was reorganised. Every selector here is named.
 *
 * See claude/snow-forecast-parsing-contract.md for the field survey.
 * ------------------------------------------------------------------ */

const PERIODS_PER_DAY = 3; // AM / PM / night
const DAYS = 6;
const N_PERIODS = DAYS * PERIODS_PER_DAY; // 18

/** Rows carry an optional leading unit/label cell. The period cells are
 *  always the trailing 18, so slice from the end rather than assuming
 *  an offset — `time` has no label cell while `snow` does. */
function periodCells($, row) {
  const cells = $(row).find("td, th").toArray();
  return cells.slice(Math.max(0, cells.length - N_PERIODS));
}

const text = ($, el) => $(el).text().replace(/\s+/g, " ").trim();

/** Snow-Forecast renders "no snow" as an em-dash, not a zero. Treating
 *  that as null would ripple through every sum in the app. */
export function parseSnow(raw) {
  const v = raw.replace(/[–—]/g, "-").trim();
  if (v === "" || v === "-") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Wind arrives as magnitude and bearing fused into one string: "15NNW". */
export function parseWind(raw) {
  const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW]{0,3})$/);
  if (!m) return { speed: null, dir: null };
  return { speed: parseFloat(m[1]), dir: m[2] || null };
}

export function parseNumber(raw) {
  const n = parseFloat(String(raw).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const DAY_MS = 86400000;
const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Day headers read "Thursday20" — a weekday and a day-of-month, with no
 *  month or year. Walk a cursor forward from `from` until the day-of-month
 *  matches, so the calendar does the disambiguating.
 *
 *  A header can be BLANK, and this is not a scraping error. The morning runs
 *  (06:15 UTC) catch most US resorts partway through their local night, and
 *  Snow-Forecast leads its table with the remainder of the previous day in a
 *  cell that carries no weekday label. Before 2026-08-25 that produced
 *  `date: null` on day zero for 19 of 23 resorts, twice a day, every day —
 *  a whole column of real forecast data the app then had no key for. The
 *  columns are consecutive days by construction, so a blank one is recovered
 *  exactly from whichever neighbour did resolve. */
export function resolveDates(headers, from) {
  /* Start a day BEHIND now. The leading column is often the tail of the
     previous local day, and a cursor that starts at today can only walk
     forward — so a header reading "24" on the 25th resolved to the 24th of
     NEXT month, a month-long jump presented as a forecast. */
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 1));
  const out = [];
  for (const h of headers) {
    const dom = parseNumber((h.match(/(\d+)\s*$/) || [])[1]);
    if (dom == null) { out.push(null); continue; }
    let guard = 0;
    while (cursor.getUTCDate() !== dom && guard++ < 40) cursor.setUTCDate(cursor.getUTCDate() + 1);
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Back-fill from the right, then forward from the left. Two passes because
  // the blank can be at either end, and a table of nothing but blanks must
  // stay all-null rather than invent a week out of thin air.
  for (let i = out.length - 2; i >= 0; i--) if (!out[i] && out[i + 1]) out[i] = shift(out[i + 1], -1);
  for (let i = 1; i < out.length; i++) if (!out[i] && out[i - 1]) out[i] = shift(out[i - 1], 1);
  return out;
}

/** Parses one resort page into 6 days of aggregated metrics.
 *  Units are the page's own: cm, °C, km/h, metres. */
export function parseResortPage(html, { now = new Date() } = {}) {
  const $ = cheerio.load(html);

  const table = $("table.forecast-table__table").first();
  if (!table.length) throw new Error("forecast table not found (.forecast-table__table)");

  const row = (name) => {
    const r = table.find(`[data-row="${name}"]`).first();
    return r.length ? r : null;
  };
  const required = (name) => {
    const r = row(name);
    if (!r) throw new Error(`missing row [data-row="${name}"]`);
    return r;
  };

  // Day headers and tier elevations both live in the `days` row.
  const daysRow = required("days");
  const dayCells = daysRow.find("td, th").toArray();
  const elevLabel = text($, dayCells[0]);
  const elevs = (elevLabel.match(/(\d+)\s*m/g) || []).map(parseNumber);
  const headers = dayCells.slice(1, 1 + DAYS).map((c) => text($, c));
  const dates = resolveDates(headers, now);

  const series = (name, fn) => {
    const r = row(name);
    if (!r) return Array(N_PERIODS).fill(null);
    return periodCells($, r).map((c) => fn(text($, c)));
  };

  const snow = series("snow", parseSnow);
  const tmax = series("temperature-max", parseNumber);
  const tmin = series("temperature-min", parseNumber);
  const wind = series("wind", (t) => parseWind(t).speed);
  const windDir = series("wind", (t) => parseWind(t).dir);
  const freeze = series("freezing-level", parseNumber);
  const phrases = series("phrases", (t) => t || null);
  const times = periodCells($, required("time")).map((c) => text($, c).toLowerCase());

  const nums = (a) => a.filter((x) => typeof x === "number" && Number.isFinite(x));
  const days = [];
  for (let d = 0; d < DAYS; d++) {
    const s = d * PERIODS_PER_DAY;
    const slice = (a) => a.slice(s, s + PERIODS_PER_DAY);
    const t = slice(tmax), n = slice(tmin), w = slice(wind), f = slice(freeze);
    days.push({
      date: dates[d],
      label: headers[d] || null,
      snow: Number(slice(snow).reduce((a, b) => a + b, 0).toFixed(2)),
      periods: slice(times).map((name, i) => ({
        name,
        snow: slice(snow)[i],
        tempMax: t[i],
        wind: w[i],
        windDir: slice(windDir)[i],
        freezingLevel: f[i],
        phrase: slice(phrases)[i],
      })),
      tempMax: nums(t).length ? Math.max(...nums(t)) : null,
      tempMin: nums(n).length ? Math.min(...nums(n)) : null,
      windMax: nums(w).length ? Math.max(...nums(w)) : null,
      freezeMin: nums(f).length ? Math.min(...nums(f)) : null,
      freezeMax: nums(f).length ? Math.max(...nums(f)) : null,
    });
  }

  // Prose forecast — the thing Open-Meteo could never provide.
  const sumRow = row("summary");
  const sumCells = sumRow ? sumRow.find("td, th").toArray().map((c) => text($, c)).filter(Boolean) : [];

  // Snow depths live in a separate, also-named table.
  const depths = {};
  $("table.snow-depths-table__table tr").each((_, tr) => {
    const c = $(tr).find("td, th").toArray().map((x) => text($, x));
    if (c.length >= 2) depths[c[0].replace(/:$/, "")] = c[1];
  });

  return {
    elevation: { top: elevs[0] ?? null, mid: elevs[1] ?? null, bot: elevs[2] ?? null },
    days,
    summary: { next3: sumCells[0] ?? null, days46: sumCells[1] ?? null },
    depths,
    units: { snow: "cm", temp: "C", wind: "km/h", elevation: "m" },
  };
}
