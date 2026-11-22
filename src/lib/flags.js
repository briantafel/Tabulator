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

/* Site-wide switches, added 2026-11-03.
 *
 * Brian: "I want to be able to easily undo these projection changes and
 * toggle the currently live forecast-only site back on."
 *
 * Two layers, deliberately:
 *
 *  - public/flags.json is the SITE-WIDE switch. It decides what everyone sees.
 *    Brian can flip it from the GitHub app; the next deploy picks it up. A
 *    missing or broken file means every switch is off — the live app as it
 *    was — never a crash.
 *  - Settings holds a PER-DEVICE override, stored like Units and Weather. It
 *    lets Brian try the new thing (or get the old one back) on his own phone
 *    without changing it for anyone else. Choosing the same value as the site
 *    clears the override, so the device goes back to following the site.
 *
 * Unlike ?copy= above, these are visible in Settings rather than URL-only.
 */

/* Each switch has three site-wide states (Brian, 2026-11-03):
 *   "off"      nobody sees it, whatever their phone says — the emergency stop.
 *   "preview"  off by default; a phone can switch it on in Settings.
 *   "on"       on by default; a phone can switch it off in Settings.
 * Legacy booleans are read as true → "on", false → "off". */
export const MODES = Object.freeze(["off", "preview", "on"]);
/* temps: our temperature model (lib/temps.js), Brian 2026-11-11. */
/* weatherSource: the Settings → Weather row (government vs Snow-Forecast
   sky). Hidden by default since 2026-11-11 (Brian); "preview" brings it back. */
/* slr (2026-11-15): days 7–10 snow from Open-Meteo rescaled by our fitted
   snow-to-liquid ratio instead of its flat 7:1. Needs projections on. */
/* season (2026-11-17): Shaping up on trips past the forecast, from
   public/season.json (scripts/season). */
/* snowfall (2026-11-18): our snowfall (lib/ours.js applySnowfall) in place of
   Snow-Forecast's on its six days. Needs blend not "off". */
/* bands (2026-11-18): calibrated likely/possible bands for our forecast; "off" reverts to the ensemble spread. */
/* peakResort (2026-11-19): the radar headline names the resort the "up to"
   amount belongs to ("up to 39\" at Kirkwood"), so it can't read as the best
   bet's number. No Settings row; "off" reverts to the old sentence. */
/* terrainMap (2026-11-19): Snow by terrain on the resort sheet, for resorts in
   public/terrain/index.json (Alta first). No Settings row; "off" removes it. */
/* terrainZoom (2026-11-19): the expand button on Snow by terrain and its
   fullscreen pan/zoom map. Needs terrainMap on. No Settings row; "off" removes the button. */
/* terrainVectors (2026-11-20): Snow by terrain labels (snow depth, Base / Top) drawn by the app as
   vectors over a labels-free picture, sized from Figma. Needs terrainMap. "off" restores the picture
   with the labels baked in. No Settings row. */
/* terrainLive (2026-11-22): the Snow by terrain map drawn by the app from per-day grids, for the days the sheet shows
   (resorts whose index entry has `live`; Jackson Hole first). Needs terrainMap and terrainVectors. "off" restores the
   finished pictures (hidden when their window is not the sheet's). No Settings row. */
export const FLAG_DEFAULTS = Object.freeze({ projections: "off", temps: "off", weatherSource: "off", slr: "off", blend: "off", season: "off", snowfall: "off", bands: "off", peakResort: "off", terrainMap: "off", terrainZoom: "off", terrainVectors: "off", terrainLive: "off" });

/** Only known keys and known modes. Anything else is "off", so a typo in the
 *  JSON can never switch something on by accident. */
export function parseFlags(raw) {
  const out = { ...FLAG_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(FLAG_DEFAULTS)) {
    const v = raw[k];
    if (v === true) out[k] = "on";
    else if (v === false) out[k] = "off";
    else if (MODES.includes(v)) out[k] = v;
  }
  return out;
}

/** What a phone is allowed to choose under a site mode. */
export const canChoose = (mode) => mode === "preview" || mode === "on";

/** The value in force on this device. "off" beats any override. */
export function effectiveFlag(mode, override) {
  if (!canChoose(mode)) return false;
  return typeof override === "boolean" ? override : mode === "on";
}

/** What to store after a tap in Settings. Picking the site's own default
 *  stores nothing (null), so a later site-wide change still reaches this
 *  device. */
export function nextOverride(choice, mode) {
  return choice === (mode === "on") ? null : choice;
}
