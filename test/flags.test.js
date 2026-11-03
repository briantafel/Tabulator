import { test } from "node:test";
import assert from "node:assert/strict";
import { FLAG_DEFAULTS, parseFlags, effectiveFlag, nextOverride } from "../src/lib/flags.js";

test("missing or broken flags file means everything off", () => {
  assert.deepEqual(parseFlags(null), FLAG_DEFAULTS);
  assert.deepEqual(parseFlags("nope"), FLAG_DEFAULTS);
  assert.equal(parseFlags({}).projections, false);
});

test("only booleans switch a flag; typos and strings do not", () => {
  assert.equal(parseFlags({ projections: true }).projections, true);
  assert.equal(parseFlags({ projections: "true" }).projections, false);
  assert.equal(parseFlags({ projection: true }).projections, false);
  assert.equal("extra" in parseFlags({ extra: true }), false);
});

test("a device override wins over the site; none follows the site", () => {
  assert.equal(effectiveFlag(false, null), false);
  assert.equal(effectiveFlag(true, null), true);
  assert.equal(effectiveFlag(false, true), true);
  assert.equal(effectiveFlag(true, false), false);
});

test("picking the site's own value clears the override", () => {
  assert.equal(nextOverride(true, false), true);
  assert.equal(nextOverride(false, false), null);
  assert.equal(nextOverride(false, true), false);
  assert.equal(nextOverride(true, true), null);
});
