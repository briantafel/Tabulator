import { useEffect, useRef, useState } from "react";
import Table from "./Table.jsx";
import { shortDate } from "../lib/dates.js";
import { holdsPlace } from "../lib/trips.js";
import { CHECK_RING, CHECK_FULL, CAL_FRAME, CAL_PLUS, CAL_X, RT_X } from "./tripIcons.js";

/** A range, part of a range or a state, opened from the radar's paragraph.
 *
 *  Brian, 2026-10-29: "Each mountain region should be tappable, and the resort
 *  sheet should pop up with the name of the mountain region at the top. A
 *  chart just like the summaries on the main screen should show below that
 *  with each of the resorts from that region."
 *
 *  So it is the resort sheet's card — same scrim, handle, header and Close —
 *  holding the mountains screen's results table for just those resorts, over
 *  the same days the paragraph was read over. Tapping a row hands over to that
 *  resort's own sheet.
 *
 *  Brian, 2026-10-31: the resort sheet's add-to / remove-from-trip button,
 *  beside Close. Here it acts on the whole place: Add puts every resort in it
 *  into the trip, and the button turns to the red X once some trip holds all
 *  of them, where Remove takes back out what the place added — resorts added
 *  from their own sheets stay (lib/trips.js). */
export default function PlaceSheet({
  place, metric, favs, onClose, onOpen, trips = [], onAddToTrip, onNewTrip, onRemoveFromTrip,
}) {
  const shown = !!place?.rows?.length;
  const fromScrim = useRef(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef(null);

  // A different place, or the sheet closing, starts the panels over.
  const key = place?.title;
  useEffect(() => { setAdding(false); setRemoving(false); setNaming(false); setDraft(""); }, [key]);
  useEffect(() => { if (naming) field.current?.focus(); }, [naming]);

  // Same body lock as the resort sheet: the page behind must not scroll.
  useEffect(() => {
    if (!shown) return undefined;
    const y = window.scrollY;
    const { overflow, position, top, width } = document.body.style;
    Object.assign(document.body.style, { overflow: "hidden", position: "fixed", top: `-${y}px`, width: "100%" });
    return () => {
      Object.assign(document.body.style, { overflow, position, top, width });
      window.scrollTo(0, y);
    };
  }, [shown]);

  useEffect(() => {
    if (!shown) return undefined;
    // Escape backs out one layer at a time, as on the resort sheet.
    const k = (e) => {
      if (e.key !== "Escape") return;
      if (naming) return setNaming(false);
      if (adding) return setAdding(false);
      if (removing) return setRemoving(false);
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [shown, onClose, naming, adding, removing]);

  if (!shown) return null;
  const win = place.rows[0].win ?? [];
  const n = place.rows.length;

  const resorts = place.rows.map((r) => ({ name: r.name, total: r.total }));
  const names = resorts.map((r) => r.name);
  // Held AS this place — a trip that only has some of them, or has them from
  // their own sheets, still shows the plus.
  const holdsAll = (t) => holdsPlace(t.resorts ?? [], names, place.title);
  const inTrips = trips.filter(holdsAll);
  const booked = inTrips.length > 0;

  const commit = () => {
    const name = draft.trim();
    if (!name) return;
    onNewTrip?.(resorts, name);
    setNaming(false);
    setDraft("");
    setAdding(false);
  };

  return (
    <div
      className="scrim"
      onPointerDown={(e) => { fromScrim.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && fromScrim.current) onClose(); }}
    >
      <div className="sheet place-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={place.title}>
        <span className="sheet-grab" aria-hidden="true"><span /></span>

        <div className="sheet-head">
          <div className="sheet-id">
            <h2>{place.title}</h2>
            <p>
              {n} {n === 1 ? "resort" : "resorts"}
              {win.length > 0 && <> · {shortDate(win[0].date)}–{shortDate(win[win.length - 1].date)}</>}
            </p>
          </div>
        </div>

        <div className="sheet-body">
          <Table data={place.rows} metric={metric} favs={favs} onOpen={onOpen} />
        </div>

        {removing && (
          <div className="addtrip" role="dialog" aria-label="Remove from trip">
            <h2>Remove from trip</h2>
            {inTrips.map((t) => (
              <div className="at-row" key={t.id}>
                <span className="at-name">{t.name}</span>
                <span className="at-when">{t.label}</span>
                <button
                  className="rt-x"
                  onClick={() => {
                    onRemoveFromTrip?.(t.id, names);
                    if (inTrips.length === 1) setRemoving(false);
                  }}
                  aria-label={`Remove ${place.title} from ${t.name}`}
                >
                  <svg viewBox="373.03 135.06 23.88 23.88" aria-hidden="true">
                    <path d={RT_X} />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {adding && (
          <div className="addtrip" role="dialog" aria-label="Add to trip">
            <h2>Add to trip</h2>
            {trips.filter((t) => !holdsAll(t)).map((t) => (
              <button
                key={t.id}
                className="at-row"
                onClick={() => { onAddToTrip?.(t.id, resorts); setAdding(false); }}
              >
                <span className="at-name">{t.name}</span>
                <span className="at-when">{t.label}</span>
              </button>
            ))}
            {naming ? (
              <div className="at-row at-new naming">
                <input
                  ref={field}
                  className="at-field"
                  value={draft}
                  placeholder=""
                  aria-label="Name this trip"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                />
                <button
                  className="at-check"
                  onClick={commit}
                  disabled={!draft.trim()}
                  aria-label="Save trip name"
                >
                  <svg viewBox="373 218 23.3 23.3" aria-hidden="true">
                    {draft.trim()
                      ? <path d={CHECK_FULL} />
                      : CHECK_RING.map((d) => <path key={d.slice(0, 12)} d={d} />)}
                  </svg>
                </button>
              </div>
            ) : (
              <button className="at-row at-new" onClick={() => setNaming(true)}>
                <span className="at-name">New trip</span>
                <span className="at-plus" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button className="sheet-close" onClick={onClose}>Close</button>
          <button
            className={`sheet-add${(adding || removing) ? " on" : ""}${booked ? " booked" : ""}`}
            onClick={() => (booked ? setRemoving((v) => !v) : setAdding((v) => !v))}
            aria-expanded={adding || removing}
            aria-label={booked ? `Remove ${place.title} from trip` : `Add ${place.title} to trip`}
          >
            <svg viewBox="349 33 24 26" aria-hidden="true">
              <path d={CAL_FRAME} />
              <path d={booked ? CAL_X : CAL_PLUS} />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
