import { test } from "node:test";
import assert from "node:assert/strict";
import { regionTable, tripRegions, regionParagraph, surfaceChips, rankResorts, regionOf } from "../src/lib/season.js";

const R = (id, name, region) => ({ id, name, region });
const resorts = [R("alta", "Alta", "Utah"), R("snowbird", "Snowbird", "Utah"), R("brighton", "Brighton", "Utah"),
  R("palisades", "Palisades", "California"), R("kirkwood", "Kirkwood", "California"), R("vail", "Vail", "Colorado")];
const S = (new14Cm, extra = {}) => ({ new7Cm: new14Cm / 2, new14Cm, swePctMedian: 100, pctReliable: true, daysSinceDump: 3, sinceDump: { warmDays: 0, freezeThaw: 0, rainOnSnow: 0 }, asOf: "2026-11-16", ...extra });
const regionOfVail = regionOf({ id: "vail", region: "Colorado" });
const season = { resorts: { alta: S(30), snowbird: S(28), brighton: S(20), palisades: S(60), kirkwood: S(50), vail: S(90) } };

test("regions rank by recent snow; a lone resort is not a region", () => {
  const t = regionTable(resorts, season);
  assert.deepEqual(t.map((g) => g.name), ["the Sierra", "the Wasatch"]);
});

test("an empty far trip follows the leading region", () => {
  const r = tripRegions({ resorts: [] }, resorts, season);
  assert.deepEqual(r.regions.map((g) => [g.name, g.leading, g.pinned]), [["the Sierra", true, false]]);
  const later = { resorts: { ...season.resorts, alta: S(200), snowbird: S(190) } };
  assert.equal(tripRegions({ resorts: [] }, resorts, later).regions[0].name, "the Wasatch", "moves when another region pulls ahead");
});

test("adding a resort elsewhere keeps the leader and adds its region after it", () => {
  // Brian, 2026-11-17: adding a Utah resort to a Sierra-led trip used to drop the Sierra.
  const r = tripRegions({ resorts: [{ name: "Alta" }, { name: "Brighton" }] }, resorts, season);
  assert.deepEqual(r.regions.map((g) => [g.name, g.leading, g.pinned]), [["the Sierra", true, false], ["the Wasatch", false, true]]);
  assert.deepEqual(r.regions[1].rows.map((x) => x.r.name), ["Alta", "Brighton"]);
});

test("a pinned region that leads appears once, as both", () => {
  const r = tripRegions({ resorts: [{ name: "Palisades" }] }, resorts, season);
  assert.deepEqual(r.regions.map((g) => [g.name, g.leading, g.pinned]), [["the Sierra", true, true]]);
});

test("a pinned resort whose region has one station still shows", () => {
  const r = tripRegions({ resorts: [{ name: "Vail" }] }, resorts, season);
  assert.deepEqual(r.regions.map((g) => g.name), ["the Sierra", regionOfVail]);
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

import { regionAvalanche } from "../src/lib/season.js";
test("avalanche: one entry per zone, hashed Canadian zone names read as the center", () => {
  const rows = [{ r: { id: "a", name: "A" } }, { r: { id: "b", name: "B" } }, { r: { id: "c", name: "C" } }];
  const season = { avalanche: {
    a: { center: "SAC", zone: "Central Sierra Nevada", max: 2 },
    b: { center: "SAC", zone: "Central Sierra Nevada", max: 2 },
    c: { center: "Avalanche Canada", zone: "53bb614cadbd487077d867dec6007dfed090d20fbc0cbfe941451b6af2df33ed", max: null },
  } };
  const z = regionAvalanche(rows, season);
  assert.equal(z.length, 2);
  assert.deepEqual(z[0].resorts, ["A", "B"]);
  assert.equal(z[1].zone, null);
});
