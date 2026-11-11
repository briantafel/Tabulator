import { test } from "node:test";
import assert from "node:assert/strict";
import { guideValues } from "../src/lib/guides.js";

// Plot limit is ~1.13 × the tallest bar (RangeChart's geometry).
const lim = (maxV) => maxV * 150 / 132.5;

test("small weeks still get guides (Crested Butte, 2026-11-10)", () => {
  assert.deepEqual(guideValues(lim(1)), [0.5, 1]);
  assert.deepEqual(guideValues(lim(2.4)), [1, 2]);
  assert.deepEqual(guideValues(lim(4.3)), [2, 4]);
});

test("every week gets 2–3 guides, all inside the plot", () => {
  for (let m = 1; m <= 120; m += 0.7) {
    const g = guideValues(lim(m));
    assert.ok(g.length >= 2 && g.length <= 3, `${m}: ${g}`);
    assert.ok(g.at(-1) <= lim(m) + 1e-9);
  }
  for (let m = 1; m <= 300; m += 1.3) {
    const g = guideValues(lim(m), true);
    assert.ok(g.length >= 1 && g.length <= 3, `cm ${m}: ${g}`);
  }
});

test("big weeks keep the spec's 6/12/18 and 10/20/30", () => {
  assert.deepEqual(guideValues(lim(18)), [6, 12, 18]);
  assert.deepEqual(guideValues(lim(30)), [10, 20, 30]);
});

test("empty input draws nothing", () => {
  assert.deepEqual(guideValues(0), []);
  assert.deepEqual(guideValues(NaN), []);
});
