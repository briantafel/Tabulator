import { test } from "node:test";
import assert from "node:assert/strict";
import { avalancheTrend } from "../src/lib/season.js";

test("one day or none has no trend", () => {
  assert.equal(avalancheTrend([["2026-11-17", 2]]), null);
  assert.equal(avalancheTrend(null), null);
});
test("up and down name the old rating", () => {
  assert.equal(avalancheTrend([["2026-11-16", 2], ["2026-11-17", 3]]), "Up from Moderate yesterday.");
  assert.equal(avalancheTrend([["2026-11-14", 3], ["2026-11-17", 2]]), "Down from Considerable 3 days earlier.");
});
test("a steady rating counts the run", () => {
  assert.equal(avalancheTrend([["2026-11-14", 3], ["2026-11-15", 2], ["2026-11-16", 2], ["2026-11-17", 2]]), "Moderate for 3 forecasts in a row.");
});
test("missing days are dropped, not read as Low", () => {
  assert.equal(avalancheTrend([["2026-11-15", 2], ["2026-11-16", null], ["2026-11-17", 2]]), "Moderate for 2 forecasts in a row.");
});
