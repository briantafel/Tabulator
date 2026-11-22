import { test } from "node:test";
import assert from "node:assert/strict";
import { compare } from "../scripts/blend/model-runs.js";

const A = { ecmwf_ifs025: "2026-11-22T00:00:00.000Z", gfs: "2026-11-22T06:00:00.000Z", gem: "2026-11-22T00:00:00.000Z" };

test("nothing new when every model is on the run the last blend used", () => {
  assert.deepEqual(compare(A, { ...A }).changed, []);
});
test("one new run is enough", () => {
  assert.deepEqual(compare(A, { ...A, gfs: "2026-11-22T12:00:00.000Z" }).changed, ["gfs"]);
});
test("first blend, or a file with no stored runs: everything is new", () => {
  assert.equal(compare({}, A).changed.length, 3);
  assert.equal(compare(undefined, A).changed.length, 3);
});
test("an unreadable model counts as new, loudly (never a silent skip)", () => {
  const r = compare(A, { ...A, gem: null });
  assert.deepEqual(r.changed, ["gem"]);
  assert.match(r.reasons[0], /could not read/);
});
