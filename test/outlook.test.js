import { test } from "node:test";
import assert from "node:assert/strict";
import { outlook, RANGES, membersOf, titleOf } from "../src/lib/outlook.js";
import resortData from "../src/data/resorts.json" with { type: "json" };

const NOW = new Date("2026-11-01T12:00:00");
const days = (cm) => cm.map((snow, i) => ({ date: `2026-11-0${i + 1}`, snow }));
// Adjacent red segments read as one bracket, as they look on screen.
const say = (segs) => {
  let out = "", open = false;
  for (const s of segs) {
    if (s.hot && !open) { out += "["; open = true; }
    if (!s.hot && open) { out += "]"; open = false; }
    out += s.t;
  }
  return out + (open ? "]" : "");
};
const feed = (snowById) => resortData.resorts.map((r) => ({
  id: r.id, name: r.name, days: days(snowById[r.id] ?? [0, 0, 0, 0, 0, 0]),
}));

test("every resort has a range", () => {
  for (const r of resortData.resorts) assert.ok(RANGES[r.id], `${r.id} has no range`);
});

test("Brian's own example comes out as he wrote it", () => {
  const s = say(outlook(feed({
    "big-sky": [0, 10, 15, 10, 8, 0], "jackson-hole": [0, 5, 8, 6, 0, 0],
    telluride: [0, 0, 3, 4, 0, 0],
  }), { now: NOW }));
  assert.equal(s,
    'A moderate storm is moving through [the Rockies], with up to [17"] falling over ' +
    "[the next 5 days]. The best bet for snow is [the northern Rockies], with [Montana] " +
    "the strongest move right now.");
});

test("a one-state range names the resort, not the state again", () => {
  const s = say(outlook(feed({ kirkwood: [0, 20, 20, 0, 0, 0], palisades: [0, 10, 5, 0, 0, 0] }), { now: NOW }));
  assert.match(s, /best bet for snow is \[Tahoe\], with \[Kirkwood\]/);
});

test("the storm's ranges are listed in the order it reaches them", () => {
  const s = say(outlook(feed({ kirkwood: [20, 10, 0, 0, 0, 0], alta: [0, 5, 15, 0, 0, 0], telluride: [0, 0, 5, 15, 0, 0] }), { now: NOW }));
  assert.match(s, /through \[the Sierra, the Wasatch and the Rockies\]/);
});

test("a quiet week says so instead of inventing a storm", () => {
  assert.equal(say(outlook(feed({ stowe: [1, 0, 0, 0, 0, 0] }), { now: NOW })),
    "No significant snow anywhere in the next 6 days.");
});

test("days before today are not counted", () => {
  // All the snow is on the 1st; viewed from the 3rd there is none left.
  const s = say(outlook(feed({ alta: [40, 0, 0, 0, 0, 0] }), { now: new Date("2026-11-03T12:00:00") }));
  assert.match(s, /^No significant snow/);
});

test("the ranges and the closing place are tappable, nothing else is", () => {
  const segs = outlook(feed({
    kirkwood: [0, 20, 20, 0, 0, 0], palisades: [0, 10, 5, 0, 0, 0],
    alta: [0, 0, 10, 0, 0, 0], "big-sky": [0, 0, 0, 12, 0, 0],
  }), { now: NOW });
  const links = segs.filter((s) => s.link).map((s) => s.t);
  assert.deepEqual(links, ["Sierra", "Wasatch", "Rockies", "Tahoe", "Kirkwood"]);
  const kirk = segs.find((s) => s.t === "Kirkwood").link;
  assert.deepEqual(membersOf(kirk), ["kirkwood"]);
  assert.deepEqual(membersOf({ kind: "range", key: "the Wasatch" }).sort(),
    ["alta", "brighton", "powder-mountain", "snowbasin", "snowbird", "solitude"]);
});

test("a state or a part of the Rockies opens just those resorts", () => {
  const segs = outlook(feed({ "big-sky": [0, 10, 15, 10, 8, 0], "jackson-hole": [0, 5, 8, 6, 0, 0] }), { now: NOW });
  const best = segs.find((s) => s.t === "northern Rockies").link;
  assert.equal(titleOf(best), "Northern Rockies");
  assert.deepEqual(membersOf(best).sort(), ["big-sky", "grand-targhee", "jackson-hole", "sun-valley"]);
  const state = segs.find((s) => s.t === "Montana").link;
  assert.deepEqual(membersOf(state), ["big-sky"]);
});

test("Tahoe and the Eastern Sierra are the Sierra's best-bet parts", () => {
  const s = say(outlook(feed({ kirkwood: [0, 20, 20, 0, 0, 0], heavenly: [0, 15, 10, 0, 0, 0], mammoth: [0, 5, 0, 0, 0, 0] }), { now: NOW }));
  assert.match(s, /through \[the Sierra\]/, "the moving-through list stays at range level");
  assert.match(s, /best bet for snow is \[Tahoe\], with \[Kirkwood\]/, "no article before Tahoe");
});

test("the Cascades name a state when Oregon and Washington both count", () => {
  const s = say(outlook(feed({ "mt-baker": [0, 30, 20, 0, 0, 0], "mt-bachelor": [0, 25, 30, 0, 0, 0], crystal: [0, 5, 5, 0, 0, 0] }), { now: NOW }));
  assert.match(s, /through \[the Cascades\]/);
  assert.match(s, /best bet for snow is \[the Cascades\], with \[(Washington|Oregon)\]/);
});

test("Tahoe names the resort even though Mt. Rose is in Nevada", () => {
  const s = say(outlook(feed({ "mt-rose": [0, 25, 20, 0, 0, 0], northstar: [0, 20, 15, 0, 0, 0] }), { now: NOW }));
  assert.match(s, /best bet for snow is \[Tahoe\], with \[Mt\. Rose\]/);
});
