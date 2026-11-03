import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAG_DEFAULTS, parseFlags, effectiveFlag, nextOverride, canChoose } from "../src/lib/flags.js";

test("missing, broken or unknown values mean off", () => {
  assert.deepEqual(parseFlags(null), FLAG_DEFAULTS);
  assert.equal(parseFlags("nope").projections, "off");
  assert.equal(parseFlags({ projections: "yes" }).projections, "off");
  assert.equal(parseFlags({ projection: "on" }).projections, "off");
  assert.equal("extra" in parseFlags({ extra: "on" }), false);
});

test("modes and legacy booleans", () => {
  assert.equal(parseFlags({ projections: "preview" }).projections, "preview");
  assert.equal(parseFlags({ projections: "on" }).projections, "on");
  assert.equal(parseFlags({ projections: true }).projections, "on");
  assert.equal(parseFlags({ projections: false }).projections, "off");
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
