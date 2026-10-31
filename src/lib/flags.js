/* Preview switches — a way to put new work on the live site without it being
 * what anyone sees by default.
 *
 * Open the site with ?copy=classic and this browser remembers it; ?copy=next
 * puts the default back. Nothing else changes, nobody else is affected, and reverting
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
  /* Brian, 2026-10-31: the new voice is the default. ?copy=classic still
     brings the old sentence back in one browser, and changing this one word
     back to "classic" reverts it for everyone. */
  const v = load("copy", "next");
  return COPY.includes(v) ? v : "next";
}
