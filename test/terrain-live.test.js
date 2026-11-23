import { layoutMid, layoutMark, layoutDepth, SHEET, FULL } from "../src/lib/terrainLabels.js";
import { snowWithUnit } from "../src/lib/units.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPng } from "../scripts/maps/png.mjs";
import { readGrids, computeField, gaussianBlur, levelsFor, windowLabel, sampleAt, profileAt } from "../src/lib/terrainField.js";
import { contourRings, splitAtFrame, ringArea } from "../src/lib/terrainContours.js";
import { drawLive, sheetWindow } from "../src/lib/terrainLive.js";

const FX = new URL("./fixtures/terrain-live/", import.meta.url).pathname;
const live = JSON.parse(readFileSync(FX + "live.json", "utf8"));
const exp = JSON.parse(readFileSync(FX + "expected.json", "utf8"));
const grids = readGrids(live, readPng(readFileSync(FX + "grid.png")), readPng(readFileSync(FX + "days.png")));
const prof = JSON.parse(readFileSync(FX + "prof.json", "utf8"));
const expP = JSON.parse(readFileSync(FX + "expected-prof.json", "utf8"));
/* A height-profile map (2026-11-23) whose window sums to `cm` at the blend's height: each day cm / n at 8.0 kft,
   rising 40% per 1000 ft, never below 0 (what the Python fixture uses, scaled). */
const P = (dates, cm) => ({ ...live, rho_max: 1.5, rho_c: 0.5, prof: { z_kft: prof.z_kft,
  cm: Object.fromEntries(live.dates.map((d) => [d, prof.z_kft.map((z) => Math.max(0, (dates.includes(d) ? cm / dates.length : 0) * (1 + 0.4 * (z - 8))))])) } });

test("height profile: the app's field equals the Python twin (live_grid.field_prof) on the same bytes", () => {
  const r = computeField({ ...live, rho_max: 1.5, rho_c: 0.5, prof }, grids, expP.dates, expP.totalCm);
  assert.ok(!r.hidden && r.profile, r.hidden);
  let worst = 0;
  for (let i = 0; i < expP.F.length; i++) worst = Math.max(worst, Math.abs(r.F[i] - expP.F[i]));
  assert.ok(worst < 1e-6, `max difference ${worst} in`);
});

test("height profile: hidden when the sheet is not the number the map was drawn for, or a day has no profile", () => {
  const L = { ...live, rho_max: 1.5, rho_c: 0.5, prof };
  assert.ok(computeField(L, grids, expP.dates, expP.totalCm + 1).hidden);
  assert.ok(computeField({ ...L, prof: { ...prof, cm: { "2026-11-23": prof.cm["2026-11-23"] } } }, grids, expP.dates, 20).hidden);
});

test("old single-multiplier maps are shown only with a mild multiplier (Whistler 2026-11-23: x1.8 stretched the top to 122 in)", () => {
  assert.ok(!computeField(live, grids, exp.dates, exp.totalCm).hidden, "k ~ 1: shown");
  assert.match(computeField(live, grids, exp.dates, 20).hidden, /old single-multiplier/, "k 0.43: hidden");
  assert.match(computeField(live, grids, exp.dates, 90).hidden, /old single-multiplier/, "k 1.9: hidden");
});

test("the app's field equals the Python twin (live_grid.field) on the same bytes", () => {
  const r = computeField(live, grids, exp.dates, exp.totalCm);
  assert.ok(!r.hidden, r.hidden);
  assert.ok(Math.abs(r.k - exp.k) < 1e-9, `k ${r.k} vs ${exp.k}`);
  let worst = 0;
  for (let i = 0; i < exp.F.length; i++) worst = Math.max(worst, Math.abs(r.F[i] - exp.F[i]));
  assert.ok(worst < 1e-6, `max difference ${worst} in`);
});

