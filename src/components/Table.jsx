import Dot from "./Dot.jsx";
import { flags } from "../lib/scoring.js";
import { snowTxt, tempTxt, windTxt } from "../lib/units.js";
import { WARM_LIMIT, COLD_LIMIT, WIND_LIMIT } from "../lib/constants.js";

export default function Table({ data, metric, onOpen }) {
  return (
    <div className="table">
      <div className="t-head">
        <span>Resort</span>
        <span>before</span>
        <span>snow</span>
        <span>temp</span>
        <span>wind</span>
      </div>

      {data.map((r, i) => {
        const f = flags(r);
        return (
          <button
            key={r.name}
            className={`t-row${i === 0 ? " best" : ""}`}
            onClick={() => onOpen(r)}
          >
            <span className="t-name">{r.name}</span>
            <span className="t-num t-before">{snowTxt(r.before, metric)}"</span>
            <span className="t-num t-snow">{snowTxt(r.total, metric)}"</span>
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
        <Dot kind="red" /> above {WARM_LIMIT}° or over {WIND_LIMIT} mph &nbsp;·&nbsp;
        <Dot kind="amber" /> below {COLD_LIMIT}° &nbsp;·&nbsp; <b>before</b> is the snow that
        fell in the three days prior — the base you'd be landing on.
      </p>
    </div>
  );
}
