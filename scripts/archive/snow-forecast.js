/* ------------------------------------------------------------------ *
 * Snow-Forecast, every row of the 6-day table, at all three tiers.
 *
 * The app's own scraper (scripts/scrape.js) reads the mid tier and keeps
 * only what the screens need. The archive keeps everything the table
 * prints, per period, per tier, plus the raw page.
 *
 * Period times: Snow-Forecast labels periods AM / PM / night in the
 * resort's local time without stating the hours. Rows carry the label
 * verbatim and an ASSUMED window (AM 06–12, PM 12–18, night 18–06), so the
 * windows can be recomputed if the assumption proves wrong.
 * ------------------------------------------------------------------ */

import * as cheerio from "cheerio";
import { daySpans, parseNumber, parseSnow, parseWind, resolveDates } from "../parse.js";
import { addHours, fetchText, saveRaw, sleep, zonedToUtc } from "./common.js";

export const PARSER_VERSION = "sf-archive-1";
const BASE = "https://www.snow-forecast.com/resorts";
const TIERS = ["top", "mid", "bot"];
const N_PERIODS = 18;
const DELAY_MS = 2000;
const MIN_OK_RATIO = 0.8;

const WINDOW = { am: [6, 6], pm: [12, 6], night: [18, 12] }; // [start hour, length]

/** data-row → how to read it. `unit` is what we store; `expect` must appear
 *  in the row's own label cell, so a switch to imperial fails loudly. */
const ROWS = {
  "snow": { variable: "snow", unit: "cm", expect: /cm/, read: parseSnow },
  "rain": { variable: "rain", unit: "mm", expect: /mm/, read: parseSnow },
  "temperature-max": { variable: "temp_max", unit: "C", expect: /°C/, read: parseNumber },
  "temperature-min": { variable: "temp_min", unit: "C", expect: /°C/, read: parseNumber },
  "temperature-chill": { variable: "wind_chill", unit: "C", expect: /°C/, read: parseNumber },
  "humidity": { variable: "humidity", unit: "%", expect: /%/, read: parseNumber },
  "freezing-level": { variable: "freezing_level", unit: "m", expect: /\bm\b/, read: parseNumber },
  "wind": { variable: "wind_speed", unit: "km/h", expect: /km\/h/, read: (t) => parseWind(t).speed },
};
const IMPERIAL = /°F|mph|\bin\b|\bft\b/;

const clean = (s) => s.replace(/\s+/g, " ").trim();
const slugKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Parse one page into archive rows. Pure: no network, so it can be run
 *  again over saved raw pages with a newer PARSER_VERSION. */
