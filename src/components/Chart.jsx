import { SERIES } from "../lib/constants.js";
import { snowTxt } from "../lib/units.js";

const W = 300;
const H = 190;
const L = 30;
const B = 22;
const GRID = [0.25, 0.5, 0.75, 1];

export default function Chart({ data, metric }) {
  const top = data.slice(0, 5);
  const len = top[0]?.cumulative.length ?? 1;
  const max = Math.max(1, ...top.map((r) => r.total));

  const path = (r) => {
    const pts = [
      [L, H - B],
      ...r.cumulative.map((v, i) => [
        L + ((i + 1) / len) * (W - L),
        H - B - (v / max) * (H - B - 8),
      ]),
    ];
    // Smooth with midpoint curves — matches the eased look of the prototype.
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1];
      const [x, y] = pts[i];
      d += ` C${(px + x) / 2},${py} ${(px + x) / 2},${y} ${x},${y}`;
    }
    return d;
  };

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        aria-label="Cumulative snowfall by resort"
      >
        {GRID.map((g) => {
          const y = H - B - g * (H - B - 8);
          return (
            <g key={g}>
              <line x1={L} x2={W} y1={y} y2={y} className="c-grid" />
              <text x={L - 6} y={y + 3} className="c-tick">{snowTxt(max * g, metric)}</text>
            </g>
          );
        })}
        <line x1={L} x2={W} y1={H - B} y2={H - B} className="c-axis" />
        {top.map((r, i) => (
          <path
            key={r.name}
            d={path(r)}
            className="c-line"
            style={{ stroke: SERIES[i], strokeDasharray: i === 3 ? "5 4" : "none" }}
          />
        ))}
      </svg>

      <div className="chart-key">
        {top.map((r, i) => (
          <span key={r.name} className="ck">
            <i style={{ background: SERIES[i] }} />
            {r.name}
          </span>
        ))}
      </div>

      <p className="t-key">
        Cumulative snowfall across the window, in {metric ? "centimetres" : "inches"}.
        Five deepest only — the rest are in the table.
      </p>
    </div>
  );
}
