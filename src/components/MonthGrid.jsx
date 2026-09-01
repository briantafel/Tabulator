import { iso, fromIso } from "../lib/dates.js";

/** Month grid, no weekday headers — tap a start date, tap an end date.
 *  Dates outside the forecast horizon are ghosted and disabled. With a 6-day
 *  horizon that is most of the month, which is honest: the app can only answer
 *  for days it has a forecast for.
 *
 *  Selection follows Brian's Calendar selection PDF: the two ends of the range
 *  are darker circles, and a lighter band runs between them, unbroken across
 *  cells and continued to the row edges where the range wraps a line.
 *
 *  Month paging is NOT here any more. The three dots under the grid are gone
 *  and the < > that replaced them live on the question line above, so the
 *  month being shown is decided by the caller and arrives as `offset`. */
export default function MonthGrid({ dates, a, b, offset = 0, onPick }) {
  const anchor = fromIso(dates[0]);
  const cursor = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);

  const pad = (cursor.getDay() + 6) % 7; // Monday-first
  const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

  /* Today, keyed the same way the cells are — built at midday LOCAL and only
     then turned into a string. iso() runs through toISOString(), which is UTC,
     so keying off `new Date()` directly would call it tomorrow all evening on
     this side of the Atlantic. */
  const now = new Date();
  const todayKey = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12));

  /* Always 42 cells — six rows, whatever the month. A five-row February and a
     six-row March would otherwise be different heights, and the whole point of
     the fixed slot is that nothing below the calendar ever moves. */
  const cells = Array.from({ length: 42 }, (_, i) =>
    i < pad || i >= pad + count
      ? null
      : iso(new Date(cursor.getFullYear(), cursor.getMonth(), i - pad + 1, 12))
  );

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
            /* Brian: "let's always have today's date appear with a red circle
               behind it." Always — selected or not, inside the horizon or
               past the end of it. */
            d === todayKey ? "today" : "",
          ].filter(Boolean).join(" ");
          return (
            <button key={d} className={cls} disabled={!avail} onClick={() => onPick(idx)}>
              <i>{day}</i>
            </button>
          );
        })}
      </div>
    </div>
  );
}
