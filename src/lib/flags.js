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
/* The switch table (2026-11-23, switches cleanup step 1; plan: claude/switches-plan-2026-11-23.md).
 *
 * One row per switch, in dependency order (a parent always comes before its children). Fields:
 *   key       the name in public/flags.json, area.feature (areas: forecast, radar, terrain, season, weather).
 *   legacy    the old flags.json name, still read so the file and the code can change one at a time. The new
 *             key wins when both are present; the old one is honoured otherwise. Removed in step 8.
 *   kind      "row"    off | preview | on, with a per-device override from a Settings row (effectiveFlag).
 *             "file"   a kill switch in flags.json only: on means "on"; anything else (including "preview") is off.
 *             "legacy" a retiring switch that keeps its old rule until its step: on unless "off".
 *   parent    the switch this one needs. A child counts as on only when its parent resolves on. Declared here,
 *             never implied by the name.
 *   storage   the per-device override's localStorage key (unchanged: no migration, store.js VERSION untouched).
 *   retiring  true for weatherSource, which keeps its current name and rule until step 7.
 *
 * Data gates (feed.temps, feed.blend + blendFresh, feed.season, longrange freshness and promoted leads) are not
 * here: they stay where the data is used. This table says only what the switches allow.
 *
 * What each one is:
 *   forecast.projections (2026-11-03) days 7–10 appended to every resort (lib/projections.js).
 *   forecast.snowfall (2026-11-18) our snowfall (lib/ours.js applySnowfall) in place of Snow-Forecast's on its six
 *     days. Also needs the blend file loaded (data gate in App.jsx).
 *   forecast.bands (2026-11-18) calibrated likely/possible bands for our forecast; off reverts to the ensemble
 *     spread. Only ever read inside our snowfall, so its parent is forecast.snowfall.
 *   forecast.temps (2026-11-11) our temperature model (lib/temps.js). Still a Settings row in step 1; the plan
 *     makes it file-only in step 5.
 *   weatherSource (2026-11-11) shows the Settings → Weather row (government vs Snow-Forecast sky). Its resolved
 *     value means "the row is offered"; the phone's choice (wxSource) is a source name, not a boolean, and is
 *     applied in App.jsx. Retiring (step 7).
 *   season.shapingUp (2026-11-17) Shaping up on trips past the forecast, from public/season.json. Still a
 *     Settings row in step 1; file-only from step 7.
 *   radar.peakResort (2026-11-19) the radar headline names the resort the "up to" amount belongs to.
 *   terrain.map (2026-11-19) Snow by terrain on the resort sheet, for resorts in public/terrain/index.json.
 *   terrain.zoom (2026-11-19) the expand button and fullscreen pan/zoom map.
 *   terrain.vectors (2026-11-20) labels drawn by the app as vectors over a labels-free picture.
 *   terrain.live (2026-11-22) the map drawn by the app from per-day grids for the sheet's days.
 *   terrain.freshCycle (2026-11-23) the terrain map (and its refresh plan, in Actions) may use NOAA NBM's 06z/18z cycles, not
 *     only 00z/12z, so a map is at most ~9 h behind a run instead of ~15 h. Read by scripts/maps, not by the app.
 *   forecast.longRange (2026-11-22) odds, not inches, for the days past the sheet's last day
 *     (components/LongRange.jsx, public/longrange.json). No parent yet: the plan gives it forecast.projections
 *     in step 6, together with the day-11 floor. Adding the parent here would hide today's odds on every phone
 *     that has not opted in to projections, and step 1 changes no behaviour. */
const F = (key, kind, legacy, extra = {}) => Object.freeze({ key, kind, legacy, parent: null, storage: null, retiring: false, ...extra });
export const FLAGS = Object.freeze([
  F("forecast.projections", "row", "projections", { storage: "projections" }),
  F("forecast.snowfall", "row", "snowfall", { storage: "snowfall" }),
  F("forecast.bands", "file", "bands", { parent: "forecast.snowfall" }),
  F("forecast.temps", "row", "temps", { storage: "temps" }),
  F("weatherSource", "legacy", null, { storage: "wxSource", retiring: true }),
  F("season.shapingUp", "row", "season", { storage: "season" }),
  F("radar.peakResort", "file", "peakResort"),
  F("terrain.map", "file", "terrainMap"),
  F("terrain.zoom", "file", "terrainZoom", { parent: "terrain.map" }),
  F("terrain.vectors", "file", "terrainVectors", { parent: "terrain.map" }),
  F("terrain.live", "file", "terrainLive", { parent: "terrain.vectors" }),
  F("forecast.longRange", "file", "longRange"),
  F("terrain.freshCycle", "file", null, { parent: "terrain.map" }),
]);

