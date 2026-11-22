import { DEPTH_INK, INK, layoutDepth, layoutMark, layoutMid } from "../lib/terrainLabels.js";

/* The Snow by terrain labels, drawn as SVG over the picture (Brian, 2026-11-20).
   viewBox is the picture in Figma px (358 on the sheet, 874 full screen), so
   the whole overlay scales with the picture and the sheet's --u. Full screen
   passes `counter` (or, better, `screen`: labels positioned in screen px from the
   --k CSS var, px per reference px, never scaled at all, so they are always crisp): each label is scaled by 1 / zoom (CSS var --tm-s, written by
   TerrainFullscreen on every pan/zoom) so type stays the same size on screen
   while the map zooms under it. */
export default function TerrainLabels({ labels, metric, S, counter = false, screen = false }) {
  const at = (x, y) => ({
    style: { transform: screen ? `translate(calc(var(--k) * ${x}), calc(var(--k) * ${y}))` : counter ? `translate(${x}px, ${y}px) scale(calc(1 / var(--tm-s, 1)))` : `translate(${x}px, ${y}px)` },
  });
  return (
    <svg className="tm-vec" {...(screen ? { width: 1, height: 1, style: { position: "absolute", left: 0, top: 0, inset: "auto", width: 1, height: 1, overflow: "visible" } } : { viewBox: `0 0 ${S.w ?? S.size} ${S.h ?? S.size}` })} aria-hidden="true" focusable="false">
      {(labels.depth ?? []).map((d, i) => {
        const L = layoutDepth(d, metric, S);
        return (
          <g key={`d${i}`} {...at(L.cx, L.cy)}>
            <rect x={-L.w / 2} y={-L.h / 2} width={L.w} height={L.h} rx={S.radius} fill="#fff" />
            <text x="0" y="0" textAnchor="middle" dominantBaseline="central" fontSize={S.depth} fontWeight="700" fill={DEPTH_INK}>{L.text}</text>
          </g>
        );
      })}
      {labels.mid && (() => {
        const L = layoutMid(labels.mid, metric, S);
        return (
          <g {...at(L.cx - L.w / 2, L.cy)}>
            <Tag tag={L.tag} S={S} valueStyle={{ fill: "var(--red)" }} />
          </g>
        );
      })()}
      {(labels.marks ?? []).map((m, i) => {
        const L = layoutMark(m, metric, S);
        const off = S.ring / 2 + S.gap;
        return (
          <g key={`m${i}`} {...at(L.cx, L.cy)}>
            <circle r={S.ring / 2} fill="#fff" stroke={INK} strokeWidth={Math.max(1, S.ring / 10)} />
            <circle r={S.dot / 2} fill={INK} />
            {/* full screen re-flips this group against the real screen edge (TerrainFullscreen) */}
            <g transform={`translate(${L.flip ? -off - L.tag.w : off}, 0)`}
              {...(screen ? { "data-mark": "", "data-w": L.tag.w, "data-off": off } : {})}>
              <Tag tag={L.tag} S={S} valueStyle={{ fill: DEPTH_INK }} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/* One tag (Figma 2026-11-22): white box, the amount bold, then its elevation line; origin = left edge, vertical centre. */
function Tag({ tag, S, valueStyle }) {
  const { value, sub, vw, w, h } = tag;
  return (
    <>
      <rect x="0" y={-h / 2} width={w} height={h} rx={S.radius} fill="#fff" />
      {value && <text x={S.tagPadX} y="0" dominantBaseline="central" fontSize={S.tagVal} fontWeight="700" style={valueStyle}>{value}</text>}
      <text x={S.tagPadX + (value ? vw + S.tagGap : 0)} y="0" dominantBaseline="central" fontSize={S.tagSub} fontWeight="600" fill={INK}>{sub}</text>
    </>
  );
}
