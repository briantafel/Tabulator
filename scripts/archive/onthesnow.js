/* ------------------------------------------------------------------ *
 * OnTheSnow: what the resorts and skiers report.
 *
 * Two pages per resort, all 40 including the Canadian four:
 *
 *   /skireport           the resort's snow report. Since 2026-10-29 parsed
 *                        into rows; the raw page is kept as well.
 *   /ski-report-reviews  first-hand skier reports, parsed with the app's own
 *                        parser. Reporter names are not archived.
 *
 * DAILY RESORT-REPORTED SNOWFALL. The snow report carries a `recent` list:
 * one {date, snow} per day for the last eight days, in centimetres, as the
 * resort reported it. Every capture is kept (append-only), one row per day
 * per capture. The analysis takes, for each day, the figure as reported the
 * FOLLOWING day — after the resort has settled it — and falls back to a
 * later capture only if that one was missed. Earlier and later captures stay
 * in the archive, so revisions are visible too.
 *
 * Structure observed 2026-10-29 (Alta), in the page's RSC stream:
 *   { …, updatedAt, snow: {base, middle, summit, last24, last48, last72},
 *     depths: {base, middle, summit}, recent: [{date, snow}] ×8,
 *     recentLastModified, forecast: [{date, snow}] ×8, history: null }
 * Values are centimetres (5.08 = the 2" the page shows).
 *
 * Also here: the one-time /historical-snowfall parser — monthly resort
 * totals back to 2012-13 — used by backfill-runner.js.
 * ------------------------------------------------------------------ */

import { flightRows, parseReportsPage, resolve } from "../parse-reports.js";
import { fetchText, saveRaw, sleep, zonedToUtc } from "./common.js";

export const PARSER_VERSION = "ots-2";
const BASE = "https://www.onthesnow.com";
const DELAY_MS = 1500;
const MIN_OK_RATIO = 0.8;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The first object in the page's RSC stream that has all of `keys`,
 *  with its "$id" references followed. */
function findObject(html, keys) {
  const rows = flightRows(html);
  if (!rows) throw new Error("no RSC stream — the page is not the one we think it is");
  for (const v of rows.values()) {
    if (v && typeof v === "object" && !Array.isArray(v) && keys.every((k) => k in v)) return resolve(rows, v);
  }
  return null;
}

/** A resort-local calendar day → its UTC window. */
const localDay = (date, tz) => {
  const start = zonedToUtc(date, 0, tz);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
  return { valid_start: start, valid_end: zonedToUtc(next, 0, tz) };
};

export function reportsToRows(html, { resort, fetchedAt, runId }) {
  const { reports } = parseReportsPage(html, { resortId: resort.id });
  const rows = [];
  for (const r of reports) {
    const at = { source: "onthesnow", kind: "observation", resort_id: resort.id, station_id: r.id,
      fetched_at: fetchedAt, valid_start: r.at, valid_end: r.at, run_id: runId, parser_version: PARSER_VERSION };
    rows.push({ ...at, variable: "skier_report", value_text: r.text });
    if (r.photo?.src) rows.push({ ...at, variable: "skier_report_photo", value_text: r.photo.src });
  }
  return rows;
}

