/* ------------------------------------------------------------------ *
 * One breaker per source, so one broken source can't stop the others.
 *
 * Until 2026-11-03 the backfill stopped the whole run after 5 failures in
 * a row, counted across every source. Once the older pieces were done, the
 * 16 new Canadian OnTheSnow history pieces sat at the front of each night's
 * queue — so if they failed, the run stopped before the Open-Meteo pieces
 * behind them were ever tried.
 *
 * Now each source has its own count: SNOTEL, OnTheSnow history, and each
 * Open-Meteo model separately (a bad GEM name must not stop ECMWF). A
 * source that fails GROUP_LIMIT times in a row is skipped for the rest of
 * the run; every other source carries on. A success resets that source's
 * count. Skipped pieces are not marked done, so they are tried again on
 * the next run.
 * ------------------------------------------------------------------ */

export const GROUP_LIMIT = 3;

/** Which breaker a piece answers to. */
export const groupOf = (p) => (p.kind === "om" ? `om:${p.model}` : p.kind);

export function makeBreakers(limit = GROUP_LIMIT) {
  const streak = new Map();
  const open = new Map(); // group → why it was switched off

  return {
    isOpen: (g) => open.has(g),
    success(g) { streak.set(g, 0); },
    /** Count a failure; returns true when this one switches the group off. */
    failure(g, message) {
      const n = (streak.get(g) ?? 0) + 1;
      streak.set(g, n);
      if (n >= limit && !open.has(g)) {
        open.set(g, `${n} failures in a row (last: ${message})`);
        return true;
      }
      return false;
    },
    /** Switch a group off at once, for a failure that will repeat on every piece. */
    trip(g, why) { if (!open.has(g)) open.set(g, why); },
    opened: () => [...open.entries()],
  };
}
