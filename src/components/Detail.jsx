import { useEffect } from "react";
import { snowWithUnit, tempTxt, windTxt, elevTxt } from "../lib/units.js";
import { shortDate, weekdayShort } from "../lib/dates.js";
import { WIND_LIMIT } from "../lib/constants.js";
import { rainRisk } from "../lib/scoring.js";

export default function Detail({ r, metric, onClose }) {
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
          <div>
            <h2>{r.name}</h2>
            <p>
              {r.region} · {shortDate(r.win[0].date)}–{shortDate(r.win[r.win.length - 1].date)}
              {r.elevation?.mid != null && <> · mid {elevTxt(r.elevation.mid, metric)}</>}
            </p>
          </div>
          <span className="sheet-total">{snowWithUnit(r.total, metric)}</span>
        </div>

        {/* The forecaster's prose — the thing a raw model output never gives you,
            and the reason for moving off Open-Meteo. */}
        {r.summary?.next3 && <p className="sheet-prose">{r.summary.next3}</p>}

        {rainRisk(r) && (
          <p className="sheet-warn">
            Freezing level stays above the mid station all window — expect rain, not snow.
          </p>
        )}

        {r.win.map((d) => (
          <div className="sd" key={d.date}>
            <span className="sd-day">{weekdayShort(d.date)}</span>
            <span className="sd-bar">
              <span style={{ width: `${((d.snow ?? 0) / dayMax) * 100}%` }} />
            </span>
            <span className="sd-n">{snowWithUnit(d.snow, metric)}</span>
            <span className="sd-n muted">{tempTxt(d.tempMax, metric)}°</span>
            <span className={`sd-n muted${d.windMax >= WIND_LIMIT ? " hot" : ""}`}>
              {windTxt(d.windMax, metric)}
            </span>
          </div>
        ))}

        <button className="sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
