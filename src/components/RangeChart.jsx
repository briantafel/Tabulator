import { useEffect, useRef, useState } from "react";
import { tempSeverity, windSeverity } from "../lib/scoring.js";
import { cmToIn, snowTxt, snowUnit, tempTxt, windTxt } from "../lib/units.js";
import { weekdayShort } from "../lib/dates.js";
import { projectedTotalRange } from "../lib/projections.js";

/* The resort sheet's per-day range chart — only with projections on.
 * Spec: claude/range-chart-spec.md; Figma 4056:433 / 4063:433.
 *
 * Per day: a "possible" bar (80% range), a "likely" bar (50% range), the
 * forecast line, the value above. Snow-Forecast's days in coral, projected
 * days in purple (lightness-matched). Under the chart, ↑ temp and ↑ wind with
 * the same amber / red markers as the table it replaces (Brian: that
 * information is critical). A grey panel sits behind the days the headline
 * currently adds up; guides and baseline turn white over it.
 *
 * Drawn as one SVG in a 358-wide viewBox — the sheet's content width — so it
 * scales with the sheet exactly as the rest of it does.
 */

const W = 358;
const RED = "#EF4A38";
const PUR = "#9B59D0";
const PANEL = "#EDF1F6";
const MARK_AMBER = "#FFCC00";

const disp = (cm, metric) => (cm == null ? null : metric ? cm : cmToIn(cm));

/** The legend's numbers for the days in view. Projected days are added up
 *  member by member (true range of the total). Snow-Forecast's days only
 *  have a daily spread, so theirs is a sum of daily bands — wider than the
 *  true range; PROVISIONAL until per-member data exists for them too. */
function legendRange(days, projMembers) {
  const fc = days.filter((d) => !d.projected), pj = days.filter((d) => d.projected);
  const sum = (arr, k) => arr.reduce((s, d) => s + (d.range?.[k] ?? d.snow ?? 0), 0);
  const pr = projectedTotalRange(projMembers, pj.map((d) => d.date));
  const part = (k) => sum(fc, k) + (pr ? pr[k] : sum(pj, k));
  return { lo: part("p25"), hi: part("p75"), top: part("p90") };
}

function Marker({ kind, x, y }) {
  if (kind === "red") return <circle cx={x} cy={y} r="3.6" fill={RED} />;
  if (kind === "amber") return <path d={`M${x} ${y - 3.6}L${x + 4} ${y + 3.4}L${x - 4} ${y + 3.4}Z`} fill={MARK_AMBER} />;
  return null;
}

