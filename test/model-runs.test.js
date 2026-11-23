import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, stale, META_MODELS } from "../scripts/blend/model-runs.js";

const A = { ecmwf_ifs025: "2026-11-22T00:00:00.000Z", gfs: "2026-11-22T06:00:00.000Z", gem: "2026-11-22T00:00:00.000Z", hrrr: "2026-11-22T09:00:00.000Z" };

test("nothing new when every model is on the run the last blend used", () => {
  assert.deepEqual(compare(A, { ...A }).changed, []);
});
test("one new run is enough", () => {
  assert.deepEqual(compare(A, { ...A, gfs: "2026-11-22T12:00:00.000Z" }).changed, ["gfs"]);
});
test("first blend, or a file with no stored runs: everything is new", () => {
  assert.equal(compare({}, A).changed.length, 4);
  assert.equal(compare(undefined, A).changed.length, 4);
});
test("a new hourly HRRR run alone is a new day-1 forecast", () => {
  assert.deepEqual(compare(A, { ...A, hrrr: "2026-11-22T10:00:00.000Z" }).changed, ["hrrr"]);
});
test("an unreadable model counts as new, loudly (never a silent skip)", () => {
  const r = compare(A, { ...A, gem: null });
  assert.deepEqual(r.changed, ["gem"]);
  assert.match(r.reasons[0], /could not read/);
});
test("stale: a model whose newest run is over 3 days old is named", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const r = stale({ ...A, gem: "2026-05-26T12:00:00.000Z", gfs: "2026-11-23T06:00:00.000Z", hrrr: null }, now);
  assert.ok(r.some((x) => x.startsWith("gem:")));
  assert.ok(!r.some((x) => x.startsWith("gfs:") || x.startsWith("hrrr:")));
});
test("gem watches the live GDPS domain, not the frozen one", () => {
  assert.equal(META_MODELS.gem, "cmc_gem_gdps_15km");
});
