/* Helpers for the live Previous Runs pieces of the nightly backfill (backfill-runner.js). Pure, so they can be tested.
 *
 * Why this exists (2026-11-23, plan-near-term-models step 0). Since 11-22 about a third of the Open-Meteo requests from
 * the GitHub runner hit connect timeouts and cost ~100 s each (3 attempts, 15 s-per-attempt retry waits sized for the
 * old two-winter requests). 342 pieces then did not fit the 95-minute cap, and because the queue was model-major
 * (ECMWF, then GFS, then GEM) the GEM pieces were the ones left undone: by the morning of 11-23 only 3 of 57 resorts had
 * GEM past 11-21 and Whistler's stopped on 11-20, so the blend (which needs all three models) had no complete day after
 * that. The run could also end GREEN: hitting the time limit with nothing "failed" was not an error.
 *
 *   freshestFirst   newest window first, then model, then resort. The old order put the oldest window (which only
 *                   re-fetches a week whose data is already in) ahead of the newest, and a model's pieces in one block.
 *   runPool         N workers over a queue, so one stalled request does not hold up the rest.
 */

/** Sort live pieces so that, if the run stops early, what is left undone is the least valuable work: the final
 *  re-fetch of an older week. Order: window start (newest first), then model (in `models` order), then resort id. */
export function freshestFirst(pieces, models) {
  const rank = (m) => { const i = models.indexOf(m); return i < 0 ? models.length : i; };
  return [...pieces].sort((a, b) =>
    b.winter[0].localeCompare(a.winter[0]) || rank(a.model) - rank(b.model) || a.resort.id.localeCompare(b.resort.id));
}

/** Run fn over items with at most n at a time. fn must not throw (the runner's handler catches per piece). */
export async function runPool(items, n, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** How many live pieces the run meant to fetch but did not. `attempted` = pieces queued this run (not done in the bucket,
 *  matching the BACKFILL_ONLY filter), `ok` = fetched (first try or second). Anything left is a shortfall, whatever the
 *  reason (failed, time limit, budget, rate limit, breaker): the archive's live rows are behind and the run must say so. */
export function liveShortfall(attempted, ok) {
  return Math.max(0, attempted - ok);
}

/* 2026-11-26: the Saturday hole. Open-Meteo stamps each hour at its END, so a day's last 6-hour block (18:00-24:00 UTC)
 * needs the next day's 00:00 stamp. A week piece asked only up to its last day (always a Saturday) got 5 hours for that
 * block, toBlocks dropped it, and the verify build then dropped the whole partial day (11-07, 11-14, 11-21 never scored).
 * So a live request runs one day past the piece and the rows are cut back to the piece's own days. */
const DAY_MS = 864e5;

/** end_date to send for a live piece ending on `to` (YYYY-MM-DD): the next day. */
export function liveFetchEnd(to) {
  return new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Keep rows whose block starts on [from, to] (UTC days); with `fromHourUtc`, only blocks starting at or after that hour
 *  on day `from` (the re-fetch pieces add back just the missing 18:00 block). */
export function cutToWindow(rows, from, to, fromHourUtc = 0) {
  const lo = Date.parse(`${from}T00:00:00Z`) + fromHourUtc * 3600e3;
  const hi = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  return rows.filter((r) => { const t = Date.parse(r.valid_start); return t >= lo && t < hi; });
}

/** One re-fetch piece per resort, model and finished week: its last day, from 18:00 UTC. Fills the hole above in weeks
 *  already marked done before the fix (week starts before `before`). `windows` = liveWindows() output [start, end, final]; only final weeks (whole week stored). */
export function saturdayFixPieces(windows, before = "2026-11-22") {
  return windows.filter(([from, , final]) => final && from < before).map(([from]) => new Date(Date.parse(`${from}T00:00:00Z`) + 6 * DAY_MS).toISOString().slice(0, 10));
}
