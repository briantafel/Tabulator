import { test } from "node:test";
import assert from "node:assert/strict";
import { outlook, RANGES } from "../src/lib/outlook.js";
import resortData from "../src/data/resorts.json" with { type: "json" };

const NOW = new Date("2026-11-01T12:00:00");
const days = (cm) => cm.map((snow, i) => ({ date: `2026-11-0${i + 1}`, snow }));
const say = (segs) => segs.map((s) => (s.hot ? `[${s.t}]` : s.t)).join("");
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
  assert.match(s, /best bet for snow is \[the Sierra\], with \[Kirkwood\]/);
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
