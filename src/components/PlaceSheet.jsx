import { useEffect, useRef } from "react";
import Table from "./Table.jsx";
import { shortDate } from "../lib/dates.js";

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
 *  resort's own sheet. */
export default function PlaceSheet({ place, metric, favs, onClose, onOpen }) {
  const shown = !!place?.rows?.length;
  const fromScrim = useRef(false);

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
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [shown, onClose]);

  if (!shown) return null;
  const win = place.rows[0].win ?? [];
  const n = place.rows.length;

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

        <div className="sheet-actions">
          <button className="sheet-close" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
