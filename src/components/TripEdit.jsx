import { useEffect, useRef, useState } from "react";
import { iso, fromIso } from "../lib/dates.js";

/* Brian's own check, in his coordinates — the same two states as the trip
   naming row: a ring while the range is unconfirmed, filled once tapped. */
const RING = [
  "M382.969 234.128L378.815 229.974L379.99 228.8L382.969 231.78L389.269 225.477L390.446 226.654L382.969 234.128Z",
  "M384.631 218C378.206 218 373 223.206 373 229.631C373 236.055 378.206 241.262 384.631 241.262C391.055 241.262 396.262 236.055 396.262 229.631C396.262 223.206 391.055 218 384.631 218ZM384.631 239.6C379.126 239.6 374.662 235.136 374.662 229.631C374.662 224.126 379.126 219.662 384.631 219.662C390.136 219.662 394.6 224.126 394.6 229.631C394.6 235.136 390.136 239.6 384.631 239.6Z",
];
const FULL =
  "M384.5 218C382.226 218 380.002 218.674 378.111 219.938C376.22 221.202 374.746 222.998 373.875 225.099C373.005 227.2 372.777 229.513 373.221 231.744C373.665 233.974 374.76 236.023 376.368 237.632C377.977 239.24 380.026 240.335 382.256 240.779C384.487 241.223 386.8 240.995 388.901 240.125C391.002 239.254 392.798 237.78 394.062 235.889C395.326 233.998 396 231.774 396 229.5C396 226.45 394.788 223.525 392.632 221.368C390.475 219.212 387.55 218 384.5 218Z";
const TICK =
  "M382.857 234.092L378.75 229.985L380.057 228.679L382.857 231.479L388.944 225.393L390.255 226.696L382.857 234.092Z";

const monthName = (d) => d.toLocaleString("en", { month: "long" });
const key = (d) => `${d.getFullYear()}-${d.getMonth()}`;

/** Editing a trip: rename it, and set its dates.
 *
 *  Unlike the mountains-screen calendar this one is NOT bound to the forecast
 *  horizon. A trip is a plan, and you plan a February week in August — ghosting
 *  every day the scraper cannot see yet would make the screen useless. The
 *  visual language is shared with that calendar (band between, circles on the
 *  ends) but the pitch is Brian's full 39.5 here, because this screen has the
 *  room the days screen did not. */
export default function TripEdit({ trip, onSave, onRename, onClose }) {
  const start = trip.start ? fromIso(trip.start) : new Date();
  const [cursor, setCursor] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const [a, setA] = useState(trip.start ?? null);
  const [b, setB] = useState(trip.end ?? trip.start ?? null);
  const [done, setDone] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState(trip.name);
  const field = useRef(null);

  useEffect(() => { if (naming) field.current?.select(); }, [naming]);

  useEffect(() => {
    const k = (e) => {
      if (e.key !== "Escape") return;
      if (naming) return setNaming(false);
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, naming]);

  const pad = (cursor.getDay() + 6) % 7;                       // Monday-first
  const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  /* Only the rows this month needs, which is what the export draws — February
     is five rows with the check right beneath it, not five rows and a gap. */
  const cells = Array.from({ length: Math.ceil((pad + count) / 7) * 7 }, (_, i) =>
    i < pad || i >= pad + count
      ? null
      : iso(new Date(cursor.getFullYear(), cursor.getMonth(), i - pad + 1, 12)));

  const pick = (d) => {
    setDone(false);
    // First tap sets the start; the next one closes the range, unless it lands
    // before the start, in which case it becomes the new start.
    if (!a || (a && b && a !== b) || d < a) { setA(d); setB(d); return; }
    setB(d);
  };

  const commit = () => {
    if (!a) return;
    setDone(true);
    // Let the filled check land before the screen leaves — Brian: "a confirmed
    // date selection after the tap is included".
    setTimeout(() => onSave({ start: a, end: b ?? a }), 260);
  };

  const rename = () => {
    const n = draft.trim();
    if (n) onRename(n);
    setNaming(false);
  };

  return (
    <div className="tripedit">
      <div className="fav-head">
        <div className="te-id">
          {naming ? (
            <input
              ref={field}
              className="te-field"
              value={draft}
              aria-label="Trip name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
                if (e.key === "Escape") { setDraft(trip.name); setNaming(false); }
              }}
            />
          ) : (
            <h2>{trip.name}</h2>
          )}
        </div>
        <button className="fav-edit" onClick={() => setNaming(true)}>Edit</button>
      </div>

      <div className="fav-rule" />

      <div className="te-month">
        <button
          className="te-arrow"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          aria-label="Previous month"
        >←</button>
        <em>{monthName(cursor)}</em>
        <button
          className="te-arrow"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          aria-label="Next month"
        >→</button>
      </div>

      <div className="cal-grid te-grid" key={key(cursor)}>
        {cells.map((d, i) => {
          if (!d) return <span key={`p${i}`} />;
          const inRange = a && b && d >= a && d <= b;
          const cls = ["cal-d", inRange ? "in" : "", d === a ? "sel-a" : "", d === b ? "sel-b" : ""]
            .filter(Boolean).join(" ");
          return (
            <button key={d} className={cls} onClick={() => pick(d)}>
              <i>{fromIso(d).getDate()}</i>
            </button>
          );
        })}
      </div>

      <div className="te-done">
        <button
          className={`te-check${done ? " on" : ""}`}
          onClick={commit}
          disabled={!a}
          aria-label="Save these dates"
        >
          <svg viewBox="373 218 23.3 23.3" aria-hidden="true">
            {done
              ? <><path d={FULL} /><path className="te-tick" d={TICK} /></>
              : RING.map((d) => <path key={d.slice(0, 12)} d={d} />)}
          </svg>
        </button>
      </div>
    </div>
  );
}
