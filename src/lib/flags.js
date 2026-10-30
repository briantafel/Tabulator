/* Preview switches — a way to put new work on the live site without it being
 * what anyone sees by default.
 *
 * Open the site with ?copy=next and this browser remembers it; ?copy=classic
 * puts it back. Nothing else changes, nobody else is affected, and reverting
 * the feature is deleting the flag check.
 *
 * iOS keeps a home-screen app's storage separate from Safari's, so the switch
 * has to be thrown in whichever of the two you are testing in.
 */

import { load, save } from "./store.js";

const COPY = ["classic", "next"];

export function copyVoice() {
  try {
    const q = new URLSearchParams(window.location.search).get("copy");
    if (COPY.includes(q)) save("copy", q);
  } catch {
    /* No window (tests) or no URL API — fall through to what is stored. */
  }
  const v = load("copy", "classic");
  return COPY.includes(v) ? v : "classic";
}