export function skireportToRows(html, { resort, fetchedAt, runId }) {
  const o = findObject(html, ["recent", "snow", "depths"]);
  if (!o) throw new Error("no snow report object (recent/snow/depths) — the page shape moved");
  if (!Array.isArray(o.recent)) throw new Error("snow report has no recent[] list");
  const reportedAt = o.recentLastModified || o.updatedAt;
  const issued = reportedAt && !Number.isNaN(Date.parse(reportedAt)) ? new Date(reportedAt).toISOString() : null;
  const base = { source: "onthesnow", resort_id: resort.id, fetched_at: fetchedAt, run_id: runId, parser_version: PARSER_VERSION };
  const rows = [];

  // Resort-reported snowfall, one row per day per capture.
  for (const d of o.recent) {
    if (!DATE.test(d?.date ?? "") || num(d.snow) == null) continue;
    rows.push({ ...base, kind: "observation", issued_at: issued, ...localDay(d.date, resort.tz),
      period_label: "daily", variable: "reported_daily_snow", value: num(d.snow), unit: "cm" });
  }

  // OnTheSnow's own daily snow forecast — another forecast to grade.
  for (const d of Array.isArray(o.forecast) ? o.forecast : []) {
    if (!DATE.test(d?.date ?? "") || num(d.snow) == null) continue;
    rows.push({ ...base, kind: "forecast", ...localDay(d.date, resort.tz),
      period_label: "daily", variable: "snow", value: num(d.snow), unit: "cm" });
  }

  // Current depths and rolling totals, as of the report.
  const asOf = { ...base, kind: "observation", issued_at: issued, valid_start: issued ?? fetchedAt, valid_end: issued ?? fetchedAt };
  const s = o.snow ?? {};
  for (const [variable, v] of [
    ["reported_base_depth", s.base], ["reported_mid_depth", s.middle], ["reported_summit_depth", s.summit],
    ["reported_last24", s.last24], ["reported_last48", s.last48], ["reported_last72", s.last72],
  ]) if (num(v) != null) rows.push({ ...asOf, variable, value: num(v), unit: "cm" });
  if (o.reportStatus) rows.push({ ...asOf, variable: "report_status", value_text: String(o.reportStatus) });

  return rows;
}

/** /historical-snowfall: one row per month back to 2012-13, resort-reported. */
export function historyToRows(html, { resort, fetchedAt, runId }) {
  const rows = flightRows(html);
  if (!rows) throw new Error("no RSC stream on the historical page");
  const out = [];
  const seen = new Set();
  for (const v of rows.values()) {
    const m = resolve(rows, v);
    if (!m || typeof m !== "object" || Array.isArray(m) || !DATE.test(m.date ?? "") || !("totalSnow" in m)) continue;
    if (seen.has(m.date)) continue;
    seen.add(m.date);
    const start = zonedToUtc(m.date, 0, resort.tz);
    const [y, mo] = m.date.split("-").map(Number);
    const next = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
    const at = { source: "onthesnow", kind: "observation", resort_id: resort.id, fetched_at: fetchedAt,
      valid_start: start, valid_end: zonedToUtc(next, 0, resort.tz), period_label: "monthly",
      run_id: runId, parser_version: "ots-history-1" };
    for (const [variable, val, unit] of [
      ["reported_month_snow", m.totalSnow, "cm"], ["reported_month_snow_days", m.snowDays, "days"],
      ["reported_month_biggest_snowfall", m.biggestSnowfall, "cm"], ["reported_month_base_depth", m.baseDepth, "cm"],
      ["reported_month_summit_depth", m.summitDepth, "cm"], ["reported_month_max_base_depth", m.maxBaseDepth, "cm"],
    ]) if (num(val) != null) out.push({ ...at, variable, value: num(val), unit });
  }
  if (!out.length) throw new Error("historical page parsed to zero months");
  return out;
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  let ok = 0, tried = 0, reports = 0, days = 0;
  const failures = [];
  for (const resort of resorts) {
    if (!resort.otsPath) continue;
    for (const kind of ["skireport", "ski-report-reviews"]) {
      tried++;
      try {
        const { status, text } = await fetchText(`${BASE}/${resort.otsPath}/${kind}`, { delayMs: DELAY_MS });
        if (status !== 200) throw new Error(`HTTP ${status} — otsPath "${resort.otsPath}" may be wrong`);
        await saveRaw(`${rawDir}/${resort.id}-${kind}.html.gz`, text);
        const rows = kind === "skireport"
          ? skireportToRows(text, { resort, fetchedAt, runId })
          : reportsToRows(text, { resort, fetchedAt, runId });
        rows.forEach((r) => sink.write(r));
        if (kind === "skireport") days += rows.filter((r) => r.variable === "reported_daily_snow").length;
        else reports += rows.filter((r) => r.variable === "skier_report").length;
        ok++;
      } catch (e) {
        failures.push(`${resort.id}/${kind}: ${e.message}`);
        log(`  ✗ onthesnow ${resort.id}/${kind} — ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
  }
  log(`onthesnow: ${ok}/${tried} pages, ${days} daily snowfall readings, ${reports} skier reports`);
  return { ok: tried > 0 && ok / tried >= MIN_OK_RATIO, pages: ok, tried, dailyReadings: days, skierReports: reports, failures };
}
