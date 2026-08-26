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

/* The magnifier and the star, both from Brian's exports in his own
   coordinates — viewBoxes are set to match rather than the paths rewritten. */
const GLASS =
  "M385.75 225.69L380.086 220.026C381.447 218.392 382.126 216.296 381.981 214.174C381.836 212.052 380.879 210.068 379.308 208.635C377.738 207.201 375.675 206.427 373.549 206.476C371.423 206.524 369.397 207.39 367.894 208.894C366.39 210.398 365.524 212.423 365.476 214.549C365.427 216.675 366.2 218.738 367.634 220.308C369.068 221.879 371.052 222.836 373.174 222.981C375.296 223.126 377.391 222.447 379.025 221.086L384.689 226.75L385.75 225.69ZM367 214.75C367 213.415 367.396 212.11 368.138 211C368.879 209.89 369.933 209.025 371.167 208.514C372.4 208.003 373.757 207.869 375.067 208.13C376.376 208.39 377.579 209.033 378.523 209.977C379.467 210.921 380.11 212.124 380.37 213.433C380.631 214.743 380.497 216.1 379.986 217.333C379.475 218.567 378.61 219.621 377.5 220.363C376.39 221.104 375.085 221.5 373.75 221.5C371.96 221.498 370.245 220.786 368.979 219.521C367.714 218.256 367.002 216.54 367 214.75Z";
const STAR =
  "M8.83977 0.693242C9.1378 -0.230842 10.4452 -0.230841 10.7432 0.693242L12.3595 5.7047C12.4929 6.11855 12.8785 6.39871 13.3134 6.39776L18.579 6.38625C19.5499 6.38413 19.954 7.62756 19.1672 8.19655L14.9005 11.2823C14.5481 11.5371 14.4008 11.9904 14.5361 12.4037L16.1742 17.408C16.4763 18.3308 15.4185 19.0993 14.6343 18.5269L10.3811 15.4225C10.0298 15.1661 9.55318 15.1661 9.20195 15.4225L4.94874 18.5269C4.16447 19.0993 3.10675 18.3308 3.40881 17.408L5.04692 12.4037C5.1822 11.9904 5.03491 11.5371 4.68256 11.2823L0.415816 8.19655C-0.370946 7.62756 0.033069 6.38413 1.00402 6.38625L6.26964 6.39776C6.70448 6.39871 7.09009 6.11855 7.22355 5.7047L8.83977 0.693242Z";

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
  onToggleFav,
}) {
  const [page, setPage] = useState(0);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [swiped, setSwiped] = useState(null);   // id of the row showing its bin
  const field = useRef(null);
  const search = useRef(null);
  const hold = useRef(null);
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
  useEffect(() => { if (picking) search.current?.focus(); }, [picking]);
  useEffect(() => () => clearTimeout(hold.current), []);

  /* Leaving the picker. Brian: "I need a way out of that new Favorites edit
     screen." The check is that way out — and it confirms the way the trip
     editor's does, filling black with the tick knocked out and holding 260ms
     before the screen changes, so the tap registers as a decision rather than
     a disappearance. The Edit link still toggles too; starring is immediate,
     so both are the same action and neither can lose work. */
  const leave = () => {
    setPicking(false);
    setQuery("");
    setConfirmed(false);
  };
  const confirm = () => {
    setConfirmed(true);
    clearTimeout(hold.current);
    hold.current = setTimeout(leave, 260);
  };

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

  /* Picking matches on a plain case-folded substring — Brian's export types
     "Ja" and gets Jackson Hole and Jay Peak, so it is contains, not
     starts-with. An empty field shows no rows at all: the export's search
     state is a bare bar over a rule, not the whole catalogue.
     Alphabetical, not snowfall order: you are looking for a name you already
     have in mind, so the list has to be where you expect it — and the export
     shows Jackson Hole above Jay Peak, which snowfall order would not. */
  const q = query.trim().toLowerCase();
  const matches = q
    ? data
      .filter((r) => r.name.toLowerCase().includes(q))
      .sort((x, y) => x.name.localeCompare(y.name))
    : [];

  return (
    <div className={`trips${empty ? " empty" : ""}${picking ? " picking" : ""}`}>
      <div className="fav-head">
        <div>
          <h2>Favorites</h2>
          {/* Nothing to describe a window over until the table has something
              in it, so the subtitle only exists in the populated state. */}
          {!empty && !picking && <p>Next 6 days</p>}
        </div>
        {/* The same link in both states — Brian's export keeps it reading
            "Edit" while you are searching, so it toggles rather than
            becoming Done. */}
        <button
          className="fav-edit"
          aria-pressed={picking}
          onClick={() => { if (picking) leave(); else setPicking(true); }}
        >Edit</button>
      </div>

      <div className="fav-rule" />

      {picking ? (
        /* ------------------------------------------------------------------
           Adding favourites. Measured off Tabulator-favorites-build-search
           and -results+add: the search row is a trip row in disguise (83 tall,
           23.5/700 text 21 below the rule, icon inset 17), the rule under it
           is full bleed where the Favorites rule above is inset, and the
           results carry the mountains table's own 9px Resort header.
           ------------------------------------------------------------------ */
        <>
          <div className="fs-bar">
            <input
              ref={search}
              className="fs-field"
              value={query}
              placeholder="Search"
              aria-label="Search resorts"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setQuery(""); setPicking(false); }
              }}
            />
            {/* Ghost until you type, ink once you have — same two states as
                the naming row's check. */}
            <span className={`fs-glass${query ? " on" : ""}`} aria-hidden="true">
              <svg viewBox="365.427 206.427 20.323 20.323">
                <path d={GLASS} />
              </svg>
            </span>
          </div>
          <div className="fs-rule" />

          {matches.length > 0 && (
            <div className="fs-list">
              <div className="fs-head">Resort</div>
              {matches.map((r) => {
                const on = favs.includes(r.name);
                return (
                  <button
                    className="tp-row fs-row"
                    key={r.name}
                    onClick={() => onToggleFav(r.name)}
                    aria-pressed={on}
                  >
                    <span className="tp-name fs-name">{r.name}</span>
                    <span className={`fs-star${on ? " on" : ""}`} aria-hidden="true">
                      <svg viewBox="0 0 19.583 18.601"><path d={STAR} /></svg>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Always present, results or not — the way out cannot depend on
              having typed something. Centred, 44.5 across, resting 92 above
              the tab bar; a list long enough to fill the screen pushes it
              below the fold instead, where you scroll to it. */}
          <div className="fs-done">
            <button
              className={`fs-check${confirmed ? " on" : ""}`}
              onClick={confirm}
              aria-label="Done adding favorites"
            >
              <svg viewBox="373 218 23.3 23.3" aria-hidden="true">
                {confirmed
                  ? <path d={CHECK_FULL} />
                  : CHECK_RING.map((d) => <path key={d.slice(0, 12)} d={d} />)}
              </svg>
            </button>
          </div>
        </>
      ) : (
        <>
        {empty ? (
          <p className="fav-empty">
            Set ya faves, homie. Click edit above to search, or open a resort and tap
              the star to save and see it here.
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
        </>
      )}
    </div>
  );
}
