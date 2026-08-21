import Dot from "./Dot.jsx";
import { flags } from "../lib/scoring.js";
import { snowWithUnit, tempTxt, windTxt } from "../lib/units.js";
import { WARM_LIMIT, COLD_LIMIT, WIND_LIMIT } from "../lib/constants.js";
import { cToF, kmhToMph } from "../lib/units.js";

/* Column labels follow the Figma: "-3 days" rather than "before", and the ↑
 * arrows carry the "this is a maximum" meaning that the old build had to
 * spell out in the key. */
export default function Table({ data, metric, onOpen }) {
  const warm = metric ? `${WARM_LIMIT}°` : `${Math.round(cToF(WARM_LIMIT))}°`;
  const cold = metric ? `${COLD_LIMIT}°` : `${Math.round(cToF(COLD_LIMIT))}°`;
  const gale = metric ? `${WIND_LIMIT} km/h` : `${Math.round(kmhToMph(WIND_LIMIT))} mph`;

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
            <span className="t-num">
              {tempTxt(r.hi, metric)}°
              {f.warm && <Dot kind="red" label="Warm enough to fall as rain" />}
              {f.cold && <Dot kind="amber" label="Brutally cold" />}
            </span>
            <span className="t-num">
              {windTxt(r.wind, metric)}
              {f.wind && <Dot kind="red" label="Wind at lift-hold levels" />}
            </span>
          </button>
        );
      })}

      <p className="t-key">
        <Dot kind="red" /> above {warm} or over {gale} &nbsp;·&nbsp;
        <Dot kind="amber" /> below {cold} &nbsp;·&nbsp; <b>-3 days</b> is the snow that
        fell in the three days prior — the base you'd be landing on.
      </p>
    </div>
  );
}