/* Names that have been switches and must never be reused, so an old phone or an old flags.json can't switch a
   new feature on by accident. slr joined in step 3 and blend in step 4 (2026-11-23); weatherSource joins when
   it is retired in code (step 7), and the legacy names join it in step 8. A retired name is not in FLAGS, so
   nothing reads it. */
export const RETIRED = Object.freeze(["slr", "blend"]);

/* Whether flagProblems reports a retired key that is still in flags.json. FALSE until step 8: Brian deletes the old
   keys from flags.json by hand after the code has stopped reading them (at least 24 h), and until then the file
   still holds them and the Flags check workflow must stay green. STEP 8: set this to true (then the check goes red
   on any retired key left in the file), or delete the constant and the guard in flagProblems. */
export const REPORT_RETIRED_KEYS = false;

export const FLAG_DEFAULTS = Object.freeze(Object.fromEntries(FLAGS.map((f) => [f.key, "off"])));

const asMode = (v) => (v === true ? "on" : v === false ? "off" : MODES.includes(v) ? v : null);

/** flags.json → { [key]: "off" | "preview" | "on" } under the new keys. Only known keys and known modes:
 *  anything else is "off", so a typo can never switch something on. The new key wins when it is present,
 *  even with a bad value (then "off"): an emergency "off" typed under the new name must never be undone by
 *  an old "on" left beside it. Otherwise the legacy key is read; otherwise "off". */
export function parseFlags(raw, table = FLAGS) {
  const out = Object.fromEntries(table.map((f) => [f.key, "off"]));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const f of table) {
    const has = (k) => k && Object.prototype.hasOwnProperty.call(raw, k);
    if (has(f.key)) out[f.key] = asMode(raw[f.key]) ?? "off";
    else if (has(f.legacy)) out[f.key] = asMode(raw[f.legacy]) ?? "off";
  }
  return out;
}

/** One place that says what is on. modes: parseFlags output; overrides: { [key]: true | false | null } for the
 *  "row" switches (this device's Settings choice). Returns { [key]: boolean }.
 *  own(k) = row ? effectiveFlag(mode, override) : file ? mode === "on" : mode !== "off" (legacy);
 *  on(k)  = own(k) && (!parent || on(parent)). */
export function resolveFlags(modes, overrides = {}, table = FLAGS) {
  const byKey = new Map(table.map((f) => [f.key, f]));
  const out = {};
  const on = (key, seen) => {
    if (key in out) return out[key];
    const f = byKey.get(key);
    if (!f || seen.has(key)) return false; // an unknown or circular parent is never on
    seen.add(key);
    const m = MODES.includes(modes?.[key]) ? modes[key] : "off";
    const own = f.kind === "row" ? effectiveFlag(m, overrides?.[key]) : f.kind === "file" ? m === "on" : m !== "off";
    return (out[key] = own && (!f.parent || on(f.parent, seen)));
  };
  for (const f of table) on(f.key, new Set());
  return out;
}

/** What is wrong with a flags.json, as sentences; [] when nothing is. Run on the real file by
 *  scripts/check-flags.js in its own workflow (never in npm test, so an emergency "off" can always deploy). */
export function flagProblems(raw, { table = FLAGS, retired = RETIRED, reportRetired = REPORT_RETIRED_KEYS } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["flags.json is not a JSON object"];
  const out = [];
  const known = new Map();
  for (const f of table) {
    known.set(f.key, f);
    if (f.legacy) known.set(f.legacy, f);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (retired.includes(k)) {
      if (reportRetired) out.push(`"${k}" is retired; delete it`);
    }
    else if (!known.has(k)) out.push(`"${k}" is not a known switch (ignored)`);
    else if (asMode(v) === null) out.push(`"${k}": ${JSON.stringify(v)} is not off, preview or on (read as off)`);
  }
  const has = (k) => k && Object.prototype.hasOwnProperty.call(raw, k);
  const modes = parseFlags(raw, table);
  const byKey = new Map(table.map((f) => [f.key, f]));
  for (const f of table) {
    if (has(f.key) && has(f.legacy) && asMode(raw[f.key]) !== asMode(raw[f.legacy]))
      out.push(`"${f.key}" (${JSON.stringify(raw[f.key])}) and its old name "${f.legacy}" (${JSON.stringify(raw[f.legacy])}) disagree; "${f.key}" wins`);
    const m = modes[f.key];
    if (f.kind === "file" && m === "preview") out.push(`"${f.key}" is "preview", which means off for a switch with no Settings row`);
    const p = f.parent && byKey.get(f.parent);
    if (p) {
      const childOn = f.kind === "file" ? m === "on" : m !== "off";
      const parentOff = p.kind === "file" ? modes[p.key] !== "on" : modes[p.key] === "off";
      if (childOn && parentOff) out.push(`"${f.key}" is ${m} but its parent "${p.key}" is ${modes[p.key]}, so it is off`);
    }
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
