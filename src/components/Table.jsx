import Dot from "./Dot.jsx";
import { flags } from "../lib/scoring.js";
import { snowWithUnit, tempTxt, windTxt } from "../lib/units.js";

/* Column labels follow the Figma: "-3 days" rather than "before", and the ↑
 * arrows carry the "this is a maximum" meaning that the old build had to
 * spell out in the key. */
export default function Table({ data, metric, onOpen }) {
  return (
    <div className="table">
      <div className="t-head">
        <span>Resort</span>
        <span>-3 days</span>
        <span>snow</span>
        <span>↑ temp</span>
        <span>↑ wind</span>
      </div>

      {data.map((r, i) => {
        const f = flags(r);
        return (
          <button
            key={r.id}
            className={`t-row${i === 0 ? " best" : ""}`}
            onClick={() => onOpen(r)}
          >
            <span className="t-name">{r.name}</span>
            {/* null means the archive doesn't reach back that far — not zero snow */}
            <span className="t-num t-before" title={r.before == null ? "No record for those days yet" : undefined}>
              {r.before == null ? "—" : snowWithUnit(r.before, metric)}
            </span>
            <span className="t-num t-snow">{snowWithUnit(r.total, metric)}</span>
            {/* Marker sits in a fixed slot BEFORE the number, so the number's
                position never shifts between a flagged and an unflagged row. */}
            <span className="t-num t-flagged">
              <Dot kind={f.temp} label={f.temp === "red" ? "Temperature: bad" : "Temperature: dicey"} />
              {tempTxt(r.hi, metric)}°
            </span>
            <span className="t-num t-flagged">
              <Dot kind={f.wind} label={f.wind === "red" ? "Wind: bad" : "Wind: dicey"} />
              {windTxt(r.wind, metric)}
            </span>
          </button>
        );
      })}

    </div>
  );
}
