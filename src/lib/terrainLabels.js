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
import { snowTxt, snowUnit, snowWithUnit } from "./units.js";

export const SHEET = {
  size: 358,
  ring: 10, dot: 2,                // round location marker: outer and inner diameter
  mark: 9,                         // Base / Top info label, bold
  gap: 4,                          // marker edge -> label
  depth: 11.5, padX: 4, padY: 1.5, // snow-depth label, bold, on a white rounded box
  radius: 2,
  tagVal: 14, tagSub: 8.5, tagPadX: 4, tagPadY: 1.5, tagGap: 4,   // Base / Mid / Top tags (Figma, Brian 2026-11-22): amount, then its elevation
};
export const FULL = {
  size: 874,                       // the reference height; the picture is wider (S.w, set from the data)
  ring: 13.4, dot: 4.9,
  mark: 13,
  gap: 8.8,
  depth: 13, padX: 5.5, padY: 2.95,
  radius: 2,
  tagVal: 14, tagSub: 8.5, tagPadX: 4, tagPadY: 1.5, tagGap: 4,
};

export const INK = "#2b2f33";
export const DEPTH_INK = "#0d3fb0";
const LH = 1.21;                    // Inter's normal line height: 11 px for 9, 16 for 13

/** Snow depth on a contour label: 30" or 76cm. Inches are stored; cm = in x 2.54. */
export const depthText = (inches, metric) => `${snowTxt(inches * 2.54, metric)}${snowUnit(metric)}`;

/** "Base 24" · 8,538 ft" or "Base 61cm · 2,603 m" — grouped thousands, a space before the unit. */
export function markText(m, metric) {
  const word = m.kind === "top" ? "Top" : "Base";
  const elev = metric ? `${Math.round(m.ft / 3.28084).toLocaleString("en-US")} m` : `${m.ft.toLocaleString("en-US")} ft`;
  if (m.in == null) return `${word} · ${elev}`;           // no snow in the forecast: elevation only
  return `${word} ${depthText(m.in, metric)} · ${elev}`;
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

/** Elevation line of a Base / Mid / Top tag: "Base  6,317 ft" (an en space between the word and the elevation). */
export function tagSub(word, ft, metric) {
  const elev = metric ? `${Math.round(ft / 3.28084).toLocaleString("en-US")} m` : `${ft.toLocaleString("en-US")} ft`;
  return `${word}\u2002${elev}`;
}

/** A tag: white box, the amount in bold, then its elevation line. `value` null (no snow in the forecast): elevation only. */
export function layoutTag(value, sub, S) {
  const vw = value ? textWidth(value, S.tagVal) : 0, sw = textWidth(sub, S.tagSub) * 0.89;   // 0.89: textWidth over-reads narrow letters; calibrated to Figma's 52 px for "Mid  8,379 ft" at 8.5 px
  // no amount (no snow in the forecast): the elevation alone, as plain text with a halo, no box
  const w = value ? 2 * S.tagPadX + vw + S.tagGap + sw : sw;
  return { value, sub, vw, sw, w, h: value ? S.tagVal * LH + 2 * S.tagPadY : S.tagSub * LH };
}

/** Layout of one Base / Top marker in picture px (0..S.w, 0..S.h; both default to size): the ring, and its tag to the
 *  right of it, flipping to the left when the tag would leave the frame. */
export function layoutMark(m, metric, S) {
  const W = S.w ?? S.size;
  const cx = m.x * W, cy = m.y * (S.h ?? S.size);
  const word = m.kind === "top" ? "Top" : "Base";
  const tag = layoutTag(m.in == null ? null : depthText(m.in, metric), tagSub(word, m.ft, metric), S);
  const flip = cx + S.ring / 2 + S.gap + tag.w > W - S.gap;
  return { cx, cy, text: markText(m, metric), tag, flip, tx: flip ? cx - S.ring / 2 - S.gap : cx + S.ring / 2 + S.gap, h: tag.h };
}

/** Layout of one snow-depth label: its centre and its box. Box and text stay
 *  inside the frame (nudged in), so an edge label is never cut off. */
export function layoutDepth(d, metric, S) {
  const text = depthText(d.in, metric);
  const w = textWidth(text, S.depth) + 2 * S.padX, h = S.depth * LH + 2 * S.padY;
  const W = S.w ?? S.size, H = S.h ?? S.size;
  const cx = Math.min(W - w / 2 - 2, Math.max(w / 2 + 2, d.x * W));
  const cy = Math.min(H - h / 2 - 2, Math.max(h / 2 + 2, d.y * H));
  return { cx, cy, w, h, text };
}

/** Is there label data to draw? Needs the labels-free picture and at least one marker or contour label. */
export const hasVectorLabels = (m) => !!(m && m.img_clean && m.labels && (m.labels.marks?.length || m.labels.depth?.length));

/** The Mid tag: the sheet's total, written by the same function as the header (red like the header), then "Mid  8,379 ft". */
export function layoutMid(m, metric, S) {
  const tag = layoutTag(snowWithUnit(m.cm, metric), tagSub("Mid", m.ft, metric), S);
  const W = S.w ?? S.size, H = S.h ?? S.size;
  return { cx: Math.min(W - tag.w / 2 - 2, Math.max(tag.w / 2 + 2, m.x * W)), cy: Math.min(H - tag.h / 2 - 2, Math.max(tag.h / 2 + 2, m.y * H)), tag, text: tag.value, sub: tag.sub, w: tag.w, h: tag.h };
}
