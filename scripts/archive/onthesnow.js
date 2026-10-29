/* ------------------------------------------------------------------ *
 * OnTheSnow: what the resorts and skiers report.
 *
 * Two pages per resort, all 40 including the Canadian four:
 *
 *   /ski-report-reviews  first-hand skier reports. Parsed with the app's
 *                        own parser (scripts/parse-reports.js) into one row
 *                        per report. Reporter names are not archived.
 *   /skireport           the resort's snow report: resort-reported snowfall
 *                        day by day, OnTheSnow's own 5-day snow forecast,
 *                        and in season base depth. RAW ONLY for now — its
 *                        parser is written once a winter page has been seen,
 *                        and runs over every page saved until then.
 * ------------------------------------------------------------------ */

import { parseReportsPage } from "../parse-reports.js";
import { fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "ots-1";
const BASE = "https://www.onthesnow.com";
const DELAY_MS = 1500;
const MIN_OK_RATIO = 0.8;

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

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  let ok = 0, tried = 0, reports = 0;
  const failures = [];
  for (const resort of resorts) {
    if (!resort.otsPath) continue;
    for (const kind of ["ski-report-reviews", "skireport"]) {
      tried++;
      try {
        const { status, text } = await fetchText(`${BASE}/${resort.otsPath}/${kind}`, { delayMs: DELAY_MS });
        if (status !== 200) throw new Error(`HTTP ${status} — otsPath "${resort.otsPath}" may be wrong`);
        await saveRaw(`${rawDir}/${resort.id}-${kind}.html.gz`, text);
        if (kind === "ski-report-reviews") {
          const rows = reportsToRows(text, { resort, fetchedAt, runId });
          rows.forEach((r) => sink.write(r));
          reports += rows.filter((r) => r.variable === "skier_report").length;
        }
        ok++;
      } catch (e) {
        failures.push(`${resort.id}/${kind}: ${e.message}`);
        log(`  ✗ onthesnow ${resort.id}/${kind} — ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
  }
  log(`onthesnow: ${ok}/${tried} pages, ${reports} skier reports`);
  return { ok: tried > 0 && ok / tried >= MIN_OK_RATIO, pages: ok, tried, skierReports: reports, failures };
}
