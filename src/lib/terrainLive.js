/* The app-drawn Snow by terrain map (Brian 2026-11-22): bands, contours, depth labels and Base / Top for the days
   the sheet shows, from the per-day grids (lib/terrainField.js). Same rules as scripts/maps/terrain_pilot.py:
   levels from the range inside the skiable outline, the 7-step blue ramp multiplied over the relief, one contour
   label per level on its longest stretch inside the outline, Base / Top at the lowest and highest lift terminals,
   "no snow" under an inch. Output is SVG markup in the full-screen picture's pixels plus label data in the shape
   TerrainLabels reads. */
import { computeField, levelsFor, sampleAt, windowLabel } from "./terrainField.js";
import { contourRings, splitAtFrame, workspace } from "./terrainContours.js";
import { FULL, SHEET, layoutMark, layoutMid } from "./terrainLabels.js";

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
    mid: mid && (!keep || (mid.x >= x0 && mid.x <= x0 + w && mid.y >= y0 && mid.y <= y0 + h))
      ? { x: +((mid.x - x0) / w).toFixed(4), y: +((mid.y - y0) / h).toFixed(4), cm: mid.cm, ft: mid.ft } : null,
    depth: depth.filter(clear).filter((d) => !keep || (d.x >= x0 && d.x <= x0 + w && d.y >= y0 && d.y <= y0 + h))
      .map((d) => ({ x: +((d.x - x0) / w).toFixed(4), y: +((d.y - y0) / h).toFixed(4), in: d.in })),
    marks: marks.map((m) => ({ x: +((m.x - x0) / w).toFixed(4), y: +((m.y - y0) / h).toFixed(4), kind: m.kind, in: m.in, ft: m.ft })),
  });
  /* Mid (Brian 2026-11-22): the sheet's own number at the sheet's elevation, so the header's total is printed on the map.
     Placed on the terrain at that elevation nearest the centre of that band. */
  let mid = null;
  if (!nosnow) {
    const zc = live.ref.z_kft, Hh = grids.H;
    const [bx, by, bs] = live.sheet;
    const SF = { ...FULL, w: (FULL.size * W) / H, h: FULL.size };
    const SS = { ...SHEET, w: SHEET.size, h: SHEET.size };
    const cand = [];
    let sx_ = 0, sy_ = 0;
    for (let p = 0; p < gw * gh; p++) if (M[p] && Math.abs(Hh[p] - zc) < 0.08) { cand.push(p); sx_ += p % gw; sy_ += Math.floor(p / gw); }
    if (cand.length) {
      const cx = sx_ / cand.length, cy = sy_ / cand.length;
      const dist = (p) => (p % gw - cx) ** 2 + (Math.floor(p / gw) - cy) ** 2;
      cand.sort((a, b) => dist(a) - dist(b));
      /* Mid must not sit on a Base / Top label, in the sheet's frame or in the full-screen frame. */
      const hits = (S, x0, y0, fw, fh, mx, my) => {
        const m = layoutMid({ x: (mx - x0) / fw, y: (my - y0) / fh, cm: win.totalCm, ft: Math.round(zc * 1000) }, false, S);
        return marks0.some((k) => {
          const L = layoutMark({ x: (k.x - x0) / fw, y: (k.y - y0) / fh, kind: k.kind, in: 1, ft: k.ft }, false, S);
          const w = L.tag.w + S.ring / 2 + S.gap;   // from the marker's centre to the tag's far edge
          const cx2 = L.flip ? L.cx - w / 2 : L.cx + w / 2;
          return Math.abs(m.cx - cx2) * 2 < m.w + w && Math.abs(m.cy - L.cy) * 2 < m.h + L.h + 4;
        });
      };
      const marks0 = live.marks;
      const inSheet = (x, y) => x >= bx + bs * 0.12 && x <= bx + bs * 0.88 && y >= by + bs * 0.12 && y <= by + bs * 0.88;
      let pick = cand.find((p) => {
        const x = ((p % gw) + 0.5) * cell, y = (Math.floor(p / gw) + 0.5) * cell;
        return inSheet(x, y) && !hits(SS, bx, by, bs, bs, x, y) && !hits(SF, 0, 0, W, H, x, y);
      });
      if (pick === undefined) pick = cand.find((p) => inSheet(((p % gw) + 0.5) * cell, (Math.floor(p / gw) + 0.5) * cell)) ?? cand[0];
      mid = { x: ((pick % gw) + 0.5) * cell, y: (Math.floor(pick / gw) + 0.5) * cell, cm: win.totalCm, ft: Math.round(zc * 1000) };
    }
  }
  const clear = (d) => !mid || Math.abs(d.x - mid.x) / W > 0.075 || Math.abs(d.y - mid.y) / H > 0.04;   // depth labels give way to it
  const [sx, sy, ss] = live.sheet;
  const base = marks.find((m) => m.kind === "base"), top = marks.find((m) => m.kind === "top");
  return {
    fill, lines, nosnow, k: fld.k,
    mid_cm: nosnow ? null : win.totalCm,                    // the sheet's own number, for the caption and legend
    range_in: [r1(lo), r1(hi)],
    base_in: base?.in ?? null, top_in: top?.in ?? null,
    label: windowLabel(win.dates),
    full: frac(0, 0, W, H, false),
    sheet: frac(sx, sy, ss, ss, true),
  };
}
