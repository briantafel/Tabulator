/* What a trip's resort list remembers about how each resort got there.
 *
 * Brian, 2026-10-31: adding the Cascades to a trip and then removing them
 * should not take out a Cascades resort he had added on its own. So each
 * entry carries two facts:
 *
 *   direct  added from its own resort sheet
 *   via     the places (radar regions) that added it, by title
 *
 * Removing a place only takes back what that place added: it drops the
 * place from `via`, and the resort goes only when nothing else holds it —
 * not added directly, not added by another place (the Rockies and Colorado
 * overlap). Removing a resort from its own sheet still removes it outright.
 *
 * Entries saved before this have neither field. They were all added from a
 * resort sheet, so a missing `via` reads as direct.
 */

export const isDirect = (e) => e.direct ?? !e.via;

const strip = ({ name, total }) => ({ name, total });

/** One resort, from its own sheet. Already there → now also direct. */
export function addResort(list, resort) {
  const at = list.findIndex((e) => e.name === resort.name);
  if (at === -1) return [...list, { ...strip(resort), direct: true }];
  if (isDirect(list[at])) return list;
  return list.map((e, i) => (i === at ? { ...e, direct: true } : e));
}

/** A whole place. Resorts already in the trip keep their own standing and
 *  gain the place; the rest come in carried by it alone. */
export function addPlace(list, resorts, title) {
  let out = list;
  for (const r of resorts) {
    const at = out.findIndex((e) => e.name === r.name);
    if (at === -1) {
      out = [...out, { ...strip(r), direct: false, via: [title] }];
    } else {
      const e = out[at];
      if (e.via?.includes(title)) continue;
      out = out.map((x, i) => (i === at ? { ...x, direct: isDirect(x), via: [...(x.via ?? []), title] } : x));
    }
  }
  return out;
}

/** Undo a place: take it off every entry it added; drop the entries nothing
 *  else is holding. */
export function removePlace(list, title) {
  return list.flatMap((e) => {
    if (!e.via?.includes(title)) return [e];
    const via = e.via.filter((t) => t !== title);
    if (!isDirect(e) && via.length === 0) return [];
    return [{ ...e, via }];
  });
}

/** One resort, from its own sheet's Remove: gone, however it got there. */
export const removeResort = (list, name) => list.filter((e) => e.name !== name);

/** The place sheet shows the red X once a trip holds every one of its resorts
 *  as part of that place. */
export const holdsPlace = (list, names, title) =>
  names.every((n) => list.some((e) => e.name === n && e.via?.includes(title)));

/* ------------------------------------------------------------------
 * Watchlists. Brian, 2026-10-31: "a list that has no dates applied, so
 * data for the maximum period for which there is current data displays."
 *
 * A watchlist is still a trip — same container, same resorts, same rows —
 * with `watch: true` and no start or end. It is scored over the whole
 * forecast horizon, so it grows and shifts as the forecast does instead of
 * pointing at a week that will eventually be in the past.
 * ------------------------------------------------------------------ */

export const WATCH_LABEL = "Watchlist";

/** Turn a trip into a watchlist. The dates go, not just the flag: a
 *  watchlist that kept stale dates would quietly score them again the day
 *  someone flipped it back. */
export const toWatchlist = (trip) =>
  ({ ...trip, watch: true, start: null, end: null, label: WATCH_LABEL });

/** Give a trip dates, which also makes it not a watchlist. `label` is the
 *  rendering of the range, passed in so this file needs no date formatting. */
export const withDates = (trip, start, end, label) =>
  ({ ...trip, watch: false, start, end, label });

/** The forecast days a trip is scored over, as indexes into `dates`.
 *
 *   watchlist                 -> every day there is data for
 *   dated, inside the horizon -> exactly those days
 *   dated, outside it         -> `beyond`: nothing to score yet
 *   no dates, not a watchlist -> a trip saved before trips carried their
 *                                window; the app's default four days, so the
 *                                page means the same thing every time
 */
export function tripWindow(trip, dates) {
  const last = Math.max(0, dates.length - 1);
  if (trip.watch) return { ta: 0, tb: last, beyond: false };
  if (trip.start == null || trip.end == null) return { ta: 0, tb: Math.min(3, last), beyond: false };
  const ta = dates.indexOf(trip.start);
  const tb = dates.indexOf(trip.end);
  return { ta, tb, beyond: ta === -1 || tb === -1 };
}
