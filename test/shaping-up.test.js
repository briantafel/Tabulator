import { test } from "node:test";
import assert from "node:assert/strict";
import { regionTable, tripRegions, regionParagraph, surfaceChips, rankResorts } from "../src/lib/season.js";

const R = (id, name, region) => ({ id, name, region });
const resorts = [R("alta", "Alta", "Utah"), R("snowbird", "Snowbird", "Utah"), R("brighton", "Brighton", "Utah"),
  R("palisades", "Palisades", "California"), R("kirkwood", "Kirkwood", "California"), R("vail", "Vail", "Colorado")];
const S = (new14Cm, extra = {}) => ({ new7Cm: new14Cm / 2, new14Cm, swePctMedian: 100, pctReliable: true, daysSinceDump: 3, sinceDump: { warmDays: 0, freezeThaw: 0, rainOnSnow: 0 }, asOf: "2026-11-16", ...extra });
const season = { resorts: { alta: S(30), snowbird: S(28), brighton: S(20), palisades: S(60), kirkwood: S(50), vail: S(90) } };

test("regions rank by recent snow; a lone resort is not a region", () => {
  const t = regionTable(resorts, season);
  assert.deepEqual(t.map((g) => g.name), ["the Sierra", "the Wasatch"]);
});

test("an empty far trip follows the leading region", () => {
  const r = tripRegions({ resorts: [] }, resorts, season);
  assert.equal(r.dynamic, true);
  assert.equal(r.regions[0].name, "the Sierra");
  const later = { resorts: { ...season.resorts, alta: S(200), snowbird: S(190) } };
  assert.equal(tripRegions({ resorts: [] }, resorts, later).regions[0].name, "the Wasatch", "moves when another region pulls ahead");
});

test("a trip with resorts is pinned to them", () => {
  const r = tripRegions({ resorts: [{ name: "Alta" }, { name: "Brighton" }] }, resorts, season);
  assert.equal(r.dynamic, false);
  assert.deepEqual(r.regions[0].rows.map((x) => x.r.name), ["Alta", "Brighton"]);
});

test("missing values sort last, not as zero", () => {
  const rows = rankResorts([{ s: { new14Cm: null } }, { s: { new14Cm: 0 } }, { s: { new14Cm: 5 } }]);
  assert.deepEqual(rows.map((x) => x.s.new14Cm), [5, 0, null]);
});

test("the paragraph only states what the numbers carry", () => {
  const g = regionTable(resorts, season).find((x) => x.name === "the Wasatch");
  const t = regionParagraph(g, false).map((s) => s.t).join("");
  assert.match(t, /100% of its normal snowpack/);
  assert.match(t, /3 days ago/);
  assert.match(t, /stayed cold/);
  const early = regionParagraph({ ...g, swePctMedian: null, daysSinceDump: null }, false).map((s) => s.t).join("");
  assert.match(early, /too early/);
  assert.doesNotMatch(early, /last big snow day/);
});

test("surface chips", () => {
  assert.deepEqual(surfaceChips({ sinceDump: { warmDays: 2, freezeThaw: 1, rainOnSnow: 0 } }), ["2 warm days", "1 freeze–thaw"]);
});
