import { test } from "node:test";
import assert from "node:assert/strict";
import { FULL, SHEET, depthText, hasVectorLabels, layoutDepth, layoutMark, markText, textWidth } from "../src/lib/terrainLabels.js";

const base = { kind: "base", x: 0.27, y: 0.285, in: 24, ft: 8538 };
const top = { kind: "top", x: 0.46, y: 0.795, in: 32, ft: 10552 };

test("label text follows the Metric setting", () => {
  assert.equal(depthText(30, false), '30"');
  assert.equal(depthText(30, true), "76cm");
  assert.equal(markText(base, false), 'Base 24" · 8,538 ft');
  assert.equal(markText(top, true), "Top 81cm · 3,216 m");
});

test("sizes are Figma's: sheet 9 px marker label / 11.5 px depth, full screen 13 / 13", () => {
  assert.deepEqual([SHEET.mark, SHEET.depth, SHEET.ring, SHEET.dot], [9, 11.5, 10, 2]);
  assert.deepEqual([FULL.mark, FULL.depth, FULL.ring, FULL.dot], [13, 13, 13.4, 4.9]);
});

test('a two-digit depth box is ~29 x 17 on the sheet (Figma)', () => {
  const L = layoutDepth({ x: 0.5, y: 0.5, in: 30 }, false, SHEET);
  assert.ok(Math.abs(L.w - 29) < 3, `w ${L.w}`);
  assert.ok(Math.abs(L.h - 17) < 0.5, `h ${L.h}`);
});

test("a marker label that would run off the right edge flips to the left", () => {
  assert.equal(layoutMark(base, false, SHEET).flip, false);
  const edge = { ...top, x: 0.92 };
  const L = layoutMark(edge, false, FULL);
  assert.equal(L.flip, true);
  assert.ok(L.tx < L.cx);
  // and the whole label then stays inside the frame
  assert.ok(L.tx - textWidth(L.text, FULL.mark) >= 0);
});

test("a depth label near an edge is nudged inside the frame, never cut off", () => {
  const L = layoutDepth({ x: 0.995, y: 0.002, in: 28 }, false, SHEET);
  assert.ok(L.cx + L.w / 2 <= SHEET.size && L.cy - L.h / 2 >= 0);
});

test("vector labels need the labels-free picture and label data", () => {
  assert.equal(hasVectorLabels(null), false);
  assert.equal(hasVectorLabels({ img: "a.webp", labels: { marks: [base] } }), false);
  assert.equal(hasVectorLabels({ img_clean: "a-clean.webp", labels: { marks: [base] } }), true);
});
