/* Marching squares for the app-drawn terrain map (no dependencies). For a threshold t, the boundary of the region
   where the field >= t, as closed rings. Grid value i sits at i + 0.5; outside the grid counts as below every
   threshold, so every ring closes and a region touching the frame closes ON the frame (0 or w), where the line
   splitter below knows to leave that stretch undrawn. Crossings are placed by linear interpolation along the cell
   edge (outside the grid: half way). Saddles are split by the cell's centre value. */

/** Buffers for contourRings, reused across levels of one map (each level touches only its own edges). */
export function workspace(w, h) {
  const nE = 2 * (w + 2) * (h + 2);
  return { w, h, a1: new Int32Array(nE).fill(-1), a2: new Int32Array(nE).fill(-1), ex: new Float64Array(nE), ey: new Float64Array(nE),
    seen: new Uint8Array(nE), touched: new Int32Array(nE), nt: 0 };
}

export function contourRings(F, w, h, t, ws = workspace(w, h)) {
  const W = w + 2, H = h + 2;                      // corner grid with a one-cell pad of -Infinity
  if (!ws.pad || ws.padOf !== F) {                 // F with a ring of -Infinity, built once per field
    ws.pad = new Float64Array(W * H).fill(-Infinity);
    for (let y = 0; y < h; y++) ws.pad.set(F.subarray(y * w, (y + 1) * w), (y + 1) * W + 1);
    ws.padOf = F;
  }
  const P = ws.pad;
  const { a1, a2, ex, ey, seen, touched } = ws;
  ws.nt = 0;
  const hE = (X, Y) => 2 * (Y * W + X);           // (X,Y)-(X+1,Y)
  const vE = (X, Y) => 2 * (Y * W + X) + 1;       // (X,Y)-(X,Y+1)
  const place = (e, X0, Y0, X1, Y1, v0, v1) => {
    const f = Number.isFinite(v0) && Number.isFinite(v1) ? (t - v0) / (v1 - v0) : 0.5;
    ex[e] = X0 - 0.5 + f * (X1 - X0);
    ey[e] = Y0 - 0.5 + f * (Y1 - Y0);
  };
  const link = (p, q) => {
    if (a1[p] < 0) { a1[p] = q; touched[ws.nt++] = p; } else a2[p] = q;
    if (a1[q] < 0) { a1[q] = p; touched[ws.nt++] = q; } else a2[q] = p;
  };
  for (let Y = 0; Y < H - 1; Y++) {
    for (let X = 0; X < W - 1; X++) {
      const o = Y * W + X;
      const va = P[o], vb = P[o + 1], vc = P[o + W + 1], vd = P[o + W];
      if ((va >= t) === (vb >= t) && (vb >= t) === (vc >= t) && (vc >= t) === (vd >= t)) continue;
      const ia = va >= t, ib = vb >= t, ic = vc >= t, id = vd >= t;
      const c = (ia ? 8 : 0) | (ib ? 4 : 0) | (ic ? 2 : 0) | (id ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = hE(X, Y), B = hE(X, Y + 1), L = vE(X, Y), R = vE(X + 1, Y);
      if (ia !== ib) place(T, X, Y, X + 1, Y, va, vb);
      if (id !== ic) place(B, X, Y + 1, X + 1, Y + 1, vd, vc);
      if (ia !== id) place(L, X, Y, X, Y + 1, va, vd);
      if (ib !== ic) place(R, X + 1, Y, X + 1, Y + 1, vb, vc);
      switch (c) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(T, L); break;
        case 5: case 10: {                         // saddle
          const mid = (va + vb + vc + vd) / 4 >= t;
          if (c === 10) { if (mid) { link(T, R); link(L, B); } else { link(T, L); link(B, R); } }   // a, c inside
          else if (mid) { link(T, L); link(B, R); } else { link(T, R); link(L, B); }               // b, d inside
          break;
        }
        default: break;
      }
    }
  }
  const rings = [];
  for (let k = 0; k < ws.nt; k++) {
    const e = touched[k];
    if (seen[e]) continue;
    const pts = [];
    let prev = -1, cur = e;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      pts.push(ex[cur], ey[cur]);
      const nx = a1[cur] !== prev ? a1[cur] : a2[cur];
      prev = cur;
      cur = nx;
    }
    if (pts.length >= 6) rings.push(pts);
  }
  for (let k = 0; k < ws.nt; k++) { const e = touched[k]; a1[e] = -1; a2[e] = -1; seen[e] = 0; }
  return rings;
}

/** A ring split into the stretches that are not on the frame (an edge with both ends on the same frame side is
 *  where the region was cut by the picture's edge: no contour there). Returns open polylines. */
export function splitAtFrame(ring, w, h) {
  const on = (x, y) => (x <= 0 ? 1 : x >= w ? 2 : 0) | (y <= 0 ? 4 : y >= h ? 8 : 0);
  const n = ring.length / 2;
  const edgeOnFrame = (i) => {
    const j = (i + 1) % n;
    return (on(ring[2 * i], ring[2 * i + 1]) & on(ring[2 * j], ring[2 * j + 1])) !== 0;
  };
  let start = -1;
  for (let i = 0; i < n; i++) if (edgeOnFrame(i)) { start = (i + 1) % n; break; }
  if (start < 0) return [ring.concat(ring.slice(0, 2))];     // closed, nowhere on the frame
  const out = [];
  let cur = [];
  for (let s = 0; s < n; s++) {
    const i = (start + s) % n;
    if (!cur.length) cur.push(ring[2 * i], ring[2 * i + 1]);
    if (edgeOnFrame(i)) { if (cur.length >= 4) out.push(cur); cur = []; continue; }
    const j = (i + 1) % n;
    cur.push(ring[2 * j], ring[2 * j + 1]);
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

/** Shoelace area of a ring (tests). */
export function ringArea(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return Math.abs(a) / 2;
}
