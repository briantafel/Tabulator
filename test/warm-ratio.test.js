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

// Sub-daily split — same numbers as scripts/model/test_slr.py (hourly_ratio).
import { hourlyRatio } from "../scripts/projections/lib.js";
import { blendDay, dailyFromHourly } from "../scripts/blend/lib.js";
test("hourlyRatio: ramp and cap match slr.py", () => {
  const line = { a: 11.5, b: -0.36, clamp: [5, 25] };
  const h = { t0: -1, t1: 1, cap: 7 };
  const r = [-5, -1.5, 0, 1].map((t) => hourlyRatio(t, line, h));
  assert.ok(Math.abs(r[0] - 13.3) < 1e-9 && Math.abs(r[1] - 7) < 1e-9 && Math.abs(r[2] - 3.5) < 1e-9 && r[3] === 0, String(r));
  assert.ok(Math.abs(hourlyRatio(0, line, { t0: -1, t1: 1, cap: null }) - 11.5 / 2) < 1e-9);
});
test("snowFrom splits by hour only where promoted; shape from dailyFromHourly sums to 1", () => {
  const time = Array.from({ length: 24 }, (_, i) => `2026-11-24T${String(i + 1).padStart(2, "0")}:00`.replace("T24", "T23:59"));
  const precip = time.map((_, i) => (i < 12 ? 1 : 3)), temp = time.map((_, i) => (i < 12 ? -3 : 1.5));
  const day = [...dailyFromHourly(time.slice(0, 23).map((t, i) => `2026-11-24T${String(i + 1).padStart(2, "0")}:00`),
    { precipitation: precip.slice(0, 23), temperature_2m: temp.slice(0, 23) }, "UTC").values()][0];
  if (day) assert.ok(Math.abs(day.shape.reduce((s, [x]) => s + x, 0) - 1) < 1e-9);
  const line = { a: 11.5, b: -0.36, clamp: [5, 25], hourly: { t0: -1, t1: 1, cap: 7, promote: { "1-3": true, "4-7": false } } };
  const shape = [[0.25, -3.5], [0.75, 1.0]];   // mean T 0.5 → wet hours at +1.5 (rain), dry part at −3 (snow)
  const split = snowFrom(40, 0.5, line, 1, shape);
  assert.ok(Math.abs(split - 40 * 0.25 * (11.5 + 0.36 * 3) / 10) < 1e-9, String(split));
  assert.equal(snowFrom(40, 0.5, line, 5, shape), (40 * (11.5 - 0.18)) / 10);  // 4-7 not promoted → daily rule
  assert.equal(snowFrom(40, 0.5, line, 1, null), (40 * (11.5 - 0.18)) / 10);   // no shape → daily rule
  const b = blendDay({ a: { water: 10, t: 0, shape: [[1, 0]] }, b: { water: 10, t: 0, shape: [[0.5, -1], [0.5, 1]] } },
    { lead: 1, region: "x", params: { weights: { 1: { a: 1, b: 1 } } } });
  assert.deepEqual(b.shape, [[0.5, 0], [0.25, -1], [0.25, 1]]);
});
