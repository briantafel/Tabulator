import { useState } from "react";
import { iso, fromIso } from "../lib/dates.js";

/** Month grid, no weekday headers — tap a start date, tap an end date.
 *  Dates outside the forecast horizon are ghosted and disabled. With a 6-day
 *  horizon that is most of the month, which is honest: the app can only answer
 *  for days it has a forecast for. */
export default function MonthGrid({ dates, a, b, onPick }) {
  const [cursor, setCursor] = useState(() => fromIso(dates[0]));

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const pad = (first.getDay() + 6) % 7; // Monday-first
  const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

  const cells = [
    ...Array.from({ length: pad }, () => null),
    ...Array.from({ length: count }, (_, i) =>
      iso(new Date(cursor.getFullYear(), cursor.getMonth(), i + 1, 12))
    ),
  ];

  const step = (n) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const inRange = (d) => {
    const i = dates.indexOf(d);
    return i >= a && i <= b;
  };

  return (
    <div className="cal">
      <div className="cal-nav">
        <button onClick={() => step(-1)} aria-label="Previous month">←</button>
        <button onClick={() => step(1)} aria-label="Next month">→</button>
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`p${i}`} />;
          const day = fromIso(d).getDate();
          const idx = dates.indexOf(d);
          const avail = idx >= 0;
          return (
            <button
              key={d}
              className={`cal-d${avail ? "" : " off"}${inRange(d) ? " in" : ""}${idx === a ? " start" : ""}`}
              disabled={!avail}
              onClick={() => onPick(idx)}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
