import { Fragment, useMemo } from "react";
import { TODAY_IDX } from "../lib/constants.js";
import { fromIso } from "../lib/dates.js";
import { snowTxt } from "../lib/units.js";

/** Where and when snow lands across the whole network, so you can spot a
 *  storm before you've committed to dates. Not from the prototype — see
 *  docs/OPEN-ITEMS.md for the note inviting a challenge to this screen. */
export default function Radar({ raw, dates, metric, onJump }) {
  const rows = useMemo(
    () =>
      [...raw]
        .map((r) => ({
          name: r.name,
          days: r.all.slice(TODAY_IDX),
          total: r.all.slice(TODAY_IDX).reduce((s, d) => s + d.snow, 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 12),
    [raw]
  );

  const max = Math.max(0.5, ...rows.flatMap((r) => r.days.map((d) => d.snow)));
  const days = dates.slice(TODAY_IDX);

  return (
    <div className="radar">
      <h2 className="screen-h">Where it's snowing</h2>
      <p className="screen-p">
        Next {days.length} days. Darker means deeper. Tap a column to start a trip there.
      </p>

      <div className="rd-scroll">
        <div
          className="rd-grid"
          style={{ gridTemplateColumns: `92px repeat(${days.length}, 20px)` }}
        >
          <span />
          {days.map((d, i) => (
            <button key={d} className="rd-col" onClick={() => onJump(TODAY_IDX + i)}>
              {fromIso(d).getDate()}
            </button>
          ))}

          {rows.map((r) => (
            <Fragment key={r.name}>
              <span className="rd-name">{r.name}</span>
              {r.days.map((d) => (
                <span
                  key={d.date}
                  className="rd-cell"
                  style={{
                    background:
                      d.snow < 0.05
                        ? "transparent"
                        : `rgba(239,74,56,${0.12 + (d.snow / max) * 0.88})`,
                  }}
                  title={`${snowTxt(d.snow, metric)}"`}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
