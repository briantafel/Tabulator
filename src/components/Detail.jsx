import { useEffect } from "react";
import { snowWithUnit, tempTxt, windTxt, elevTxt } from "../lib/units.js";
import { shortDate, weekdayShort } from "../lib/dates.js";
import { rainRisk, windSeverity, tempSeverity } from "../lib/scoring.js";
import Dot from "./Dot.jsx";

/** Snow-Forecast runs its label straight into the sentence —
 *  "Next 3 days weather summary:Heavy rain (total 24.0mm)…" — so drop the
 *  label and restore the space. */
const tidySummary = (t) =>
  String(t).replace(/^[^:]*summary:\s*/i, "").replace(/([a-z]):(?=[A-Z])/g, "$1: ").trim();

/* Brian's exports. Filled paths; the clipPath wrapper Figma emits is dropped
   and the fills become currentColor so the button state drives the colour. */
const STAR =
  "M8.83977 0.693242C9.1378 -0.230842 10.4452 -0.230841 10.7432 0.693242L12.3595 5.7047C12.4929 6.11855 12.8785 6.39871 13.3134 6.39776L18.579 6.38625C19.5499 6.38413 19.954 7.62756 19.1672 8.19655L14.9005 11.2823C14.5481 11.5371 14.4008 11.9904 14.5361 12.4037L16.1742 17.408C16.4763 18.3308 15.4185 19.0993 14.6343 18.5269L10.3811 15.4225C10.0298 15.1661 9.55318 15.1661 9.20195 15.4225L4.94874 18.5269C4.16447 19.0993 3.10675 18.3308 3.40881 17.408L5.04692 12.4037C5.1822 11.9904 5.03491 11.5371 4.68256 11.2823L0.415816 8.19655C-0.370946 7.62756 0.033069 6.38413 1.00402 6.38625L6.26964 6.39776C6.70448 6.39871 7.09009 6.11855 7.22355 5.7047L8.83977 0.693242Z";
const CAL_PLUS = [
  "M26.0032 4.00073H22.0027V2.00049H20.0024V4.00073H12.0015V2.00049H10.0012V4.00073H6.00073C4.9006 4.00073 4.00049 4.90084 4.00049 6.00097V26.0033C4.00049 27.1035 4.9006 28.0036 6.00073 28.0036H26.0032C27.1033 28.0036 28.0034 27.1035 28.0034 26.0033V6.00097C28.0034 4.90084 27.1033 4.00073 26.0032 4.00073ZM26.0032 26.0033H6.00073V12.0017H26.0032V26.0033ZM26.0032 10.0014H6.00073V6.00097H10.0012V8.00121H12.0015V6.00097H20.0024V8.00121H22.0027V6.00097H26.0032V10.0014Z",
  "M17.002 17.9995L19 17.9993V19.9998H17.002V22H15.0017V19.9998H13V17.9995H15.0017V15.9993H17.002V17.9995Z",
];

export default function Detail({ r, metric, onClose, fav, onFav, saved, onSave }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  if (!r || !r.win?.length) return null;
  const dayMax = Math.max(0.1, ...r.win.map((d) => d.snow ?? 0));

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={r.name}>
        <div className="sheet-grab" />

        <div className="sheet-head">
          <div className="sheet-id">
            <h2>{r.name}</h2>
            <p>
              {r.region} · {shortDate(r.win[0].date)}–{shortDate(r.win[r.win.length - 1].date)}
              {r.elevation?.mid != null && <> · mid {elevTxt(r.elevation.mid, metric)}</>}
            </p>
          </div>
          <span className="sheet-total">{snowWithUnit(r.total, metric)}</span>
          <button
            className={`sheet-star${fav ? " on" : ""}`}
            onClick={onFav}
            aria-pressed={!!fav}
            aria-label={fav ? `Unfavourite ${r.name}` : `Favourite ${r.name}`}
          >
            <svg viewBox="0 0 20 19" aria-hidden="true"><path d={STAR} /></svg>
          </button>
        </div>

        {/* The forecaster's prose — the thing a raw model output never gives you,
            and the reason for moving off Open-Meteo. */}
        {r.summary?.next3 && <p className="sheet-prose">{tidySummary(r.summary.next3)}</p>}

        {rainRisk(r) && (
          <p className="sheet-warn">
            Freezing level stays above the mid station all window — expect rain, not snow.
          </p>
        )}

        <div className="sd-list">
          {r.win.map((d) => (
            <div className="sd" key={d.date}>
              <span className="sd-day">{weekdayShort(d.date)}</span>
              <span className="sd-bar">
                <span style={{ width: `${((d.snow ?? 0) / dayMax) * 100}%` }} />
              </span>
              <span className="sd-n">{snowWithUnit(d.snow, metric)}</span>
              <span className="sd-n sd-f muted">
                <Dot kind={tempSeverity(d.tempMax, d.tempMin)} label="Temperature" />
                {tempTxt(d.tempMax, metric)}°
              </span>
              <span className="sd-n sd-f muted">
                <Dot kind={windSeverity(d.windMax)} label="Wind" />
                {windTxt(d.windMax, metric)}
              </span>
            </div>
          ))}
        </div>

        <div className="sheet-actions">
          <button className="sheet-close" onClick={onClose}>Close</button>
          <button
            className={`sheet-add${saved ? " on" : ""}`}
            onClick={onSave}
            aria-pressed={!!saved}
            aria-label={saved ? "Saved to trips" : "Add to trips"}
          >
            <svg viewBox="0 0 32 32" aria-hidden="true">
              {CAL_PLUS.map((d) => <path key={d.slice(0, 12)} d={d} />)}
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
