import { test } from "node:test";
import assert from "node:assert/strict";
import { regionTable, tripRegions, regionParagraph, surfaceChips, rankResorts, regionOf } from "../src/lib/season.js";

const R = (id, name, region) => ({ id, name, region });
const resorts = [R("alta", "Alta", "Utah"), R("snowbird", "Snowbird", "Utah"), R("brighton", "Brighton", "Utah"),
  R("palisades", "Palisades", "California"), R("kirkwood", "Kirkwood", "California"), R("vail", "Vail", "Colorado")];
/* Recent snow is the resort's own report (2026-11-18): `rep` cm over the last
   seven days, with a 15 cm day on Nov 13 when the week holds one. */
const days = (rep) => ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"]
  .map((d) => [d, d === "2026-11-13" ? rep : 0]);
const S = (rep, extra = {}) => ({ new7Cm: rep, new14Cm: rep, swePctMedian: 100, pctReliable: true, daysSinceDump: 3, sinceDump: { warmDays: 0, freezeThaw: 0, rainOnSnow: 0 }, asOf: "2026-11-16",
  reported: { last7Cm: rep, days: days(rep) }, ...extra });
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
  const r = (v) => ({ s: { new7Cm: 0, reported: v == null ? undefined : { last7Cm: v, days: [] } } });
  const rows = rankResorts([r(null), r(0), r(5)]);
  assert.deepEqual(rows.map((x) => x.s.reported?.last7Cm ?? null), [5, 0, null]);
});

test("the paragraph only states what the numbers carry", () => {
  const g = regionTable(resorts, season).find((x) => x.name === "the Wasatch");
  const t = regionParagraph(g, false).map((s) => s.t).join("");
  assert.match(t, /100% of its normal snowpack/);
  assert.match(t, /Resorts here reported about/);
  assert.match(t, /last big day reported \(6" or more\) was Nov 13/);
  assert.match(t, /stayed cold/);
  const early = regionParagraph({ ...g, swePctMedian: null, daysSinceDump: null }, false).map((s) => s.t).join("");
  assert.match(early, /too early/);
  assert.doesNotMatch(early, /stayed cold/);
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

import { vsNormal } from "../src/lib/season.js";
test("vs normal: % when meaningful, else the season's rank, else early season", () => {
  assert.equal(vsNormal({ pctReliable: true, swePctMedian: 120 }), "120% of normal");
  assert.equal(vsNormal({ pctReliable: false, swePctMedian: 300, rank: { position: 2, of: 36 } }), "2nd-biggest start of 36");
  assert.equal(vsNormal({ rank: { position: 3, of: 36 } }, { short: true }), "3rd of 36");
  assert.equal(vsNormal({}), "early season");
});
test("paragraph uses the rank when % of normal is not yet meaningful", () => {
  const t = regionParagraph({ name: "the Sierra", swePctMedian: null, rankShare: 1 / 36, rankOf: 36, depthPctMedian: 180 }, false).map((s) => s.t).join("");
  assert.match(t, /The Sierra is having its biggest start in 36 seasons/);
  assert.match(t, /180% of its normal depth/);
});

test("a big % of normal carries the rank beside it", () => {
  const t = regionParagraph({ name: "the Sierra", swePctMedian: 236, rankShare: 11 / 37, rankOf: 37 }, false).map((s) => s.t).join("");
  assert.match(t, /236% of its normal snowpack to date, its 11th-biggest start in 37 seasons\./);
});

import { persistentLayerSegs } from "../src/lib/season.js";
test("trips name a persistent weak layer only, never a rating", () => {
  const rows = [{ r: { id: "a", name: "A" } }, { r: { id: "b", name: "B" } }, { r: { id: "c", name: "C" } }];
  const txt = (s) => s.map((x) => x.t).join("");
  const season = { avalanche: {
    a: { center: "Sierra Avalanche Center", zone: "Central Sierra Nevada", max: 2, persistent: true, link: "https://x" },
    b: { center: "Sierra Avalanche Center", zone: "Central Sierra Nevada", max: 2, persistent: true, link: "https://x" },
  } };
  const segs = persistentLayerSegs(rows, season);
  assert.equal(txt(segs), " The Sierra Avalanche Center is tracking a persistent weak layer. These can last for weeks, so it is worth watching all the way to your trip.");
  assert.equal(segs[1].href, "https://x");
  assert.doesNotMatch(txt(segs), /Moderate|\b2\b/);
  season.avalanche.c = { center: "Avalanche Canada", zone: null, max: 3, persistent: true, link: "https://y" };
  assert.match(txt(persistentLayerSegs(rows, season)), /Avalanche Canada and the Sierra Avalanche Center are tracking/);
  assert.equal(persistentLayerSegs(rows, { avalanche: { a: { center: "Utah Avalanche Center", max: 3, persistent: false } } }), null);
});

test("avalanche zones: CAIC resorts split when ratings differ; Canada's hashed zones stay apart", () => {
  const rows = ["v", "b", "t", "x", "y"].map((id) => ({ r: { id, name: id.toUpperCase() } }));
  const season = { avalanche: {
    v: { center: "Colorado Avalanche Information Center", zone: "CAIC zone", max: 1, bands: { upper: 1, middle: 1, lower: 1 } },
    b: { center: "Colorado Avalanche Information Center", zone: "CAIC zone", max: 1, bands: { upper: 1, middle: 1, lower: 1 } },
    t: { center: "Colorado Avalanche Information Center", zone: "CAIC zone", max: 2, bands: { upper: 2, middle: 2, lower: 1 }, problems: ["Wind Slab"] },
    x: { center: "Avalanche Canada", zone: "53bb614cadbd487077d867dec6007dfed090d20fbc0cbfe941451b6af2df33ed", max: null },
    y: { center: "Avalanche Canada", zone: "afe9ffd14c0637d10e2530857f8e7a8cba0277f33351d3b31c8f37f4111c6ecf", max: null },
  } };
  const z = regionAvalanche(rows, season);
  assert.equal(z.length, 4);
  assert.deepEqual(z[0].resorts, ["T"]);
  assert.deepEqual(z[1].resorts, ["V", "B"]);
  assert.ok(z.slice(2).every((x) => x.zone === null && x.resorts.length === 1));
});

import { reported } from "../src/lib/season.js";
test("reported recent snow: zeros all week while the station saw a storm = not reporting, never 0", () => {
  const closed = { new7Cm: 61, reported: { last7Cm: 0, days: [["2026-11-17", 0]] } };
  assert.equal(reported(closed).last7Cm, null);
  assert.equal(reported(closed).notReporting, true);
  const dry = { new7Cm: 2, reported: { last7Cm: 0, days: [["2026-11-17", 0]] } };
  assert.equal(reported(dry).last7Cm, 0);
  const r = reported({ reported: { last7Cm: 61, days: [["2026-11-14", 35.56], ["2026-11-16", 12.7], ["2026-11-17", 12.7]] } });
  assert.deepEqual([r.last7Cm, r.lastBigDay, r.daysSinceBig, r.lastDay], [61, "2026-11-14", 3, "2026-11-17"]);
  assert.equal(reported({}), null);
});