export default function RangeChart({ days, metric, sel = "forecast", projMembers = null, onSelect = null }) {
  const n = days.length;
  const hasProj = days.some((d) => d.projected);
  const pitch = W / Math.max(n, 1);

  // Panel behind the days the headline adds up (Brian's option A).
  const idx = days.map((d, i) => ({ d, i }));
  const panelCols = !hasProj || sel === "total" ? [] : idx.filter(({ d }) => (sel === "projected" ? d.projected : !d.projected));
  const target = panelCols.length
    ? { x0: pitch * panelCols[0].i + 1, x1: pitch * (panelCols[panelCols.length - 1].i + 1) - 1 }
    : null;
  /* Slides between positions and fades in/out (Brian, 2026-11-03). Called
     before any early return: hooks must run in the same order every render,
     or a sheet that goes from some days to none crashes. */
  const panel = usePanelMotion(target);
  if (!n) return null;
  const x = (i) => pitch * i + pitch / 2;
  const barW = n > 6 ? 16 : 18;
  const tickW = n > 6 ? 20 : 22;

  // Legend follows the selection (spec): forecast days, projected days or all.
  const inView = days.filter((d) => (sel === "total" ? true : sel === "projected" ? d.projected : !d.projected));
  const lg = legendRange(inView, projMembers);
  /* No band data for these days (e.g. before the builder published spreads
     for Snow-Forecast's days): show the key alone rather than "14–14". */
  const lgHasRange = inView.some((d) => d.range);
  const legendColor = sel === "projected" ? PUR : RED;
  const u = snowUnit(metric);
  const fmtTotal = (cm) => {
    const v = disp(cm, metric);
    return `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v)}`;
  };

  // Scale: guides every 6 up to 18, else every 10.
  const maxV = Math.max(1, ...days.map((d) => disp(d.range?.p90 ?? d.snow ?? 0, metric)));
  const step = maxV <= 18 ? 6 : 10;
  const top = Math.max(step * 2, Math.ceil(maxV / step) * step);
  const LEG_B = 28.5, BASE = 196, PLOT_TOP = 46;
  // Tallest value label sits 16 below the legend.
  const T = BASE - (BASE - (LEG_B + 16 + 16 + 3)) * top / maxV;
  const y = (v) => BASE - (v / top) * (BASE - T);
  const guides = [];
  // Only guides inside the plot: never up into the legend.
  for (let g = step; g <= top; g += step) if (y(g) >= PLOT_TOP) guides.push(g);

  const PANEL_TOP = 42.5, PANEL_BOT = 277.5;

  const line = (y0, key, stroke) => (
    <g key={key}>
      <line x1="0" x2={W} y1={y0} y2={y0} stroke={stroke} />
      {panel && <line x1={panel.x0} x2={panel.x1} y1={y0} y2={y0} stroke="#FFFFFF" strokeOpacity={panel.o} />}
    </g>
  );

  const label = (d) => {
    const v = disp(d.snow, metric);
    if (d.projected) return `${Math.round(v)}${u}`;      // projections: whole units
    return `${snowTxt(d.snow, metric)}${u}`;
  };

  return (
    <svg className="rc" viewBox={`0 0 ${W} 292`} width="100%" role="img"
      aria-label={`Snowfall by day, ${days.length} days, with likely and possible ranges${hasProj ? "; purple days are projections" : ""}`}>
      {/* legend */}
      <g transform={`translate(0 ${LEG_B - 14})`} fontSize="11.5" fill="#8A8A8A">
        {lgHasRange && <>
          <rect x="0" y="2" width="10" height="10" rx="2" fill={legendColor} fillOpacity=".5" />
          <text x="15" y="11"><tspan fontWeight="600" fill="#111">{`${fmtTotal(lg.lo)}–${fmtTotal(lg.hi)}${u}`}</tspan> likely</text>
          <rect x="118" y="2" width="10" height="10" rx="2" fill={legendColor} fillOpacity=".18" />
          <text x="133" y="11"><tspan fontWeight="600" fill="#111">{`${fmtTotal(lg.top)}${u}`}</tspan> possible</text>
        </>}
        <rect x={lgHasRange ? 228 : 0} y="5.75" width="12" height="2.5" rx="1.25" fill={legendColor} />
        <text x={lgHasRange ? 245 : 17} y="11">{sel === "projected" ? "projection" : "forecast"}</text>
      </g>

      {panel && <rect x={panel.x0} y={PANEL_TOP} width={panel.x1 - panel.x0} height={PANEL_BOT - PANEL_TOP} rx="6" fill={PANEL} fillOpacity={panel.o} />}

      {guides.map((g) => (
        <g key={g}>
          {line(y(g), `g${g}`, "#F2F2F2")}
          <text x={W} y={y(g) - 3} textAnchor="end" fontSize="9" fill="#C6C6C6">{`${g}${u}`}</text>
        </g>
      ))}
      {line(BASE + 0.5, "base", "#ECECEC")}

      {days.map((d, i) => {
        const c = d.projected ? PUR : RED;
        const v = disp(d.snow ?? 0, metric);
        const r = d.range;
        const p10 = disp(r?.p10 ?? d.snow ?? 0, metric), p90 = disp(r?.p90 ?? d.snow ?? 0, metric);
        const p25 = disp(r?.p25 ?? d.snow ?? 0, metric), p75 = disp(r?.p75 ?? d.snow ?? 0, metric);
        const h80 = Math.max(3, y(p10) - y(p90));
        const h50 = y(p25) - y(p75);
        const cx = x(i);
        const ts = tempSeverity(d.tempMax, d.tempMin), ws = windSeverity(d.windMax);
        const cell = (txt, kind, yb) => kind
          ? <g><Marker kind={kind} x={cx - 11} y={yb - 4} /><text x={cx - 5.5} y={yb}>{txt}</text></g>
          : <text x={cx} y={yb} textAnchor="middle">{txt}</text>;
        return (
          <g key={d.date}>
            <rect x={cx - barW / 2} y={y(p10) - h80} width={barW} height={h80} rx="2" fill={c} fillOpacity=".18" />
            {h50 > 0.5 && <rect x={cx - barW / 2} y={y(p75)} width={barW} height={h50} rx="2" fill={c} fillOpacity={d.projected ? 0.49 : 0.5} />}
            <rect x={cx - tickW / 2} y={y(v) - 1.25} width={tickW} height="2.5" rx="1.25" fill={c} />
            <text x={cx} y={y(p10) - h80 - 5} textAnchor="middle" fontSize="13" fontWeight="600" fill="#111">{label(d)}</text>
            <text x={cx} y={BASE + 20} textAnchor="middle" fontSize="11.5" fill="#8A8A8A">{weekdayShort(d.date)}</text>
            <g fontSize="11.5" fill="#9A9A9A">
              {cell(`${tempTxt(d.tempMax, metric)}°`, ts, BASE + 46)}
              {cell(windTxt(d.windMax, metric), ws, BASE + 68)}
            </g>
          </g>
        );
      })}
      <text x="0" y="288" fontSize="10" fill="#AAAAAA">{`↑ temp ${metric ? "°C" : "°F"}  ·  ↑ wind ${metric ? "km/h" : "mph"}`}</text>
      {/* Tap areas (Brian, 2026-11-03): the forecast days and the projected
          days are buttons, like the headline number. Tapping one selects it;
          tapping the selected one again shows the total. Drawn last, clear. */}
      {onSelect && hasProj && ["forecast", "projected"].map((which) => {
        const cols = idx.filter(({ d }) => (which === "projected" ? d.projected : !d.projected));
        if (!cols.length) return null;
        const x0 = pitch * cols[0].i, x1 = pitch * (cols[cols.length - 1].i + 1);
        return (
          <rect key={which} className="rc-hit" x={x0} y={PANEL_TOP} width={x1 - x0} height={PANEL_BOT - PANEL_TOP}
            fill="transparent" role="button" tabIndex={0}
            aria-label={sel === which ? `Show the total` : `Show the ${which} total`}
            onClick={() => onSelect(which)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(which); } }} />
        );
      })}
    </svg>
  );
}