export function pageToRows(html, { resort, slug, tier, fetchedAt, runId }) {
  const $ = cheerio.load(html);
  const table = $("table.forecast-table__table").first();
  if (!table.length) throw new Error("forecast table not found (.forecast-table__table)");
  const row = (name) => {
    const r = table.find(`[data-row="${name}"]`).first();
    return r.length ? r : null;
  };

  const daysRow = row("days");
  const timeRow = row("time");
  if (!daysRow || !timeRow) throw new Error("missing days or time row");

  const dayCells = daysRow.find("td, th").toArray();
  const elevs = (clean($(dayCells[0]).text()).match(/(\d+)\s*m/g) || []).map(parseNumber);
  const elevation = { top: elevs[0], mid: elevs[1], bot: elevs[2] }[tier] ?? null;
  const headerCells = dayCells.slice(1, 7);
  const dates = resolveDates(headerCells.map((c) => clean($(c).text())), new Date(fetchedAt));

  const tdText = (r) => r.find("td").toArray().slice(-N_PERIODS).map((c) => clean($(c).text()));
  const times = tdText(timeRow).map((t) => t.toLowerCase());
  const spans = daySpans(headerCells, times.length);

  // One entry per period: its local date, label and UTC window.
  const periods = [];
  spans.forEach((n, d) => {
    for (let i = 0; i < n; i++) periods.push({ date: dates[d], label: times[periods.length] });
  });
  for (const p of periods) {
    const w = WINDOW[p.label];
    if (!p.date || !w) { p.start = p.end = null; continue; }
    p.start = zonedToUtc(p.date, w[0], resort.tz);
    p.end = addHours(p.start, w[1]);
  }

  const base = {
    source: "snow-forecast", kind: "forecast", resort_id: resort.id, tier,
    elevation_m: elevation, station_id: slug, fetched_at: fetchedAt, run_id: runId,
    parser_version: PARSER_VERSION,
  };
  const rows = [];
  const at = (p) => ({ valid_start: p.start, valid_end: p.end, period_label: p.label });

  for (const [name, spec] of Object.entries(ROWS)) {
    const r = row(name);
    if (!r) continue;
    const label = clean(r.find("th").first().text());
    if (IMPERIAL.test(label)) throw new Error(`row ${name} is in imperial units ("${label}")`);
    if (label && !spec.expect.test(label)) throw new Error(`row ${name} has unexpected unit label "${label}"`);
    tdText(r).forEach((t, i) => {
      const p = periods[i];
      if (!p?.start) return;
      rows.push({ ...base, ...at(p), variable: spec.variable, value: spec.read(t), unit: spec.unit });
    });
  }

  const wind = row("wind");
  if (wind) tdText(wind).forEach((t, i) => {
    const p = periods[i];
    const dir = parseWind(t).dir;
    if (p?.start && dir) rows.push({ ...base, ...at(p), variable: "wind_dir", value_text: dir });
  });

  const phrases = row("phrases");
  if (phrases) tdText(phrases).forEach((t, i) => {
    const p = periods[i];
    if (p?.start && t) rows.push({ ...base, ...at(p), variable: "phrase", value_text: t });
  });

  // The prose forecast covers the whole table.
  const first = periods.find((p) => p.start), last = [...periods].reverse().find((p) => p.end);
  const summary = row("summary");
  if (summary && first && last) {
    const cells = summary.find("td, th").toArray().map((c) => clean($(c).text())).filter(Boolean);
    [["summary_next3", cells[0]], ["summary_days4_6", cells[1]]].forEach(([variable, t]) => {
      if (t) rows.push({ ...base, valid_start: first.start, valid_end: last.end, variable, value_text: t });
    });
  }

  // Resort-reported depths and powder-day counts are per resort, not per
  // tier, so they are read once, from the mid page. Kept verbatim as text.
  if (tier === "mid") {
    const side = (selector, prefix) => $(`${selector} tr`).each((_, tr) => {
      let [label, value] = $(tr).find("td, th").toArray().map((x) => clean($(x).text()));
      // The powder-days table puts the count first; the depths table, the label.
      if (/^[\d.]+$/.test(label ?? "") && !/^[\d.]+$/.test(value ?? "")) [label, value] = [value, label];
      if (!label || value == null || /snow alerts/i.test(label)) return;
      rows.push({ ...base, kind: "observation", tier: null, elevation_m: null,
        variable: `${prefix}${slugKey(label)}`, value_text: value });
    });
    side("table.snow-depths-table__table", "reported_");
    side("table.snow-history-table__table", "history_");
  }

  return { rows, elevation };
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  let ok = 0, tried = 0;
  const failures = [];
  const elevations = {}; // resort id → mid elevation, for the ensembles

  for (const resort of resorts) {
    for (const slug of resort.slugs) {
      for (const tier of TIERS) {
        tried++;
        const url = `${BASE}/${slug}/6day/${tier}`;
        try {
          const { status, text } = await fetchText(url, { delayMs: DELAY_MS });
          if (status === 404) throw new Error(`404 — slug "${slug}" is wrong or was renamed`);
          await saveRaw(`${rawDir}/${slug}-${tier}.html.gz`, text);
          const { rows, elevation } = pageToRows(text, { resort, slug, tier, fetchedAt, runId });
          if (!rows.length) throw new Error("page parsed to zero rows");
          rows.forEach((r) => sink.write(r));
          if (tier === "mid" && elevation && !elevations[resort.id]) elevations[resort.id] = elevation;
          ok++;
        } catch (e) {
          failures.push(`${slug}/${tier}: ${e.message}`);
          log(`  ✗ snow-forecast ${slug}/${tier} — ${e.message}`);
        }
        await sleep(DELAY_MS);
      }
    }
  }
  log(`snow-forecast: ${ok}/${tried} pages`);
  return { ok: ok / tried >= MIN_OK_RATIO, pages: ok, tried, failures, elevations };
}
