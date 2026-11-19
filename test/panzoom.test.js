import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ZOOM, clampView, coverSize, doubleTapTarget, initialView, panBy, pinchStep, zoomAt,
} from "../src/lib/panzoom.js";

const VW = 402, VH = 874;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("cover: the picture fills the longer side and starts centred", () => {
  assert.equal(coverSize(VW, VH), 874);
  const v = initialView(VW, VH);
  assert.deepEqual(v, { s: 1, x: (402 - 874) / 2, y: 0 });
});

test("clamp: no gap on any side at any zoom, and zoom stays in range", () => {
  const c = clampView({ s: 3, x: 500, y: 500 }, VW, VH);
  assert.equal(c.x, 0); assert.equal(c.y, 0);
  const d = clampView({ s: 3, x: -99999, y: -99999 }, VW, VH);
  near(d.x, VW - 874 * 3); near(d.y, VH - 874 * 3);
  assert.equal(clampView({ s: 0.2, x: 0, y: 0 }, VW, VH).s, 1);
  assert.equal(clampView({ s: 99, x: 0, y: 0 }, VW, VH).s, MAX_ZOOM);
});

test("zoomAt keeps the point under the finger fixed", () => {
  const v0 = zoomAt(initialView(VW, VH), 2, 200, 400, VW, VH);
  // Picture point under (200, 400) before and after.
  const v1 = initialView(VW, VH);
  const pt = { x: (200 - v1.x) / v1.s, y: (400 - v1.y) / v1.s };
  near((200 - v0.x) / v0.s, pt.x, 1e-6); near((400 - v0.y) / v0.s, pt.y, 1e-6);
});

test("zoom at an edge point still never shows a gap", () => {
  const v = zoomAt(initialView(VW, VH), 4, 0, 0, VW, VH);
  assert.ok(v.x <= 0 && v.y <= 0 && v.x >= VW - 874 * 4 && v.y >= VH - 874 * 4);
});

test("pan is clamped and a fit view can only slide sideways", () => {
  const v0 = initialView(VW, VH);
  const a = panBy(v0, 9999, 9999, VW, VH);
  assert.equal(a.x, 0); assert.equal(a.y, 0);
  const b = panBy(v0, -9999, -9999, VW, VH);
  near(b.x, VW - 874); assert.equal(b.y, 0);
});

test("pinch: spreading zooms about the midpoint, the midpoint's travel pans", () => {
  const v0 = initialView(VW, VH);
  const mid = { x: 200, y: 400 };
  const z = pinchStep(v0, mid, 100, mid, 200, VW, VH);
  near(z.s, 2);
  const pt0 = (200 - v0.x) / v0.s;
  near((200 - z.x) / z.s, pt0, 1e-6);
  const p = pinchStep(z, mid, 100, { x: 180, y: 380 }, 100, VW, VH);
  near(p.s, z.s);
  assert.notEqual(p.x, z.x);
  // A bad distance (fingers on the same pixel) degrades to a plain pan, never NaN.
  const q = pinchStep(z, mid, 0, mid, 0, VW, VH);
  assert.ok(Number.isFinite(q.s) && Number.isFinite(q.x) && Number.isFinite(q.y));
});

test("double tap toggles fit and 2.5×", () => {
  assert.equal(doubleTapTarget({ s: 1 }), 1 * 2.5);
  assert.equal(doubleTapTarget({ s: 2.5 }), 1);
  assert.equal(doubleTapTarget({ s: 1.02 }), 2.5);
});