/* The selection panel's motion: slides to its new columns over the same
   0.5s as the number roll; fades in where it appears and out where it goes.
   Tweened in JS because SVG x/width transitions are not reliable on iOS. */
const DUR = 500;
const ease = (t) => 1 - (1 - t) ** 3;
function usePanelMotion(target) {
  const [cur, setCur] = useState(() => (target ? { ...target, o: 1 } : null));
  const from = useRef(cur);
  const key = target ? `${target.x0}|${target.x1}` : "none";
  useEffect(() => {
    const start = from.current;
    // Appearing: start in place, transparent. Leaving: stay in place, fade.
    const a = start ?? (target ? { ...target, o: 0 } : null);
    const b = target ? { ...target, o: 1 } : a ? { ...a, o: 0 } : null;
    if (!a || !b) return undefined;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      from.current = target ? b : null; setCur(from.current); return undefined;
    }
    const t0 = performance.now();
    let id;
    const step = (now) => {
      const k = ease(Math.min(1, (now - t0) / DUR));
      const v = { x0: a.x0 + (b.x0 - a.x0) * k, x1: a.x1 + (b.x1 - a.x1) * k, o: a.o + (b.o - a.o) * k };
      from.current = v;
      setCur(v);
      if (k < 1) id = requestAnimationFrame(step);
      else if (!target) { from.current = null; setCur(null); }
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return cur;
}
