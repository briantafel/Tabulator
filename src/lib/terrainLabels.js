/* Vector labels for the Snow by terrain map (Brian, 2026-11-20: "these should
   remain vectors in the app — computed, not rendered").

   The picture carries only relief, snow bands, contours, runs, lifts and the
   outline. Everything below is drawn by the app from numbers in
   public/terrain/index.json (positions as 0-1 fractions of the square picture,
   snow in inches, elevation in feet), so it follows the Metric setting and
   stays sharp at any zoom.

   Sizes are Figma's (file bVflJsT7BKiMyMFNddfyQi, 4025:511 resort sheet, 4026:546
   full screen), in px at a 402-wide phone: the sheet's map is 358 px across, the
   full-screen map is 874 px across at fit. */
import { snowTxt, snowUnit } from "./units.js";

export const SHEET = {
  size: 358,
  ring: 10, dot: 2,                // round location marker: outer and inner diameter
  mark: 9,                         // Base / Top info label, bold
  gap: 4,                          // marker edge -> label
  depth: 11.5, padX: 4, padY: 1.5, // snow-depth label, bold, on a white rounded box
  radius: 2,
};
export const FULL = {
  size: 874,
  ring: 13.4, dot: 4.9,
  mark: 13,
  gap: 8.8,
  depth: 13, padX: 5.5, padY: 2.95,
  radius: 2,
};

export const INK = "#2b2f33";
export const DEPTH_INK = "#0d3fb0";
const LH = 1.21;                    // Inter's normal line height: 11 px for 9, 16 for 13

/** Snow depth on a contour label: 30" or 76cm. Inches are stored; cm = in x 2.54. */
export const depthText = (inches, metric) => `${snowTxt(inches * 2.54, metric)}${snowUnit(metric)}`;

/** "Base 24" · 8,538 ft" or "Base 61cm · 2,603 m" — grouped thousands, a space before the unit. */
export function markText(m, metric) {
  const word = m.kind === "top" ? "Top" : "Base";
  const snow = depthText(m.in, metric);
  const elev = metric ? `${Math.round(m.ft / 3.28084).toLocaleString("en-US")} m` : `${m.ft.toLocaleString("en-US")} ft`;
  return `${word} ${snow} · ${elev}`;
}

/** Rough advance width of Inter Bold text, in px, for layout only (flipping a
 *  label off the frame edge, sizing a box). Digits .65 em, quote .42, space .28,
 *  middle dot .35, letters .6. */
export function textWidth(str, fs) {
  let em = 0;
  for (const ch of str) {
    if (/[0-9]/.test(ch)) em += 0.65;
    else if (ch === '"') em += 0.42;
    else if (ch === " ") em += 0.28;
    else if (ch === "·" || ch === ",") em += 0.35;
    else em += 0.6;
  }
  return em * fs;
}

/** Layout of one Base / Top marker in picture px (0..size). The label goes to
 *  the right of the marker and flips to the left when it would leave the frame. */
export function layoutMark(m, metric, S) {
  const cx = m.x * S.size, cy = m.y * S.size;
  const text = markText(m, metric);
  const w = textWidth(text, S.mark);
  const flip = cx + S.ring / 2 + S.gap + w > S.size - S.gap;
  return { cx, cy, text, flip, tx: flip ? cx - S.ring / 2 - S.gap : cx + S.ring / 2 + S.gap, h: S.mark * LH };
}

/** Layout of one snow-depth label: its centre and its box. Box and text stay
 *  inside the frame (nudged in), so an edge label is never cut off. */
export function layoutDepth(d, metric, S) {
  const text = depthText(d.in, metric);
  const w = textWidth(text, S.depth) + 2 * S.padX, h = S.depth * LH + 2 * S.padY;
  const cx = Math.min(S.size - w / 2 - 2, Math.max(w / 2 + 2, d.x * S.size));
  const cy = Math.min(S.size - h / 2 - 2, Math.max(h / 2 + 2, d.y * S.size));
  return { cx, cy, w, h, text };
}

/** Is there label data to draw? Needs the labels-free picture and at least one marker or contour label. */
export const hasVectorLabels = (m) => !!(m && m.img_clean && m.labels && (m.labels.marks?.length || m.labels.depth?.length));
