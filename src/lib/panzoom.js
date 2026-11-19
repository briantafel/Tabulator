/* Pan and zoom for the fullscreen terrain map (2026-11-19).

   Model: a square picture is drawn `size * s` px wide with its top-left at
   (x, y) in viewport pixels. s = 1 is "cover" — the picture just fills the
   screen on its short side — and that is also the smallest zoom, so the map
   can never leave blank space around it. Pure functions, no DOM, so the
   clamping and the zoom-about-a-point arithmetic are tested directly. */

export const MIN_ZOOM = 1;
/* The Alta picture is 1080 px. At cover on a phone that is already about 1.2
   source px per CSS px, so past ~4–5× it is just bigger pixels. */
export const MAX_ZOOM = 5;

/** Picture edge length at s = 1: the viewport's longer side (cover for a square). */
export const coverSize = (vw, vh) => Math.max(vw, vh);

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keep the picture covering the viewport: no gap on any side. */
export function clampView(v, vw, vh) {
  const size = coverSize(vw, vh);
  const s = clampNum(v.s, MIN_ZOOM, MAX_ZOOM);
  const w = size * s;
  return {
    s,
    x: clampNum(v.x, vw - w, 0),
    y: clampNum(v.y, vh - w, 0),
  };
}

/** s = 1, centred. */
export function initialView(vw, vh) {
  const size = coverSize(vw, vh);
  return { s: 1, x: (vw - size) / 2, y: (vh - size) / 2 };
}

/** Zoom to `nextS` so the picture point under (px, py) stays under it. */
export function zoomAt(v, nextS, px, py, vw, vh) {
  const s = clampNum(nextS, MIN_ZOOM, MAX_ZOOM);
  const k = s / v.s;
  return clampView({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, vw, vh);
}

export function panBy(v, dx, dy, vw, vh) {
  return clampView({ ...v, x: v.x + dx, y: v.y + dy }, vw, vh);
}

/** Pinch step: the fingers moved from (mid0, dist0) to (mid1, dist1). Zoom by the
 *  change in spread about the old midpoint, then follow the midpoint's travel. */
export function pinchStep(v, mid0, dist0, mid1, dist1, vw, vh) {
  if (!(dist0 > 0) || !(dist1 > 0)) return panBy(v, mid1.x - mid0.x, mid1.y - mid0.y, vw, vh);
  const z = zoomAt(v, v.s * (dist1 / dist0), mid0.x, mid0.y, vw, vh);
  return panBy(z, mid1.x - mid0.x, mid1.y - mid0.y, vw, vh);
}

/** Double tap: zoomed in → back to fit; at fit → 2.5× on the tapped point. */
export function doubleTapTarget(v) {
  return v.s > MIN_ZOOM * 1.05 ? MIN_ZOOM : 2.5;
}
