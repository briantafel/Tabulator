import { useEffect } from "react";
import { snowTxt, tempTxt, windTxt } from "../lib/units.js";
import { shortDate, weekdayShort } from "../lib/dates.js";
import { WIND_LIMIT } from "../lib/constants.js";

export default function Detail({ r, metric, onClose }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  if (!r) return null;
  const dayMax = Math.max(1, ...r.win.map((d) => d.snow));

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={r.name}>
        <div className="sheet-grab" />

        <div className="sheet-head">
          <div>
            <h2>{r.name}</h2>
            <p>
              {r.region} · {shortDate(r.win[0].date)}–{shortDate(r.win[r.win.length - 1].date)}
            </p>
          </div>
          <span className="sheet-total">{snowTxt(r.total, metric)}"</span>
        </div>

        {r.win.map((d) => (
          <div className="sd" key={d.date}>
            <span className="sd-day">{weekdayShort(d.date)}</span>
            <span className="sd-bar">
              <span style={{ width: `${(d.snow / dayMax) * 100}%` }} />
            </span>
            <span className="sd-n">{snowTxt(d.snow, metric)}"</span>
            <span className="sd-n muted">{tempTxt(d.hi, metric)}°</span>
            <span className={`sd-n muted${d.wind >= WIND_LIMIT ? " hot" : ""}`}>
              {windTxt(d.wind, metric)}
            </span>
          </div>
        ))}

        <button className="sheet-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
