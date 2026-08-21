import { Fragment, useMemo } from "react";
import { fromIso } from "../lib/dates.js";
import { snowWithUnit } from "../lib/units.js";

/** Where and when snow lands across the whole network.
 *
 *  At six days this reads as "the shape of this week" rather than the
 *  storm-spotting it did over Open-Meteo's sixteen. Whether it still earns a
 *  tab is an open question — see claude/RESUME-HERE.md. */
export default function Radar({ resorts, dates, metric, onJump }) {
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

  return (
    <div className="radar">
      <h2 className="screen-h">Where it's snowing</h2>
      <p className="screen-p">
        Next {dates.length} days. Darker means deeper. Tap a column to start a trip there.
      </p>

      <div className="rd-scroll">
        <div
          className="rd-grid"
          style={{ gridTemplateColumns: `92px repeat(${dates.length}, 28px)` }}
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
              {r.days.map((d) => (
                <span
                  key={d.date}
                  className="rd-cell"
                  style={{
                    background:
                      (d.snow ?? 0) < 0.05
                        ? "transparent"
                        : `rgba(239,74,56,${0.12 + ((d.snow ?? 0) / max) * 0.88})`,
                  }}
                  title={`${r.name} · ${snowWithUnit(d.snow, metric)}`}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
