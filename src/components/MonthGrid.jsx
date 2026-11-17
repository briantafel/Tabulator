import { iso, fromIso, leadingBlanks } from "../lib/dates.js";

/** Month grid, no weekday headers — tap a start date, tap an end date.
 *
 *  Brian, 2026-11-17: "Find me snow outside the 10 day window should allow
 *  you to create that continuously updating trip or watchlist." So days past
 *  the forecast are no longer ghosted and disabled: they answer a tap, drawn
 *  a step lighter than forecast days (`far`) so the edge of the forecast still
 *  reads. Only days before the forecast starts are off — there is nothing to
 *  plan in the past. The selection is held as dates, not as indexes into the
 *  forecast, because a far range has no index.
 *
 *  Selection follows Brian's Calendar selection PDF: the two ends of the range
 *  are darker circles, and a lighter band runs between them, unbroken across
 *  cells and continued to the row edges where the range wraps a line.
 *
 *  The month being shown is decided by the caller (the < > on the question
 *  line) and arrives as `offset`. */
export default function MonthGrid({ dates, start, end, offset = 0, onPick }) {
  const anchor = fromIso(dates[0]);
  const cursor = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
  const first = dates[0];
  const lastForecast = dates[dates.length - 1];

  const pad = leadingBlanks(cursor); // Sunday-first
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
          const off = d < first;
          const far = d > lastForecast;
          const inRange = !!start && !!end && d >= start && d <= end;
          const cls = [
            "cal-d",
            off ? "off" : "",
            far ? "far" : "",
            inRange ? "in" : "",
            d === start ? "sel-a" : "",
            d === end ? "sel-b" : "",
            /* Brian: "let's always have today's date appear with a red circle
               behind it." Always — selected or not. */
            d === todayKey ? "today" : "",
          ].filter(Boolean).join(" ");
          return (
            <button key={d} className={cls} disabled={off} onClick={() => onPick(d)}>
              <i>{day}</i>
            </button>
          );
        })}
      </div>
    </div>
  );
}
