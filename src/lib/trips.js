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
