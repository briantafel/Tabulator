import { test } from "node:test";
import assert from "node:assert/strict";
import { warmRatio, warmGroup } from "../scripts/projections/lib.js";
import { snowFrom } from "../scripts/blend/lib.js";

// Same cases as scripts/model/test_slr.py (warm cap) — the app and the scorer must agree.
const warm = { t: [-1.5, -0.5, 0.5, 1.5], r: [11, 9, 5, 2], promote: { "1-3": true, "4-7": false } };
test("warmRatio interpolates, no cap when cold", () => {
  assert.deepEqual([-5, 0, 1.5, 4].map((t) => warmRatio(t, warm)), [Infinity, 7, 2, 2]);
  assert.equal(warmGroup(0), "1-3"); assert.equal(warmGroup(4), "4-7");
});
test("snowFrom caps only where promoted and never raises", () => {
  const line = { a: 11.5, b: -0.36, clamp: [5, 25], warm };
  assert.ok(Math.abs(snowFrom(20, 1, line, 1) - 20 * 3.5 / 10) < 1e-9);
  assert.equal(snowFrom(20, 1, line, 5), (20 * (11.5 - 0.36)) / 10);   // 4-7 not promoted
  assert.equal(snowFrom(20, -10, line, 1), (20 * (11.5 + 3.6)) / 10);  // cold: untouched
  assert.equal(snowFrom(20, 3, line, 1), 0);
  assert.equal(snowFrom(20, 1, { a: 11.5, b: -0.36, clamp: [5, 25] }, 1), (20 * (11.5 - 0.36)) / 10); // no warm → today
});
