import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ZOOM, clampView, doubleTapTarget, fitView, minZoom, naturalSize, panBy, pinchStep, zoomAt,
} from "../src/lib/panzoom.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
// Reference phone 402 x 874; Alta's portrait picture is 435.3 x 874 reference px.
const REF = [435.29, 874];
const G = { vw: 402, vh: 874, ...naturalSize(REF, 874) };
const BAND = { side: 15, top: 64, bottom: 118 };
const FOCUS = { x0: 0.0747, y0: 0.2293, x1: 0.9293, y1: 0.7089 };   // from the test render

test("natural size: the reference height maps to the viewport height", () => {
  assert.deepEqual(naturalSize(REF, 874), { pw: 435.29, ph: 874 });
  near(naturalSize(REF, 437).pw, 217.645);
});

test("cover is the smallest zoom, on both axes", () => {
  near(minZoom(G), 1);                                          // 874 tall fills 874; 435 wide covers 402
  near(minZoom({ vw: 360, vh: 640, ...naturalSize(REF, 640) }), 360 / (435.29 * 640 / 874)); // 318 wide < 360: cover by width
  near(minZoom({ vw: 400, vh: 640, ...naturalSize(REF, 640) }), 400 / (435.29 * 640 / 874));
});

test("clamp: no gap on any side at any zoom, and zoom stays in range", () => {
  const c = clampView({ s: 3, x: 500, y: 500 }, G);
  assert.equal(c.x, 0); assert.equal(c.y, 0);
  const d = clampView({ s: 3, x: -99999, y: -99999 }, G);
  near(d.x, 402 - G.pw * 3); near(d.y, 874 - G.ph * 3);
  assert.equal(clampView({ s: 0.2, x: 0, y: 0 }, G).s, minZoom(G));
  assert.equal(clampView({ s: 99, x: 0, y: 0 }, G).s, MAX_ZOOM);
});

test("fit: the outline fills the band between header and legend, centred", () => {
  const v = fitView(G, FOCUS, BAND);
  // Reference phone: focus is 372 wide (30 + 372 + ... ) and 419 tall; width is the tight side.
  const fx0 = v.x + FOCUS.x0 * G.pw * v.s, fx1 = v.x + FOCUS.x1 * G.pw * v.s;
  const fy0 = v.y + FOCUS.y0 * G.ph * v.s, fy1 = v.y + FOCUS.y1 * G.ph * v.s;
  assert.ok(fx0 >= 15 - 1e-6 && fx1 <= 402 - 15 + 1e-6, `x ${fx0}..${fx1}`);
  assert.ok(fy0 >= 64 - 1e-6 && fy1 <= 874 - 118 + 1e-6, `y ${fy0}..${fy1}`);
  near((fx0 + fx1) / 2, 201);
  near((fy0 + fy1) / 2, 64 + (874 - 64 - 118) / 2, 0.1);   // (clamped a hair at the top edge)
  // And the picture still covers the screen
  assert.ok(v.x <= 0 && v.y <= 0 && v.x + G.pw * v.s >= 402 && v.y + G.ph * v.s >= 874);
});

test("fit without a focus is cover, centred", () => {
  const sq = { vw: 402, vh: 874, ...naturalSize([874, 874], 874) };
  const v = fitView(sq, null, null);
  assert.deepEqual(v, { s: 1, x: (402 - 874) / 2, y: 0 });
});

test("fit never zooms out past cover on a narrow, short phone", () => {
  const g = { vw: 360, vh: 640, ...naturalSize(REF, 640) };
  const v = fitView(g, FOCUS, { side: 15, top: 60, bottom: 100 });
  assert.ok(v.s >= minZoom(g) - 1e-9);
  assert.ok(v.x <= 0 && v.y <= 0 && v.x + g.pw * v.s >= 360 - 1e-6 && v.y + g.ph * v.s >= 640 - 1e-6);
});

test("zoomAt keeps the point under the finger fixed", () => {
  const v1 = fitView(G, FOCUS, BAND);
  const v0 = zoomAt(v1, v1.s * 2, 200, 400, G);
  const pt = { x: (200 - v1.x) / v1.s, y: (400 - v1.y) / v1.s };
  near((200 - v0.x) / v0.s, pt.x); near((400 - v0.y) / v0.s, pt.y);
});

test("zoom at an edge point still never shows a gap", () => {
  const v = zoomAt(fitView(G, FOCUS, BAND), 4, 0, 0, G);
  assert.ok(v.x <= 0 && v.y <= 0 && v.x >= 402 - G.pw * 4 && v.y >= 874 - G.ph * 4);
});

test("pan is clamped; at cover the portrait picture can only slide sideways", () => {
  const v0 = { s: 1, x: -16.645, y: 0 };
  const a = panBy(v0, 9999, 9999, G);
  assert.equal(a.x, 0); assert.equal(a.y, 0);
  const b = panBy(v0, -9999, -9999, G);
  near(b.x, 402 - G.pw); assert.equal(b.y, 0);
});

test("pinch: spreading zooms about the midpoint, the midpoint's travel pans", () => {
  const v0 = fitView(G, FOCUS, BAND);
  const mid = { x: 200, y: 400 };
  const z = pinchStep(v0, mid, 100, mid, 200, G);
  near(z.s, v0.s * 2);
  near((200 - z.x) / z.s, (200 - v0.x) / v0.s);
  const p = pinchStep(z, mid, 100, { x: 180, y: 380 }, 100, G);
  near(p.s, z.s);
  assert.notEqual(p.x, z.x);
  const q = pinchStep(z, mid, 0, mid, 0, G);
  assert.ok(Number.isFinite(q.s) && Number.isFinite(q.x) && Number.isFinite(q.y));
});

test("double tap toggles fit and 2.5× the fit zoom", () => {
  assert.equal(doubleTapTarget({ s: 1 }, 1), 2.5);
  assert.equal(doubleTapTarget({ s: 2.5 }, 1), 1);
  assert.equal(doubleTapTarget({ s: 1.02 }, 1), 2.5);
  assert.equal(doubleTapTarget({ s: 1.4 }, 1.4), 3.5);
  assert.equal(doubleTapTarget({ s: 1.5 }, 1.4), 1.4);
});
