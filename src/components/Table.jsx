import Dot from "./Dot.jsx";
import { flags } from "../lib/scoring.js";
import { bestOf } from "../lib/rank.js";
import { snowWithUnit, tempTxt, windTxt } from "../lib/units.js";

/* Column labels follow the Figma: "-3 days" rather than "before", and the ↑
 * arrows carry the "this is a maximum" meaning that the old build had to
 * spell out in the key. */
/* Brian's 10x10 favourite star, drawn on a 10x10 grid rather than the sheet's
   20x19 one — a distinct export, not the big star scaled down. */
const STAR10 =
  "M4.75537 0L5.87794 3.45492H9.51065L6.57173 5.59017L7.6943 9.04508L4.75537 6.90983L1.81644 9.04508L2.93901 5.59017L8.86917e-05 3.45492H3.6328L4.75537 0Z";

export default function Table({ data, metric, onOpen, favs = [] }) {
  /* Coral marks the PICK, wherever it sits. On the mountains screen that is
     row 0 because the list is sorted by the same rule; on the favourites list
     it is whichever row happens to hold it, which is what the design draws.

     It used to mark the deepest total. That was right while depth was the
     ranking, and became wrong the moment the balance landed — Brian: "the
     resort in red is occasionally not the recommended resort using the
     weighted variables logic we developed." bestOf() is the single decision
     the verdict uses too, so the colour and the sentence cannot disagree. */
  const pick = bestOf(data);
  const best = pick ? data.indexOf(pick) : -1;

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
            className={`t-row${i === best ? " best" : ""}`}
            onClick={() => onOpen(r)}
          >
            {/* The star sits in a reserved slot, filled or not — the same rule
                the severity markers follow, so a resort's name does not jump
                sideways the moment you favourite it. */}
            <span className="t-name">
              <span className="t-star">
                {favs.includes(r.name) && (
                  <svg viewBox="0 0 10 10" role="img" aria-label="Favourite">
                    <path d={STAR10} />
                  </svg>
                )}
              </span>
              {r.name}
            </span>
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