test("blur matches scipy's reflect mode on a known case", () => {
  // scipy.ndimage.gaussian_filter([0,0,1,0,0] as a 5x1 row, 1.0) -> symmetric, sums to 1
  const f = new Float64Array([0, 0, 1, 0, 0]);
  gaussianBlur(f, 5, 1, 1.0);
  assert.ok(Math.abs(f.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(f[1] - f[3]) < 1e-12 && f[2] > f[1] && f[1] > f[0]);
  assert.ok(Math.abs(f[2] - 0.39894347) < 1e-7 && Math.abs(f[0] - 0.05842299) < 1e-7, f.join());  // scipy: .05842299 .24210528 .39894347
});

test("a day the grids do not have, a missing total, or a total with no NBM pattern: hidden, never guessed", () => {
  assert.ok(computeField(live, grids, ["2026-11-22", "2026-11-30"], 5).hidden);
  assert.ok(computeField(live, grids, ["2026-11-22"], NaN).hidden);
  assert.ok(computeField({ ...live, ref: { ...live.ref, a: [-50, -50, -50] } }, grids, ["2026-11-22"], 5).hidden);
  const z = computeField(live, grids, ["2026-11-22"], 0);
  assert.ok(!z.hidden && z.F.every((v) => v === 0), "a zero total is no snow, drawn as such");
});

test("no NBM pattern and under 1 in: flat at the sheet's total (\"Under 1 in\"); 1 in or more: hidden", () => {
  const dry = { ...live, low_in: 1.0, ref: { ...live.ref, a: [-50, -50, -50] } };
  const f = computeField(dry, grids, ["2026-11-22"], 1.2);          // 0.47 in
  assert.ok(!f.hidden && f.flat && f.k === null);
  assert.ok(f.F.every((v) => Math.abs(v - 1.2 / 2.54) < 1e-12), "every cell is the sheet's number");
  assert.ok(computeField(dry, grids, ["2026-11-22"], 2.6).hidden, "1.02 in with no pattern is still refused");
  assert.ok(computeField({ ...dry, low_in: undefined }, grids, ["2026-11-22"], 1.2).hidden, "older grids without low_in keep refusing");
});

test("a flat under-1-in map draws no bands, labels the sheet's number and says Under 1 in", () => {
  const dry = { ...live, low_in: 1.0, ref: { ...live.ref, a: [-50, -50, -50] } };
  const r = drawLive(dry, grids, { dates: ["2026-11-22"], totalCm: 1.2 });
  assert.ok(!r.hidden && r.nosnow && r.low, "flat is drawn terrain-only and flagged low");
  assert.equal(r.fill, ""); assert.equal(r.lines, "");
  assert.equal(r.full.depth.length, 1); assert.equal(r.full.depth[0].in, 0.5, "the one label is the sheet's number, not 0");
  assert.ok(r.mid_cm === null && r.full.marks.every((m) => m.in === null));
});

test("a sub-1-in map WITH an NBM pattern also says Under 1 in and prints no 0\" over the sheet's snow", () => {
  const r = drawLive(P(["2026-11-22"], 0.8), grids, { dates: ["2026-11-22"], totalCm: 0.8 });   // 0.3 in
  assert.ok(!r.hidden && r.nosnow && r.low);
  assert.equal(r.full.depth.length, 0);
  const z = drawLive(P(["2026-11-22"], 0), grids, { dates: ["2026-11-22"], totalCm: 0 });
  assert.ok(z.nosnow && !z.low && z.full.depth[0].in === 0, "a zero total is still No snow with its 0");
});

test("the map's amount IS the sheet's: at the forecast point and height the window sums to the total", () => {
  for (const [dates, cm] of [[["2026-11-23", "2026-11-24"], 20], [["2026-11-22"], 3.3], [live.dates, 41]]) {
    const L = P(dates, cm), r = computeField(L, grids, dates, cm);
    assert.ok(!r.hidden, r.hidden);
    assert.ok(Math.abs(profileAt(L.prof, dates, live.ref.z_kft) * 2.54 - cm) < 1e-9, "the blend's own number at its height");
  }
});

test("levels follow terrain_pilot.py's rule", () => {
  assert.deepEqual(levelsFor(3.3, 16.2), { levels: [4, 6, 8, 10, 12, 14, 16], floor: 3 });   // = terrain_pilot.py
  assert.deepEqual(levelsFor(0.9, 3.4), { levels: [1, 2, 3], floor: 0 });
  assert.deepEqual(levelsFor(2, 60).levels.length <= 14, true);
});

test("window labels", () => {
  assert.equal(windowLabel(["2026-11-22", "2026-11-23", "2026-11-27"]), "Nov 22–27");
  assert.equal(windowLabel(["2026-11-29", "2026-12-03"]), "Nov 29 – Dec 3");
  assert.equal(windowLabel(["2026-11-22"]), "Nov 22");
});

test("marching squares: a disc's ring has the disc's area, and closes on the frame where it is cut", () => {
  const w = 80, h = 80, F = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) F[j * w + i] = 30 - Math.hypot(i + 0.5 - 40, j + 0.5 - 40);
  const rings = contourRings(F, w, h, 10);           // radius 20
  assert.equal(rings.length, 1);
  assert.ok(Math.abs(ringArea(rings[0]) - Math.PI * 400) / (Math.PI * 400) < 0.01, ringArea(rings[0]));
  assert.equal(splitAtFrame(rings[0], w, h).length, 1, "a ring off the frame stays whole");
  const G = new Float64Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) G[j * w + i] = 30 - Math.hypot(i + 0.5, j + 0.5 - 40);   // centred on the left edge
  const cut = contourRings(G, w, h, 10);
  assert.equal(cut.length, 1);
  const parts = splitAtFrame(cut[0], w, h);
  assert.equal(parts.length, 1, "the half-disc's arc, without the frame edge");
  for (let i = 0; i < parts[0].length; i += 2) assert.ok(parts[0][i] > 0 || i === 0 || i === parts[0].length - 2);
});

