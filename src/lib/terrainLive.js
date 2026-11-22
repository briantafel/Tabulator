/* The app-drawn Snow by terrain map (Brian 2026-11-22): bands, contours, depth labels and Base / Top for the days
   the sheet shows, from the per-day grids (lib/terrainField.js). Same rules as scripts/maps/terrain_pilot.py:
   levels from the range inside the skiable outline, the 7-step blue ramp multiplied over the relief, one contour
   label per level on its longest stretch inside the outline, Base / Top at the lowest and highest lift terminals,
   "no snow" under an inch. Output is SVG markup in the full-screen picture's pixels plus label data in the shape
   TerrainLabels reads. */
import { computeField, levelsFor, sampleAt, windowLabel } from "./terrainField.js";
import { contourRings, splitAtFrame, workspace } from "./terrainContours.js";

export const RAMP = ["#c9dcf2", "#9fc0ea", "#6f9fe0", "#3f7bd6", "#1d5ccc", "#0d3fb0", "#06268a"];
const r1 = (v) => Math.round(v * 10) / 10;

/** The sheet's forecast days and total, or null when they cannot be ours (the map must equal the sheet). */
export function sheetWindow(sheet) {
  if (!sheet || sheet.snowfall !== "tabulator") return null;
  const days = sheet.win ?? [];
  if (!days.length || days.some((d) => typeof d.snow !== "number" || !Number.isFinite(d.snow))) return null;
  return { dates: days.map((d) => d.date), totalCm: days.reduce((s, d) => s + d.snow, 0) };
}

/** Douglas-Peucker on interleaved x,y (grid units), keeping both ends. SIMPLIFY = 0.15 cell = 0.6 picture px:
 *  invisible at any zoom the full-screen view allows, and about a third of the markup. */
export const SIMPLIFY = 0.15;
export function simplify(pts, tol = SIMPLIFY) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
      const d = L === 0 ? Math.hypot(px, py) : Math.abs(dx * py - dy * px) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

function pathOf(pts, cell, close) {
  const q = simplify(pts);
  let s = "";
  for (let i = 0; i < q.length; i += 2) s += `${i ? " L" : "M"}${(q[i] * cell).toFixed(1)},${(q[i + 1] * cell).toFixed(1)}`;
  return close ? `${s} Z` : s;
}

/** Everything to draw for one window, or { hidden } with the reason. */
export function drawLive(live, grids, win) {
  if (!win) return { hidden: "the sheet is not showing our forecast" };
  const fld = computeField(live, grids, win.dates, win.totalCm);
  if (fld.hidden) return fld;
  const { F } = fld;
  const { gw, gh, cell, w: W, h: H } = live;
  const M = grids.mask;
  let lo = Infinity, hi = -Infinity, mx = -Infinity;
  for (let p = 0; p < gw * gh; p++) {
    if (F[p] > mx) mx = F[p];
    if (M[p]) { if (F[p] < lo) lo = F[p]; if (F[p] > hi) hi = F[p]; }
  }
  if (!(hi >= lo)) return { hidden: "no snow data inside the outline" };
  const nosnow = hi < 1.0;
  const { levels, floor } = levelsFor(lo, hi);
  const lv = nosnow ? [] : levels.filter((l) => l < mx);
  const fl = nosnow ? [] : [floor, ...levels].filter((l) => l < mx);
  const ringsAt = new Map();
  const ws = workspace(gw, gh);
  const rings = (t) => { if (!ringsAt.has(t)) ringsAt.set(t, contourRings(F, gw, gh, t, ws)); return ringsAt.get(t); };

  // bands: region >= level i minus region >= level i+1 (evenodd), coloured along the ramp
  const n = Math.max(1, fl.length);
  const fill = fl.map((t, i) => {
    const d = [...rings(t), ...(i + 1 < fl.length ? rings(fl[i + 1]) : [])].map((r) => pathOf(r, cell, true)).join(" ");
    const col = RAMP[Math.min(RAMP.length - 1, Math.floor((i * (RAMP.length - 1)) / Math.max(1, n - 1)))];
    return d ? `<path d="${d}" fill="${col}" fill-rule="evenodd" clip-path="url(#area)"/>` : "";
  }).join("");

  // contour lines (never along the frame) and one label per level, on its longest stretch inside the outline
  const inside = (x, y) => {
    const i = Math.min(gw - 1, Math.max(0, Math.floor(x))), j = Math.min(gh - 1, Math.max(0, Math.floor(y)));
    return M[j * gw + i] === 1 && x >= 0 && y >= 0 && x < gw && y < gh;
  };
  const depth = [];
  const lines = lv.map((t) => {
    const polys = rings(t).flatMap((r) => splitAtFrame(r, gw, gh)).filter((p) => p.length >= 8);
    let best = [];
    for (const p of polys) {
      let run = [];
      for (let i = 0; i <= p.length; i += 2) {
        if (i < p.length && inside(p[i], p[i + 1])) run.push(p[i], p[i + 1]);
        else { if (run.length > best.length) best = run; run = []; }
      }
    }
    if (best.length) {
      const m = 2 * Math.floor(best.length / 4);
      depth.push({ x: best[m] * cell, y: best[m + 1] * cell, in: t });
    }
    const d = polys.map((p) => pathOf(p, cell, false)).join(" ");
    return d ? `<path d="${d}" fill="none" stroke="#0d3fb0" stroke-opacity="0.75" stroke-width="${live.stroke}" stroke-linejoin="round" clip-path="url(#area)"/>` : "";
  }).join("");
  if (nosnow) depth.push({ x: live.deep[0], y: live.deep[1], in: 0 });

  const marks = live.marks.map((m) => ({ ...m, in: nosnow ? null : r1(sampleAt(F, live, m.x, m.y)) }));
  const frac = (x0, y0, w, h, keep) => ({
    frame: "fractions of this picture, 0-1 from the top-left",
    depth: depth.filter((d) => !keep || (d.x >= x0 && d.x <= x0 + w && d.y >= y0 && d.y <= y0 + h))
      .map((d) => ({ x: +((d.x - x0) / w).toFixed(4), y: +((d.y - y0) / h).toFixed(4), in: d.in })),
    marks: marks.map((m) => ({ x: +((m.x - x0) / w).toFixed(4), y: +((m.y - y0) / h).toFixed(4), kind: m.kind, in: m.in, ft: m.ft })),
  });
  const [sx, sy, ss] = live.sheet;
  const base = marks.find((m) => m.kind === "base"), top = marks.find((m) => m.kind === "top");
  return {
    fill, lines, nosnow, k: fld.k,
    range_in: [r1(lo), r1(hi)],
    base_in: base?.in ?? null, top_in: top?.in ?? null,
    label: windowLabel(win.dates),
    full: frac(0, 0, W, H, false),
    sheet: frac(sx, sy, ss, ss, true),
  };
}
