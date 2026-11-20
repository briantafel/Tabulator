import { DEPTH_INK, INK, layoutDepth, layoutMark } from "../lib/terrainLabels.js";

/* The Snow by terrain labels, drawn as SVG over the picture (Brian, 2026-11-20).
   viewBox is the picture in Figma px (358 on the sheet, 874 full screen), so
   the whole overlay scales with the picture and the sheet's --u. Full screen
   passes `counter`: each label is scaled by 1 / zoom (CSS var --tm-s, written by
   TerrainFullscreen on every pan/zoom) so type stays the same size on screen
   while the map zooms under it. */
export default function TerrainLabels({ labels, metric, S, counter = false }) {
  const at = (x, y) => ({
    style: { transform: counter ? `translate(${x}px, ${y}px) scale(calc(1 / var(--tm-s, 1)))` : `translate(${x}px, ${y}px)` },
  });
  return (
    <svg className="tm-vec" viewBox={`0 0 ${S.w ?? S.size} ${S.h ?? S.size}`} aria-hidden="true" focusable="false">
      {(labels.depth ?? []).map((d, i) => {
        const L = layoutDepth(d, metric, S);
        return (
          <g key={`d${i}`} {...at(L.cx, L.cy)}>
            <rect x={-L.w / 2} y={-L.h / 2} width={L.w} height={L.h} rx={S.radius} fill="#fff" />
            <text x="0" y="0" textAnchor="middle" dominantBaseline="central" fontSize={S.depth} fontWeight="700" fill={DEPTH_INK}>{L.text}</text>
          </g>
        );
      })}
      {(labels.marks ?? []).map((m, i) => {
        const L = layoutMark(m, metric, S);
        return (
          <g key={`m${i}`} {...at(L.cx, L.cy)}>
            <circle r={S.ring / 2} fill="#fff" stroke={INK} strokeWidth={Math.max(1, S.ring / 10)} />
            <circle r={S.dot / 2} fill={INK} />
            <text
              x={L.tx - L.cx} y="0" textAnchor={L.flip ? "end" : "start"} dominantBaseline="central"
              fontSize={S.mark} fontWeight="700" fill={INK}
              stroke="#fff" strokeWidth={S.mark / 3} strokeLinejoin="round" paintOrder="stroke"
            >{L.text}</text>
          </g>
        );
      })}
    </svg>
  );
}
