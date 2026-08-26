import { useEffect, useRef, useState } from "react";
import Table from "./Table.jsx";
import Chart from "./Chart.jsx";

/* The same two check states as the resort sheet's naming row — Brian's own
   paths, kept in his coordinates. Black here rather than white: the sheet
   panel is #D9D9D9, the Trips screen is the app's white. */
const CHECK_RING = [
  "M382.969 234.128L378.815 229.974L379.99 228.8L382.969 231.78L389.269 225.477L390.446 226.654L382.969 234.128Z",
  "M384.631 218C378.206 218 373 223.206 373 229.631C373 236.055 378.206 241.262 384.631 241.262C391.055 241.262 396.262 236.055 396.262 229.631C396.262 223.206 391.055 218 384.631 218ZM384.631 239.6C379.126 239.6 374.662 235.136 374.662 229.631C374.662 224.126 379.126 219.662 384.631 219.662C390.136 219.662 394.6 224.126 394.6 229.631C394.6 235.136 390.136 239.6 384.631 239.6Z",
];
/* Brian's trash, from the swipe-to-remove export, in his own coordinates. */
const BIN = [
  "M373.375 671.375H374.938V680.75H373.375V671.375Z",
  "M378.062 671.375H379.625V680.75H378.062V671.375Z",
  "M367.125 666.688V668.25H368.688V683.875C368.688 684.289 368.852 684.687 369.145 684.98C369.438 685.273 369.836 685.438 370.25 685.438H382.75C383.164 685.438 383.562 685.273 383.855 684.98C384.148 684.687 384.312 684.289 384.312 683.875V668.25H385.875V666.688H367.125ZM370.25 683.875V668.25H382.75V683.875H370.25Z",
  "M379.625 663.562H373.375V665.125H379.625V663.562Z",
];

const CHECK_FULL =
  "M384.5 218C382.226 218 380.002 218.674 378.111 219.938C376.22 221.202 374.746 222.998 373.875 225.099C373.005 227.2 372.777 229.513 373.221 231.744C373.665 233.974 374.76 236.023 376.368 237.632C377.977 239.24 380.026 240.335 382.256 240.779C384.487 241.223 386.8 240.995 388.901 240.125C391.002 239.254 392.798 237.78 394.062 235.889C395.326 233.998 396 231.774 396 229.5C396 226.45 394.788 223.525 392.632 221.368C390.475 219.212 387.55 218 384.5 218ZM382.857 234.092L378.75 229.985L380.057 228.679L382.857 231.479L388.944 225.393L390.255 226.696L382.857 234.092Z";

/** The Trips screen, measured off Brian's Tabulator-trips-main export.
 *
 *  Two blocks. Favourites at the top — the same results table as the mountains
 *  screen, on the same column grid, with his 10x10 star before each name and a
 *  two-dot pager beneath. Then the trips themselves, in full-bleed rows that
 *  match the Add-to-trip panel, ending in a ghosted New trip row. */
export default function Trips({
  trips, favs, data, metric, onOpen, onNewTrip, onEditTrip, onRemoveTrip, onOpenTrip,
}) {
  const [page, setPage] = useState(0);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [swiped, setSwiped] = useState(null);   // id of the row showing its bin
  const field = useRef(null);
  const swipe = useRef(null);

  /* Swipe a row left to uncover the delete panel, the way iOS does. The panel
     is always in the DOM behind the row, so the gesture only has to move the
     row — no measuring, and it can follow the finger exactly. */
  const SWIPE = 25;
  const down = (id) => (e) => {
    swipe.current = { id, x: e.clientX, y: e.clientY, moved: false };
  };
  const move = (e) => {
    const d = swipe.current;
    if (!d) return;
    // A mostly-vertical drag is the page scrolling, not a swipe. Let it go.
    if (!d.moved && Math.abs(e.clientY - d.y) > Math.abs(e.clientX - d.x)) {
      swipe.current = null;
      return;
    }
    if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
  };
  const up = (e) => {
    const d = swipe.current;
    swipe.current = null;
    if (!d || !d.moved) return;
    const dx = e.clientX - d.x;
    if (dx < -SWIPE) setSwiped(d.id);
    else if (dx > SWIPE) setSwiped(null);
  };

  useEffect(() => { if (naming) field.current?.focus(); }, [naming]);

  const commit = () => {
    const name = draft.trim();
    if (!name) return;
    onNewTrip(name);
    setDraft("");
    setNaming(false);
  };

  /* Favourites keep the order they were starred in, not snowfall order — the
     design shows the deepest resort last, highlighted in place rather than
     promoted, which is the same reading as the results-table PDF. */
  const rows = favs.map((n) => data.find((r) => r.name === n)).filter(Boolean);

  const empty = rows.length === 0;

  return (
    <div className={`trips${empty ? " empty" : ""}`}>
      <div className="fav-head">
        <div>
          <h2>Favorites</h2>
          {/* Nothing to describe a window over until the table has something
              in it, so the subtitle only exists in the populated state. */}
          {!empty && <p>Next 6 days</p>}
        </div>
        <button className="fav-edit">Edit</button>
      </div>

      <div className="fav-rule" />

      {empty ? (
        <p className="fav-empty">
          Set ya faves, homie. Open a resort and tap the star to save and see it here.
        </p>
      ) : (
        <>
          {page === 0
            ? <Table data={rows} metric={metric} onOpen={onOpen} favs={favs} />
            : <Chart data={rows} metric={metric} />}
          <div className="fav-dots" role="group" aria-label="Favourites view">
            {[0, 1].map((i) => (
              <button
                key={i}
                className={page === i ? "on" : ""}
                onClick={() => setPage(i)}
                aria-current={page === i}
                aria-label={i === 0 ? "Table" : "Chart"}
              />
            ))}
          </div>
        </>
      )}

      <div className="trip-list">
        {trips.map((t) => (
          <div
            className={`tp-wrap${swiped === t.id ? " swiped" : ""}`}
            key={t.id}
            onPointerDown={down(t.id)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => { swipe.current = null; }}
          >
            <button
              className="tp-bin"
              onClick={() => { setSwiped(null); onRemoveTrip(t.id); }}
              tabIndex={swiped === t.id ? 0 : -1}
              aria-label={`Remove ${t.name}`}
            >
              <svg viewBox="367.125 663.562 18.75 21.876" aria-hidden="true">
                {BIN.map((d) => <path key={d.slice(0, 14)} d={d} />)}
              </svg>
            </button>
            {/* The row itself opens the trip. A swipe must not count as a
                tap, or uncovering the bin would navigate away from the list
                you are trying to delete from. */}
            <div
              className="tp-row"
              role="button"
              tabIndex={0}
              onClick={() => { if (!swiped) onOpenTrip(t.id); }}
              onKeyDown={(e) => { if (e.key === "Enter") onOpenTrip(t.id); }}
            >
              <span className="tp-name">{t.name}</span>
              <span className="tp-when">{t.label}</span>
              {/* Every named trip gets one, matching the Favorites link. */}
              <button
                className="tp-edit"
                onClick={(e) => { e.stopPropagation(); onEditTrip(t.id); }}
              >Edit</button>
            </div>
          </div>
        ))}
        {naming ? (
          <div className="tp-row tp-new naming">
            <input
              ref={field}
              className="tp-field"
              value={draft}
              aria-label="Name this trip"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") { setDraft(""); setNaming(false); }
              }}
            />
            {/* Ring until there is something to save, filled once there is. */}
            <button
              className="tp-check"
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
          <button className="tp-row tp-new" onClick={() => setNaming(true)}>
            <span className="tp-name">New trip</span>
            <span className="tp-plus" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
