/* The terrain map's snow field, rebuilt on the phone for whatever days the sheet shows (Brian 2026-11-22: the map
   must never show a different total from the sheet). Twin of scripts/maps/live_grid.py `field()`: the same
   arithmetic, step for step, so the map drawn here matches the one checked in CI.

     field_W = k_W * blur( max(0, sum_d A_d + (sum_d G_d) * H) )

   A_d, G_d: day d's NBM snow parts (coarse grid, bilinear to the fine grid), H: terrain in thousands of feet (fine
   grid), k_W: the sheet's total over the window divided by the same field at the blend's own point and height.
   Coordinates are the full-screen picture's pixels; a grid cell's value sits at its centre. No dependencies. */

export const CM_PER_IN = 2.54;

/** Bytes -> numbers. `grid` and `days` are decoded images ({ data, width, height }, RGBA as a canvas returns them). */
export function readGrids(live, grid, days) {
  const { gw, gh, cw, ch } = live;
  if (grid.width !== gw || grid.height !== gh) throw new Error(`grid is ${grid.width}x${grid.height}, expected ${gw}x${gh}`);
  const n = live.dates.length;
  if (days.width !== cw || days.height !== ch * 2 * n) throw new Error(`days image is ${days.width}x${days.height}, expected ${cw}x${ch * 2 * n}`);
  const [h0, h1] = live.hq;
  const H = new Float64Array(gw * gh);
  const mask = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    // v2 (2026-11-22): 16-bit height, R high byte, B low byte; v1 files: 8 bits in R
    H[i] = h0 + ((live.v ?? 1) >= 2 ? ((grid.data[4 * i] << 8) | grid.data[4 * i + 2]) / 65535 : grid.data[4 * i] / 255) * (h1 - h0);
    mask[i] = grid.data[4 * i + 1] > 127 ? 1 : 0;
  }
  const band = (row0, lo, hi) => {
    const out = new Float64Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      const p = 4 * (row0 * cw + i);
      out[i] = lo + (((days.data[p] << 8) | days.data[p + 1]) / 65535) * (hi - lo);
    }
    return out;
  };
  const A = [], G = [];
  for (let d = 0; d < n; d++) {
    const [alo, ahi, glo, ghi] = live.q[d];
    A.push(band(2 * d * ch, alo, ahi));
    G.push(band((2 * d + 1) * ch, glo, ghi));
  }
  return { H, mask, A, G };
}

/** Coarse -> fine, bilinear between cell centres, edges clamped (live_grid.bilinear_up). */
export function bilinearUp(c, cw, ch, gw, gh, cell, ccell) {
  const out = new Float64Array(gw * gh);
  const ux = new Int32Array(gw), fx = new Float64Array(gw);
  for (let i = 0; i < gw; i++) {
    const u = Math.min(cw - 1, Math.max(0, ((i + 0.5) * cell) / ccell - 0.5));
    const u0 = Math.min(Math.floor(u), cw > 1 ? cw - 2 : 0);
    ux[i] = u0; fx[i] = u - u0;
  }
  for (let j = 0; j < gh; j++) {
    const v = Math.min(ch - 1, Math.max(0, ((j + 0.5) * cell) / ccell - 0.5));
    const v0 = Math.min(Math.floor(v), ch > 1 ? ch - 2 : 0), fv = v - v0, v1 = Math.min(v0 + 1, ch - 1);
    for (let i = 0; i < gw; i++) {
      const u0 = ux[i], u1 = Math.min(u0 + 1, cw - 1), fu = fx[i];
      const top = c[v0 * cw + u0] * (1 - fu) + c[v0 * cw + u1] * fu;
      const bot = c[v1 * cw + u0] * (1 - fu) + c[v1 * cw + u1] * fu;
      out[j * gw + i] = top * (1 - fv) + bot * fv;
    }
  }
  return out;
}

