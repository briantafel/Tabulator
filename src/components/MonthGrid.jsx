import { useState } from "react";
import { iso, fromIso } from "../lib/dates.js";

/** Month grid, no weekday headers — tap a start date, tap an end date.
 *  Dates outside the forecast horizon are ghosted and disabled. With a 6-day
 *  horizon that is most of the month, which is honest: the app can only answer
 *  for days it has a forecast for.
 *
 *  Selection follows Brian's Calendar selection PDF: the two ends of the range
 *  are darker circles, and a lighter band runs between them, unbroken across
 *  cells and continued to the row edges where the range wraps a line. Month
 *  paging is the three dots below the grid, not arrows — the arrows cost a
 *  27pt row the grid needs to keep its 37pt pitch. */
export default function MonthGrid({ dates, a, b, onPick }) {
  const anchor = fromIso(dates[0]);
  const [offset, setOffset] = useState(0);
  const cursor = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);

  const pad = (cursor.getDay() + 6) % 7; // Monday-first
  const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

  /* Always 42 cells — six rows, whatever the month. A five-row February and a
     six-row March would otherwise be different heights, and the whole point of
     the fixed slot is that nothing below the calendar ever moves. */
  const cells = Array.from({ length: 42 }, (_, i) =>
    i < pad || i >= pad + count
      ? null
      : iso(new Date(cursor.getFullYear(), cursor.getMonth(), i - pad + 1, 12))
  );

  const MONTHS = [-1, 0, 1];

  return (
    <div className="cal">
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`p${i}`} />;
          const day = fromIso(d).getDate();
          const idx = dates.indexOf(d);
          const avail = idx >= 0;
          const inRange = avail && idx >= a && idx <= b;
          const cls = [
            "cal-d",
            avail ? "" : "off",
            inRange ? "in" : "",
            avail && idx === a ? "sel-a" : "",
            avail && idx === b ? "sel-b" : "",
          ].filter(Boolean).join(" ");
          return (
            <button key={d} className={cls} disabled={!avail} onClick={() => onPick(idx)}>
              <i>{day}</i>
            </button>
          );
        })}
      </div>

      <div className="cal-dots" role="group" aria-label="Month">
        {MONTHS.map((m) => (
          <button
            key={m}
            className={m === offset ? "on" : ""}
            onClick={() => setOffset(m)}
            aria-current={m === offset}
            aria-label={new Date(anchor.getFullYear(), anchor.getMonth() + m, 1)
              .toLocaleString("en", { month: "long", year: "numeric" })}
          />
        ))}
      </div>
    </div>
  );
}
