/* ------------------------------------------------------------------ *
 * Snow-Forecast hindcast tables → archive rows.
 *
 * The hindcast is Snow-Forecast's own record of past weather at a resort,
 * by AM / PM / night period, back to 2007 — its model's view of what
 * happened, not what it forecast days ahead, and not a measurement. Its
 * value is comparison: against SNOTEL it shows where Snow-Forecast
 * systematically over- or under-calls snow at each resort.
 *
 * The page uses an older table than the live forecast (`table.forecasts`,
 * rows told apart by their label cell rather than by data-row), so it has
 * its own parser. Input is one line from sf-hindcast-runner.browser.js:
 * { slug, tier, from, through, title, fetchedAt, table }.
 *
 * Structure observed on 2026-10-29 (Alta, window 2025-01-11):
 *   tr.day-names   day headers with colspans; the first is a partial day
 *   tr.hea2        AM / PM / night per period
 *   tr.icons       img alt = the weather phrase
 *   tr.winds       div[data-speed] km/h; arrow rotate(deg)
 *   tr.lar         one per variable; label cell says which ("Snow cm", "Max °C"…)
 * ------------------------------------------------------------------ */

import * as cheerio from "cheerio";
import { parseNumber, parseSnow } from "../parse.js";
import { addHours, zonedToUtc } from "./common.js";

export const PARSER_VERSION = "sf-hindcast-1";
const WINDOW = { am: [6, 6], pm: [12, 6], night: [18, 12] };
const IMPERIAL = /°F|mph|\bin\b|\bft\b/;

/** label cell text → how to read the row. Tested in order; first match wins. */
const LABELS = [
  [/Snow\s*cm/i, { variable: "snow", unit: "cm", read: parseSnow }],
  [/Rain\s*mm/i, { variable: "rain", unit: "mm", read: parseSnow }],
  [/Max\s*°C/i, { variable: "temp_max", unit: "C", read: parseNumber }],
  [/Min\s*°C/i, { variable: "temp_min", unit: "C", read: parseNumber }],
  [/Chill\s*°C/i, { variable: "wind_chill", unit: "C", read: parseNumber }],
  [/Humid/i, { variable: "humidity", unit: "%", read: parseNumber }],
  [/Freeze\s*\(m\)/i, { variable: "freezing_level", unit: "m", read: parseNumber }],
];

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const DAY_MS = 86400e3;
const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function hindcastToRows(rec, { resort, runId }) {
  const $ = cheerio.load(rec.table);
  const table = $("table").first();
  if (!table.length) throw new Error("no table in record");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.from ?? "")) throw new Error("record has no start date");

  // Periods: day headers give the spans, the period row gives the labels.
  const spans = table.find("tr.day-names td").toArray().map((c) => parseInt($(c).attr("colspan") ?? "1", 10));
  const labels = table.find("tr.hea2 td").toArray().map((c) => clean($(c).text()).toLowerCase());
  if (!spans.length || !labels.length) throw new Error("missing day or period header row");
  const total = spans.reduce((a, b) => a + b, 0);
  if (total !== labels.length) throw new Error(`day spans cover ${total} periods but there are ${labels.length}`);

  const periods = [];
  spans.forEach((n, d) => {
    for (let i = 0; i < n; i++) {
      const label = labels[periods.length];
      const date = shift(rec.from, d);
      const w = WINDOW[label];
      const start = w ? zonedToUtc(date, w[0], resort.tz) : null;
      periods.push({ label, start, end: start ? addHours(start, w[1]) : null });
    }
  });

  const elevation = parseNumber((String(rec.title).match(/for\s+(\d+)\s*m\b/) || [])[1]);
  const base = {
    source: "snow-forecast-hindcast", kind: "hindcast", resort_id: resort.id, tier: rec.tier,
    elevation_m: elevation, station_id: rec.slug, fetched_at: rec.fetchedAt, run_id: runId,
    parser_version: PARSER_VERSION,
  };
  const rows = [];
  const at = (p) => ({ valid_start: p.start, valid_end: p.end, period_label: p.label });
  const cellsOf = (tr) => $(tr).find("td").toArray();

  table.find("tr").each((_, tr) => {
    const label = clean($(tr).find("th").first().text());
    if (!label) return;
    const hit = LABELS.find(([re]) => re.test(label));
    if (!hit) return;
    if (IMPERIAL.test(label)) throw new Error(`row "${label}" is in imperial units`);
    const spec = hit[1];
    cellsOf(tr).forEach((c, i) => {
      const p = periods[i];
      if (!p?.start) return;
      rows.push({ ...base, ...at(p), variable: spec.variable, value: spec.read(clean($(c).text())), unit: spec.unit });
    });
  });

  table.find("tr.winds").first().find("td").toArray().forEach((c, i) => {
    const p = periods[i];
    if (!p?.start) return;
    const speed = parseNumber($(c).find("[data-speed]").attr("data-speed"));
    if (speed != null) rows.push({ ...base, ...at(p), variable: "wind_speed", value: speed, unit: "km/h" });
    const rot = ($(c).find("[transform]").attr("transform") || "").match(/rotate\((-?[\d.]+)\)/);
    if (rot) rows.push({ ...base, ...at(p), variable: "wind_arrow_deg", value: ((parseFloat(rot[1]) % 360) + 360) % 360, unit: "deg" });
  });

  table.find("tr.icons").first().find("td").toArray().forEach((c, i) => {
    const p = periods[i];
    const alt = clean($(c).find("img").attr("alt"));
    if (p?.start && alt) rows.push({ ...base, ...at(p), variable: "phrase", value_text: alt });
  });

  if (!rows.some((r) => r.variable === "snow")) throw new Error("no snow row found");
  return rows;
}
