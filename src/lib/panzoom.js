/* Pan and zoom for the fullscreen terrain map (2026-11-19, generalised 2026-11-20).

   Geometry `g` = { vw, vh, pw, ph }: the viewport and the picture's size at s = 1,
   all in CSS px. The picture is drawn pw*s by ph*s with its top-left at (x, y).
   The smallest zoom is "cover" (the picture just fills the viewport on both
   axes), so the map never leaves blank space around it. The picture is portrait
   now (Alta: 435 x 874 at the reference phone), so width and height differ.
   `fitView` places the mountain's outline (a rect in 0-1 picture fractions) in
   the band the app leaves free between the header and the legend.
   Pure functions, no DOM, so the clamping and zoom-about-a-point arithmetic is
   tested directly. */

/* The Alta picture is 4096 px tall for an 874 px phone: 4.7 source px per CSS
   px at s = 1, so 5x is still about as sharp as the screen. */
export const MAX_ZOOM = 5;

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Smallest zoom: the picture covers the viewport on both axes. */
export const minZoom = (g) => Math.max(1e-6, g.vw / g.pw, g.vh / g.ph);
export const maxZoom = (g) => Math.max(MAX_ZOOM, minZoom(g) * 2);

/** Picture size at s = 1 for a picture of ref size (rw, rh) shown on a viewport vh tall:
 *  the reference height maps to the viewport height, so s = 1 is "fit height". */
export const naturalSize = (ref, vh) => ({ pw: ref[0] * vh / ref[1], ph: vh });

/** Keep the picture covering the viewport: no gap on any side. */
export function clampView(v, g) {
  const s = clampNum(v.s, minZoom(g), maxZoom(g));
  return {
    s,
    x: clampNum(v.x, g.vw - g.pw * s, 0),
    y: clampNum(v.y, g.vh - g.ph * s, 0),
  };
}

/** The fit view. With a focus rect {x0,y0,x1,y1} (fractions of the picture) and a
 *  band {top, bottom, side} (px kept clear), the focus is as large as the band
 *  allows and centred in it; without one, the picture is simply centred at cover. */
export function fitView(g, focus = null, band = null) {
  const cover = minZoom(g);
  if (!focus || !band) {
    return clampView({ s: cover, x: (g.vw - g.pw * cover) / 2, y: (g.vh - g.ph * cover) / 2 }, g);
  }
  const fw = (focus.x1 - focus.x0) * g.pw, fh = (focus.y1 - focus.y0) * g.ph;
  const bw = g.vw - 2 * band.side, bh = g.vh - band.top - band.bottom;
  const s = Math.max(cover, Math.min(bw / fw, bh / fh));
  const cx = ((focus.x0 + focus.x1) / 2) * g.pw * s, cy = ((focus.y0 + focus.y1) / 2) * g.ph * s;
  return clampView({ s, x: g.vw / 2 - cx, y: band.top + bh / 2 - cy }, g);
}

/** Zoom to `nextS` so the picture point under (px, py) stays under it. */
export function zoomAt(v, nextS, px, py, g) {
  const s = clampNum(nextS, minZoom(g), maxZoom(g));
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, g);
}

export function panBy(v, dx, dy, g) {
  return clampView({ ...v, x: v.x + dx, y: v.y + dy }, g);
}

/** Pinch step: the fingers moved from (mid0, dist0) to (mid1, dist1). Zoom by the
 *  change in spread about the old midpoint, then follow the midpoint's travel. */
export function pinchStep(v, mid0, dist0, mid1, dist1, g) {
  if (!(dist0 > 0) || !(dist1 > 0)) return panBy(v, mid1.x - mid0.x, mid1.y - mid0.y, g);
  const z = zoomAt(v, v.s * (dist1 / dist0), mid0.x, mid0.y, g);
  return panBy(z, mid1.x - mid0.x, mid1.y - mid0.y, g);
}

/** Double tap: zoomed in past the fit → back to fit; at fit → 2.5× that on the tapped point.
 *  Returns the target zoom (absolute), given the fit view's zoom. */
export function doubleTapTarget(v, fitS) {
  return v.s > fitS * 1.05 ? fitS : fitS * 2.5;
}
