import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAGS, RETIRED, REPORT_RETIRED_KEYS, FLAG_DEFAULTS, MODES, parseFlags, resolveFlags, flagProblems, effectiveFlag, nextOverride, canChoose } from "../src/lib/flags.js";

const P = "forecast.projections";

test("missing, broken or unknown values mean off", () => {
  assert.deepEqual(parseFlags(null), FLAG_DEFAULTS);
  assert.equal(parseFlags("nope")[P], "off");
  assert.equal(parseFlags({ projections: "yes" })[P], "off");
  assert.equal(parseFlags({ projection: "on" })[P], "off");
  assert.equal("extra" in parseFlags({ extra: "on" }), false);
});

test("modes and legacy booleans", () => {
  assert.equal(parseFlags({ projections: "preview" })[P], "preview");
  assert.equal(parseFlags({ projections: "on" })[P], "on");
  assert.equal(parseFlags({ projections: true })[P], "on");
  assert.equal(parseFlags({ projections: false })[P], "off");
  assert.equal(parseFlags({ [P]: true })[P], "on");
});

test("off beats every phone; preview and on respect the phone's choice", () => {
  assert.equal(effectiveFlag("off", true), false);
  assert.equal(effectiveFlag("off", null), false);
  assert.equal(effectiveFlag("preview", null), false);
  assert.equal(effectiveFlag("preview", true), true);
  assert.equal(effectiveFlag("on", null), true);
  assert.equal(effectiveFlag("on", false), false);
  assert.equal(canChoose("off"), false);
  assert.equal(canChoose("preview") && canChoose("on"), true);
});

test("picking the site's default clears the override", () => {
  assert.equal(nextOverride(true, "preview"), true);
  assert.equal(nextOverride(false, "preview"), null);
  assert.equal(nextOverride(false, "on"), false);
  assert.equal(nextOverride(true, "on"), null);
});

/* --- the resolver (switches plan, 2026-11-23) --- */

const resolve = (raw, overrides, table) => resolveFlags(parseFlags(raw, table), overrides, table);

test("no file: every switch resolves off", () => {
  for (const raw of [null, undefined, {}, "nope", []]) {
    const r = resolve(raw);
    assert.deepEqual(Object.keys(r), FLAGS.map((f) => f.key));
    for (const [k, v] of Object.entries(r)) assert.equal(v, false, `${k} with ${JSON.stringify(raw)}`);
  }
  assert.equal(resolveFlags(undefined)["terrain.map"], false);
});

test("terrain.map off: zoom, vectors and live are off whatever they say", () => {
  const r = resolve({ "terrain.map": "off", "terrain.zoom": "on", "terrain.vectors": "on", "terrain.live": "on" });
  assert.deepEqual([r["terrain.map"], r["terrain.zoom"], r["terrain.vectors"], r["terrain.live"]], [false, false, false, false]);
});

test("map on, vectors off, live on: live is off (its parent is vectors), zoom is on", () => {
  const r = resolve({ "terrain.map": "on", "terrain.zoom": "on", "terrain.vectors": "off", "terrain.live": "on" });
  assert.equal(r["terrain.map"], true);
  assert.equal(r["terrain.zoom"], true);
  assert.equal(r["terrain.vectors"], false);
  assert.equal(r["terrain.live"], false);
});

/* The plan gives forecast.longRange the parent forecast.projections in step 6 (with the day-11 floor). Step 1
   changes no behaviour, so the real table has no parent yet; the rule is tested on the step-6 table. */
const STEP6 = FLAGS.map((f) => (f.key === "forecast.longRange" ? { ...f, parent: P } : f));

test("longRange follows projections, including the phone's choice (step-6 table)", () => {
  const raw = { projections: "preview", longRange: "on" };
  assert.equal(resolve(raw, {}, STEP6)["forecast.longRange"], false, "preview, no override");
  assert.equal(resolve(raw, { [P]: true }, STEP6)["forecast.longRange"], true, "preview, phone opted in");
  assert.equal(resolve({ projections: "on", longRange: "on" }, { [P]: false }, STEP6)["forecast.longRange"], false, "on, phone opted out");
  // Today's table: no parent, so longRange is what the file says, as before this change.
  assert.equal(FLAGS.find((f) => f.key === "forecast.longRange").parent, null);
  assert.equal(resolve(raw)["forecast.longRange"], true);
});

test("snowfall on but this phone chose Snow-Forecast: bands are off", () => {
  const r = resolve({ snowfall: "on", bands: "on" }, { "forecast.snowfall": false });
  assert.equal(r["forecast.snowfall"], false);
  assert.equal(r["forecast.bands"], false);
  assert.equal(resolve({ snowfall: "on", bands: "on" })["forecast.bands"], true);
});

test("projections off beats a phone that opted in, and takes its children with it", () => {
  const r = resolve({ projections: "off", longRange: "on" }, { [P]: true }, STEP6);
  assert.equal(r[P], false);
  assert.equal(r["forecast.longRange"], false);
});

