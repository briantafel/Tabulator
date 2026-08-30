/* What the app remembers between visits.
 *
 * Trips, favourites and the unit setting lived in React state only, so every
 * reload threw them away — including every time the home-screen app was
 * relaunched from cold. This is the smallest thing that fixes that, and it is
 * deliberately NOT a step toward a backend: it is per-device and per-browser,
 * which is exactly the gap accounts would close later. When that day comes,
 * what is stored here is the seed to upload on first sign-in.
 *
 * Three rules, all of them because storage lies:
 *
 *  - EVERY read and write is wrapped. Private tabs, cleared site data and a
 *    few embedded contexts throw on access rather than returning null, and an
 *    app that will not start because it could not read a preference is a far
 *    worse bug than one that forgets your trips.
 *  - A read that fails returns the caller's own default, so the app renders
 *    exactly as it did before any of this existed.
 *  - The key carries a VERSION. If the shape of a trip changes, old data is
 *    ignored rather than half-parsed into a crash. Bump it and move on.
 */

const VERSION = 1;
const key = (name) => `tabulator.v${VERSION}.${name}`;

export function load(name, fallback) {
  try {
    const raw = localStorage.getItem(key(name));
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    // A stored null or a shape change must not become the app's state.
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
  } catch {
    /* Full, blocked, or unavailable. Nothing to do and nothing worth
       interrupting the user over — the session still works, it just will not
       outlive the tab. */
  }
}