/** scipy.ndimage.gaussian_filter(f, sigma, mode="reflect", truncate=4.0) on a w x h grid, in place. */
export function gaussianBlur(f, w, h, sigma) {
  if (!(sigma > 0)) return f;
  const r = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const refl = (i, n) => {           // (d c b a | a b c d | d c b a)
    const p = 2 * n;
    i = ((i % p) + p) % p;
    return i < n ? i : p - 1 - i;
  };
  const ry = new Int32Array(h + 2 * r), rx = new Int32Array(w + 2 * r);
  for (let i = 0; i < h + 2 * r; i++) ry[i] = refl(i - r, h) * w;
  for (let i = 0; i < w + 2 * r; i++) rx[i] = refl(i - r, w);
  const K = 2 * r + 1;
  const tmp = new Float64Array(Math.max(w, h));
  // axis 0 (down the columns) first, as scipy does
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let a = 0;
      for (let t = 0; t < K; t++) a += k[t] * f[ry[y + t] + x];
      tmp[y] = a;
    }
    for (let y = 0; y < h; y++) f[y * w + x] = tmp[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let t = 0; t < K; t++) a += k[t] * f[o + rx[x + t]];
      tmp[x] = a;
    }
    for (let x = 0; x < w; x++) f[o + x] = tmp[x];
  }
  return f;
}

/** The field for the sheet's days. Returns { F, k, ref } or { hidden: reason } — never a guess:
 *  a day the grids do not have, or a sheet total with no NBM pattern under it, hides the map. */
export function computeField(live, g, dates, totalCm) {
  const idx = dates.map((d) => live.dates.indexOf(d));
  if (!dates.length) return { hidden: "no forecast days" };
  if (idx.some((i) => i < 0)) return { hidden: `the map has no snow pattern for ${dates.filter((_, n) => idx[n] < 0).join(", ")}` };
  if (!Number.isFinite(totalCm) || totalCm < 0) return { hidden: "the sheet total is missing" };
  const { gw, gh, cw, ch, cell, ccell } = live;
  const SA = new Float64Array(cw * ch), SG = new Float64Array(cw * ch);
  let ra = 0, rg = 0;
  for (const i of idx) {
    for (let p = 0; p < cw * ch; p++) { SA[p] += g.A[i][p]; SG[p] += g.G[i][p]; }
    ra += live.ref.a[i]; rg += live.ref.g[i];
  }
  const ref = Math.max(0, ra + rg * live.ref.z_kft);
  const totalIn = totalCm / CM_PER_IN;
  let k = 0;
  if (totalIn > 0) {
    if (ref < live.floor_in) {
      /* No NBM pattern, but under 1 in (anchor.py LOW_IN): flat at the sheet's total, never a pattern stretched from noise. */
      if (totalIn < (live.low_in ?? 0)) return { F: new Float64Array(gw * gh).fill(totalIn), k: null, ref, flat: true };
      return { hidden: `NBM has ${ref.toFixed(2)} in at the forecast point but the sheet has ${totalIn.toFixed(1)} in` };
    }
    k = totalIn / ref;
  }
  const a = bilinearUp(SA, cw, ch, gw, gh, cell, ccell), b = bilinearUp(SG, cw, ch, gw, gh, cell, ccell);
  const F = new Float64Array(gw * gh);
  for (let p = 0; p < gw * gh; p++) F[p] = Math.max(0, a[p] + b[p] * g.H[p]);
  gaussianBlur(F, gw, gh, live.sigma);
  for (let p = 0; p < gw * gh; p++) F[p] *= k;
  return { F, k, ref };
}

/** The field at a picture point (bilinear between cell centres, clamped). */
export function sampleAt(F, live, x, y) {
  const { gw, gh, cell } = live;
  const u = Math.min(gw - 1, Math.max(0, x / cell - 0.5)), v = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
  const i0 = Math.min(Math.floor(u), gw - 2), j0 = Math.min(Math.floor(v), gh - 2);
  const fu = u - i0, fv = v - j0;
  const at = (i, j) => F[j * gw + i];
  return (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
}

/** Contour levels: terrain_pilot.py's rule, from the range inside the skiable outline. */
export function levelsFor(lo, hi) {
  const a = Math.floor(lo), b = Math.ceil(hi);
  let step = b - a <= 4 ? 1 : b - a <= 16 ? 2 : 3;
  while ((b - a) / step > 14) step += 1;
  const out = [];
  for (let l = Math.floor(a / step) * step + step; l < b - 1e-9; l += step) out.push(l);
  return { levels: out, floor: a };
}

/** "Nov 22–27", "Nov 29 – Dec 3", "Nov 22" (anchor.py label). */
export function windowLabel(dates) {
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (s) => { const [, m, d] = s.split("-").map(Number); return [M[m - 1], d]; };
  const [am, ad] = p(dates[0]), [bm, bd] = p(dates[dates.length - 1]);
  if (dates.length === 1 || dates[0] === dates[dates.length - 1]) return `${am} ${ad}`;
  return am === bm ? `${am} ${ad}–${bd}` : `${am} ${ad} – ${bm} ${bd}`;
}