test("\"preview\" on a file-only switch means off", () => {
  for (const f of FLAGS.filter((x) => x.kind === "file" && !x.parent)) {
    assert.equal(resolve({ [f.key]: "preview" })[f.key], false, f.key);
    assert.equal(resolve({ [f.key]: "on" })[f.key], true, f.key);
  }
});

test("legacy keys: old name honoured, new name wins, retired and unknown ignored", () => {
  assert.equal(parseFlags({ terrainMap: "on" })["terrain.map"], "on");
  assert.equal(parseFlags({ terrainMap: "on", "terrain.map": "off" })["terrain.map"], "off");
  assert.equal(parseFlags({ terrainMap: "off", "terrain.map": "on" })["terrain.map"], "on");
  // A bad value under the new name is off; it does not fall back to the old name's "on".
  assert.equal(parseFlags({ terrainMap: "on", "terrain.map": "of" })["terrain.map"], "off");
  const table = [{ key: "terrain.map", kind: "file", legacy: "terrainMap", parent: null }];
  assert.deepEqual(parseFlags({ oldThing: "on", "terrain.nope": "on" }, table), { "terrain.map": "off" });
  // RETIRED is empty in step 1; a retired name is simply not in the table, so it is never read.
  const retired = ["oldThing"];
  assert.equal("oldThing" in parseFlags({ oldThing: "on" }), false);
  assert.deepEqual(flagProblems({ oldThing: "on" }, { table, retired, reportRetired: true }), ['"oldThing" is retired; delete it']);
  // Until step 8 a retired key still in flags.json is tolerated (Brian deletes it by hand), not a problem.
  assert.equal(REPORT_RETIRED_KEYS, false, "flip in step 8 together with deleting the old keys from flags.json");
  assert.deepEqual(flagProblems({ oldThing: "on" }, { table, retired, reportRetired: false }), []);
  assert.deepEqual(flagProblems({ oldThing: "on" }, { table, retired }), []);
});

test("slr (step 3) and blend (step 4) are retired: in RETIRED, not in the table, their flags.json keys are ignored and not a problem", () => {
  for (const name of ["slr", "blend"]) {
    assert.ok(RETIRED.includes(name), name);
    assert.ok(!FLAGS.some((f) => f.key === name || f.legacy === name), name);
    for (const v of ["on", "off", "preview"]) {
      assert.equal(name in parseFlags({ [name]: v }), false);
      assert.equal(name in resolve({ [name]: v }), false);
      assert.deepEqual(flagProblems({ [name]: v }), []);
    }
    assert.deepEqual(parseFlags({ [name]: "off" }), FLAG_DEFAULTS, `a leftover ${name}: off changes nothing else`);
  }
});

test("table integrity: parents exist, come first, no cycles, names unique, no retired name reused", () => {
  const keys = FLAGS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, "keys unique");
  const names = FLAGS.flatMap((f) => (f.legacy ? [f.key, f.legacy] : [f.key]));
  assert.equal(new Set(names).size, names.length, "a legacy name is unique and never another switch's key");
  for (const n of names) assert.ok(!RETIRED.includes(n), `${n} is retired and must not be reused`);
  const seen = new Set();
  for (const f of FLAGS) {
    assert.ok(["row", "file", "legacy"].includes(f.kind), `${f.key} kind`);
    if (f.parent) {
      assert.ok(keys.includes(f.parent), `${f.key}: parent ${f.parent} exists`);
      assert.ok(seen.has(f.parent), `${f.key}: parent ${f.parent} comes before it`);
    }
    seen.add(f.key);
    // No cycles: walking up from any switch ends.
    const path = new Set([f.key]);
    for (let p = f.parent; p; p = FLAGS.find((x) => x.key === p).parent) {
      assert.ok(!path.has(p), `cycle through ${f.key}`);
      path.add(p);
    }
    if (!f.retiring) assert.match(f.key, /^(forecast|radar|terrain|season|weather)\.[a-z][A-Za-z]*$/, `${f.key} is area.feature`);
  }
  // Rows keep the storage keys App.jsx has always used (no localStorage migration).
  const storage = Object.fromEntries(FLAGS.filter((f) => f.storage).map((f) => [f.key, f.storage]));
  assert.deepEqual(storage, { [P]: "projections", "forecast.snowfall": "snowfall", "forecast.temps": "temps", weatherSource: "wxSource", "season.shapingUp": "season" });
  assert.deepEqual(FLAGS.filter((f) => f.retiring).map((f) => f.key), ["weatherSource"]);
  assert.equal(FLAGS.length, 12);
});

test("a circular or missing parent is never on", () => {
  const table = [
    { key: "a.x", kind: "file", legacy: null, parent: "a.y" },
    { key: "a.y", kind: "file", legacy: null, parent: "a.x" },
    { key: "a.z", kind: "file", legacy: null, parent: "a.gone" },
  ];
  assert.deepEqual(resolveFlags({ "a.x": "on", "a.y": "on", "a.z": "on" }, {}, table), { "a.x": false, "a.y": false, "a.z": false });
});