test("drawLive: bands, contours, labels inside the outline, Base / Top from the same field", () => {
  const sheet = { snowfall: "tabulator", win: [{ date: "2026-11-23", snow: 12 }, { date: "2026-11-24", snow: 8 }] };
  const win = sheetWindow(sheet);
  assert.deepEqual(win, { dates: ["2026-11-23", "2026-11-24"], totalCm: 20 });
  const LW = P(win.dates, win.totalCm);
  const r = drawLive(LW, grids, win);
  assert.ok(!r.hidden, r.hidden);
  assert.match(r.fill, /<path d="M/);
  assert.equal(r.label, "Nov 23–24");
  const F = computeField(LW, grids, win.dates, win.totalCm).F;
  assert.equal(r.base_in, Math.round(sampleAt(F, live, 60, 150) * 10) / 10);
  assert.ok(r.range_in[0] <= r.range_in[1]);
  for (const d of r.full.depth) assert.ok(d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1);
  assert.equal(r.sheet.marks.length, 2);
  /* Mid: the header's own number at the header's elevation, inside the frame, away from the contour labels */
  assert.ok(r.full.mid, "mid label");
  assert.equal(r.full.mid.cm, 20);
  assert.equal(r.full.mid.ft, Math.round(live.ref.z_kft * 1000));
  assert.ok(r.full.mid.x >= 0 && r.full.mid.x <= 1 && r.full.mid.y >= 0 && r.full.mid.y <= 1);
  for (const d of r.full.depth) assert.ok(Math.abs(d.x - r.full.mid.x) > 0.075 || Math.abs(d.y - r.full.mid.y) > 0.04);
});

test("Mid label text is the header's text, at both units", () => {
  const L = layoutMid({ x: 0.5, y: 0.5, cm: 24.99, ft: 8379 }, false, SHEET);
  assert.equal(L.text, snowWithUnit(24.99, false));
  assert.equal(L.sub, "Mid\u20028,379 ft");
  assert.equal(layoutMid({ x: 0.5, y: 0.5, cm: 25, ft: 8379 }, true, SHEET).text, snowWithUnit(25, true));
  assert.ok(L.cx - L.w / 2 >= 0 && L.cx + L.w / 2 <= SHEET.size);
});

test("sheetWindow: only our own numbers, all of them", () => {
  assert.equal(sheetWindow({ win: [{ date: "x", snow: 1 }] }), null);
  assert.equal(sheetWindow({ snowfall: "tabulator", win: [{ date: "x", snow: null }] }), null);
  assert.equal(sheetWindow({ snowfall: "tabulator", win: [] }), null);
});

test("tags never touch or overlap: Base, Top, Mid and the depth labels, in both pictures (Brian 2026-11-22)", () => {
  const frames = (r) => [
    [r.sheet, { ...SHEET, w: SHEET.size, h: SHEET.size }],
    [r.full, { ...FULL, w: (FULL.size * live.w) / live.h, h: FULL.size }],
  ];
  for (const [dates, cm] of [[["2026-11-23", "2026-11-24"], 20], [["2026-11-22"], 3.3], [live.dates, 41], [live.dates, 160]]) {
    const r = drawLive(P(dates, cm), grids, { dates, totalCm: cm });
    for (const [f, S] of frames(r)) {
      const boxes = [];
      if (f.mid) { const m = layoutMid(f.mid, false, S); boxes.push({ cx: m.cx, cy: m.cy, w: m.w, h: m.h, n: "mid" }); }
      for (const k of f.marks) {
        const L = layoutMark(k, false, S), w = L.tag.w + S.ring / 2 + S.gap;
        boxes.push({ cx: L.flip ? L.cx - w / 2 : L.cx + w / 2, cy: L.cy, w, h: L.h, n: k.kind });
      }
      for (const d of f.depth) { const L = layoutDepth(d, false, S); boxes.push({ cx: L.cx, cy: L.cy, w: L.w, h: L.h, n: `${d.in}"` }); }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        assert.ok(Math.abs(a.cx - b.cx) * 2 >= a.w + b.w || Math.abs(a.cy - b.cy) * 2 >= a.h + b.h, `${a.n} touches ${b.n} (${cm} cm)`);
      }
    }
  }
});

