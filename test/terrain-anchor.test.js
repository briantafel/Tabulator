import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorMatches } from "../src/lib/terrainAnchor.js";

const anchor = { dates: ["2026-11-22", "2026-11-23", "2026-11-24"], total_cm: 5.5 };
const win = [{ date: "2026-11-22", snow: 0.2 }, { date: "2026-11-23", snow: 1.2 }, { date: "2026-11-24", snow: 4.1 }];

test("no anchor: map shows as before", () => {
  assert.equal(anchorMatches(undefined, null), true);
});
test("same days, same total, our number: shown", () => {
  assert.equal(anchorMatches(anchor, { snowfall: "tabulator", win }), true);
});
test("sheet on Snow-Forecast's numbers: hidden", () => {
  assert.equal(anchorMatches(anchor, { win }), false);
});
test("newer blend (different sum): hidden", () => {
  assert.equal(anchorMatches(anchor, { snowfall: "tabulator", win: [win[0], win[1], { ...win[2], snow: 5 }] }), false);
});
test("a day rolled over or a narrower window: hidden", () => {
  assert.equal(anchorMatches(anchor, { snowfall: "tabulator", win: win.slice(1) }), false);
});
test("missing value is not zero: hidden", () => {
  assert.equal(anchorMatches(anchor, { snowfall: "tabulator", win: [win[0], win[1], { date: "2026-11-24", snow: null }] }), false);
});