test("flagProblems fixtures", () => {
  assert.deepEqual(flagProblems(null), ["flags.json is not a JSON object"]);
  assert.deepEqual(flagProblems([]), ["flags.json is not a JSON object"]);
  assert.deepEqual(flagProblems({}), []);
  assert.deepEqual(flagProblems({ "terrain.map": "on", "terrain.zoom": "on" }), []);
  assert.deepEqual(flagProblems({ terrianMap: "on" }), ['"terrianMap" is not a known switch (ignored)']);
  assert.deepEqual(flagProblems({ "terrain.map": "yes" }), ['"terrain.map": "yes" is not off, preview or on (read as off)']);
  assert.deepEqual(flagProblems({ "radar.peakResort": "preview" }), ['"radar.peakResort" is "preview", which means off for a switch with no Settings row']);
  assert.deepEqual(flagProblems({ "terrain.map": "off", "terrain.zoom": "on" }), ['"terrain.zoom" is on but its parent "terrain.map" is off, so it is off']);
  assert.deepEqual(flagProblems({ terrainMap: "preview", terrainLive: "on", terrainVectors: "on" }), [
    '"terrain.map" is "preview", which means off for a switch with no Settings row',
    '"terrain.vectors" is on but its parent "terrain.map" is preview, so it is off',
  ]);
  assert.deepEqual(flagProblems({ snowfall: "off", bands: "on" }), ['"forecast.bands" is on but its parent "forecast.snowfall" is off, so it is off']);
  // A row parent on "preview" is fine: phones can opt in.
  assert.deepEqual(flagProblems({ projections: "preview", longRange: "on" }), []);
  assert.deepEqual(flagProblems({ terrainMap: "on", "terrain.map": "off" }), ['"terrain.map" ("off") and its old name "terrainMap" ("on") disagree; "terrain.map" wins']);
  assert.deepEqual(flagProblems({ terrainMap: true, "terrain.map": "on" }), []);
});

/* Today's public/flags.json (main 8371345, 2026-11-23), copied here rather than read from disk: a test on the
   live file would block the deploy of an emergency edit to it (switches plan). scripts/check-flags.js checks
   the live file in its own workflow. */
const TODAY = {
  projections: "preview", temps: "on", slr: "on", blend: "on", weatherSource: "off", season: "on", snowfall: "on",
  bands: "on", peakResort: "on", terrainMap: "on", terrainZoom: "on", terrainVectors: "on", terrainLive: "on", longRange: "on",
};

test("today's flags.json resolves exactly as the old inline App.jsx logic did", () => {
  assert.deepEqual(flagProblems(TODAY), []);
  /* Worked by hand from the App.jsx lines this change replaced:
       projections = effectiveFlag("preview", ov)            → ov === true
       wx row offered = canChoose("off")                      → false
       tempsOn  = effectiveFlag("on", ov)                     → ov !== false   (then && feed.temps, unchanged)
       seasonOn = effectiveFlag("on", ov)                     → ov !== false   (then && feed.season, unchanged)
       snowOn   = effectiveFlag("on", ov)                     → ov !== false   (then && feed.blend, unchanged)
       bandsOn  = "on" !== "off" → true, only ever read when snowOn, so the effective value is snowOn
       peakOn, terrainOn, terrainZoomOn, terrainVectorsOn, terrainLiveOn = true
       longRange shown = "on" !== "off" → true (then && feed.longrange, unchanged)
       slrOn = projections && "on" !== "off" → projections    (then && projections.slr, unchanged; since step 3 the
               "on" !== "off" term is gone, and "on" is what today's file says, so the value is the same)
       blend file fetched = "on" !== "off" → true; since step 4 it is always fetched (same outcome) */
  const expectFor = (ov) => {
    const proj = ov.p === true;
    const snow = ov.s !== false;
    return {
      [P]: proj, "forecast.snowfall": snow, "forecast.bands": snow, "forecast.temps": ov.t !== false,
      weatherSource: false, "season.shapingUp": ov.n !== false,
      "radar.peakResort": true, "terrain.map": true, "terrain.zoom": true, "terrain.vectors": true, "terrain.live": true,
      "forecast.longRange": true,
    };
  };
  for (const p of [null, true, false]) for (const s of [null, true, false]) for (const t of [null, true, false]) for (const n of [null, true, false]) {
    const got = resolve(TODAY, { [P]: p, "forecast.snowfall": s, "forecast.temps": t, "season.shapingUp": n });
    assert.deepEqual(got, expectFor({ p, s, t, n }), JSON.stringify({ p, s, t, n }));
  }
  // The modes App.jsx hands to Settings rows and nextOverride are unchanged too.
  const m = parseFlags(TODAY);
  assert.deepEqual([m[P], m["forecast.temps"], m["season.shapingUp"], m["forecast.snowfall"], m.weatherSource], ["preview", "on", "on", "on", "off"]);
  assert.ok(Object.values(m).every((v) => MODES.includes(v)));
});