test("Mid is not above the Top tag when there was room to put it below (Brian 2026-11-22)", () => {
  let moved = 0;
  for (const [dates, cm] of [[["2026-11-23", "2026-11-24"], 20], [live.dates, 41], [live.dates, 160]]) {
    const r = drawLive(P(dates, cm), grids, { dates, totalCm: cm });
    for (const [f, S] of [[r.sheet, { ...SHEET, w: SHEET.size, h: SHEET.size }], [r.full, { ...FULL, w: (FULL.size * live.w) / live.h, h: FULL.size }]]) {
      const top = f.marks.find((k) => k.kind === "top");
      if (!f.mid || !top || top.in == null) continue;
      const m = layoutMid(f.mid, false, S), t = layoutMark(top, false, S);
      if (m.cy >= t.cy) moved++;
    }
  }
  assert.ok(moved > 0, "Mid ends up level with or below Top in at least some frames");
});

test("moving Mid below Top never costs a contour label: every label that is missing touches Base, Top, Mid or another label", () => {
  for (const [dates, cm] of [[["2026-11-23", "2026-11-24"], 20], [live.dates, 41], [live.dates, 63]]) {
    const r = drawLive(P(dates, cm), grids, { dates, totalCm: cm });
    for (const [f, S] of [[r.sheet, { ...SHEET, w: SHEET.size, h: SHEET.size }], [r.full, { ...FULL, w: (FULL.size * live.w) / live.h, h: FULL.size }]]) {
      assert.ok(f.depth.length >= 1, `labels remain (${cm} cm)`);
      if (f.mid) {
        const m = layoutMid(f.mid, false, S);
        for (const d of f.depth) { const L = layoutDepth(d, false, S); assert.ok(Math.abs(L.cx - m.cx) * 2 >= L.w + m.w || Math.abs(L.cy - m.cy) * 2 >= L.h + m.h, "no overlap with Mid"); }
      }
    }
  }
});

test("v2 grids carry 16-bit height (R high, B low); v1 grids still read as 8 bits (2026-11-22)", () => {
  const mk = (r, b) => ({ width: 1, height: 1, data: Uint8ClampedArray.from([r, 255, b, 255]) });
  const days = { width: 1, height: 2, data: Uint8ClampedArray.from([0, 0, 0, 255, 0, 0, 0, 255]) };
  const meta = { gw: 1, gh: 1, cw: 1, ch: 1, dates: ["2026-11-22"], hq: [0, 65.535], q: [[0, 1, 0, 1]] };
  assert.equal(readGrids({ ...meta, v: 2 }, mk(1, 2), days).H[0].toFixed(3), "0.258");   // (1*256+2)/65535*65.535
  assert.equal(readGrids({ ...meta, v: 1 }, mk(1, 2), days).H[0].toFixed(3), (65.535 / 255).toFixed(3));
});
