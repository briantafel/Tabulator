import { useEffect } from "react";
import Table from "./Table.jsx";
import TripWhen from "./TripWhen.jsx";
import ResortSearch from "./ResortSearch.jsx";
import { useResortSearch } from "../lib/useResortSearch.js";
import { GLASS, CAL_FRAME, CAL_PLUS, CAL_X } from "./tripIcons.js";
import { tripVerdict } from "../lib/verdict.js";

/** One trip: its name, its window, and the resorts in it on the same results
 *  table the rest of the app uses.
 *
 *  The resorts are stored on the trip as `{ name, total }` — enough to render
 *  a row label, not enough for a table. They are re-matched against today's
 *  scored data by name, so the numbers here are always current rather than
 *  whatever they were when the resort was added. A resort that has since
 *  fallen out of the feed simply does not appear; showing a stale row would be
 *  worse than showing one fewer. */
export default function TripDetail({
  trip, data, beyond, favs, metric, onOpen, onClose,
  catalog = [], onAddResort, onRemoveResort, onOpenResort,
}) {
  /* Adding from inside the trip. Brian, 2026-10-31: "there needs to be a way
     to add a resort to a trip from within the trip" — the radar's search,
     with the trip calendar in place of the star "so we don't have to open
     the resort sheet to add it". Plus while the resort is not in this trip,
     red X once it is; the name still opens the sheet. */
  const search = useResortSearch();
  const inTrip = (name) => trip.resorts.some((x) => x.name === name);

  useEffect(() => {
    const k = (e) => {
      if (e.key !== "Escape") return;
      if (search.searching) return;          // the field's own Escape closes the search
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, search.searching]);

  const rows = trip.resorts
    .map((r) => data.find((d) => d.name === r.name))
    .filter(Boolean);
  const verdict = tripVerdict(rows, metric);

  return (
    <div className="tripdetail">
      {/* This screen closes the app header with a rule; the others do not.
          It is drawn here rather than on .bar so it comes and goes with the
          screen instead of needing a class on a shared element. */}
      <div className="td-toprule" />

      {search.searching ? (
        <div className="td-search">
          <ResortSearch
            resorts={catalog}
            query={search.query}
            onQuery={search.setQuery}
            onOpen={onOpenResort}
            onClose={search.close}
            action={(r) => {
              const on = inTrip(r.name);
              return (
                <button
                  className={`td-cal${on ? " booked" : ""}`}
                  onClick={() => (on ? onRemoveResort?.(r.name) : onAddResort?.(r))}
                  aria-pressed={on}
                  aria-label={on ? `Remove ${r.name} from ${trip.name}` : `Add ${r.name} to ${trip.name}`}
                >
                  <svg viewBox="349 33 24 26" aria-hidden="true">
                    <path d={CAL_FRAME} />
                    <path d={on ? CAL_X : CAL_PLUS} />
                  </svg>
                </button>
              );
            }}
          />
        </div>
      ) : (
      <>
      <div className="td-head">
        <div className="td-id">
          <h2>{trip.name}</h2>
          {(trip.label || trip.watch) && <p><TripWhen trip={trip} /></p>}
        </div>
        <button className="rd-glass td-glass" onClick={search.open} aria-label={`Add a resort to ${trip.name}`}>
          <svg viewBox="365.427 206.427 20.323 20.323" aria-hidden="true"><path d={GLASS} /></svg>
        </button>
      </div>

      <div className="td-rule" />

      {/* The call, in words. Grey prose, coral where the numbers decided
          something — his design highlights the resort, the total, and the two
          verdicts, and deliberately leaves the day count in the prose. */}
      {/* A trip past the six-day horizon has no forecast to read yet. Saying
          so is the only honest option: the alternative was showing whatever
          window the mountains screen happened to be on, which is the bug this
          replaces. */}
      {beyond && (
        <>
          <p className="td-verdict"><span>These dates are beyond the six-day forecast. Check back closer to the trip.</span></p>
          <div className="td-rule td-rule-2" />
        </>
      )}

      {verdict && (
        <>
          <p className="td-verdict">
            {verdict.map((seg, i) =>
              seg.hot
                ? <b key={i}>{seg.t}</b>
                : <span key={i}>{seg.t}</span>)}
          </p>
          <div className="td-rule td-rule-2" />
        </>
      )}

      {rows.length === 0 ? (
        <p className="fav-empty">
          Nothing in this trip yet. Tap the search above to add a resort.
        </p>
      ) : (
        <Table data={rows} metric={metric} onOpen={onOpen} favs={favs} />
      )}
      </>
      )}
    </div>
  );
}
