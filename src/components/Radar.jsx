import { Fragment, useMemo } from "react";
import { fromIso } from "../lib/dates.js";
import { snowWithUnit, cellSnowTxt, CELL_KO_FROM } from "../lib/units.js";
import { outlook } from "../lib/outlook.js";

/** Where and when snow lands across the whole network.
 *
 *  At six days this reads as "the shape of this week" rather than the
 *  storm-spotting it did over Open-Meteo's sixteen. Whether it still earns a
 *  tab is an open question — see claude/RESUME-HERE.md. */
export default function Radar({ resorts, dates, metric, onJump, onPlace }) {
  const rows = useMemo(
    () =>
      [...resorts]
        .map((r) => ({
          id: r.id,
          name: r.name,
          days: r.days,
          total: r.days.reduce((s, d) => s + (d.snow ?? 0), 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 12),
    [resorts]
  );

  const max = Math.max(0.5, ...rows.flatMap((r) => r.days.map((d) => d.snow ?? 0)));
  /* Read over every resort, not just the twelve on the grid: a storm in the
     Northeast still belongs in the paragraph. */
  const said = useMemo(() => outlook(resorts, { metric }), [resorts, metric]);

  return (
    <div className="radar">
      <h2 className="screen-h">Where it's snowing</h2>
      <p className="screen-p">
        Next {dates.length} days. Darker means deeper. Tap a column to start a trip there.
      </p>

      {/* Brian's revised radar (Figma 2142:535): a 164 name column, the six
          days sharing what is left, and each day's amount printed in its
          cell — black on the lighter reds, white on the darkest. */}
      <div
        className="rd-grid"
        style={{ gridTemplateColumns: `164px repeat(${dates.length}, minmax(0, 1fr))` }}
      >
        <span />
        {dates.map((d, i) => (
          <button key={d} className="rd-col" onClick={() => onJump(i)}>
            {fromIso(d).getDate()}
          </button>
        ))}

        {rows.map((r) => (
          <Fragment key={r.id}>
            <span className="rd-name">{r.name}</span>
            {r.days.map((d) => {
              const amount = cellSnowTxt(d.snow, metric);
              const alpha = amount ? 0.12 + ((d.snow ?? 0) / max) * 0.88 : 0;
              return (
                <span
                  key={d.date}
                  className={`rd-cell${alpha >= CELL_KO_FROM ? " ko" : ""}`}
                  style={{ background: amount ? `rgba(239,74,56,${alpha})` : "transparent" }}
                  title={`${r.name} · ${snowWithUnit(d.snow, metric)}`}
                >
                  {amount}
                </span>
              );
            })}
          </Fragment>
        ))}
      </div>

      {/* The forecaster's paragraph — Brian's Figma 2142:872. Grey prose, red
          where the numbers speak, like the resort sheet's summary. */}
      <p className="rd-outlook">
        {said.map((seg, i) => {
          if (seg.link) {
            return (
              <button key={i} className="rd-place" onClick={() => onPlace?.(seg.link)}>
                {seg.t}
              </button>
            );
          }
          return seg.hot ? <b key={i}>{seg.t}</b> : <span key={i}>{seg.t}</span>;
        })}
      </p>
    </div>
  );
}
