import { useEffect } from "react";
import Table from "./Table.jsx";
import TripWhen from "./TripWhen.jsx";
import ResortSearch from "./ResortSearch.jsx";
import { useResortSearch } from "../lib/useResortSearch.js";
import { GLASS, CAL_FRAME, CAL_PLUS, CAL_X } from "./tripIcons.js";
import { tripVerdict } from "../lib/verdict.js";
import { shortDate, rangeLabel } from "../lib/dates.js";

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
  trip, data, win = {}, countdown = null, dates = [], favs, metric, onOpen, onClose,
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
  const { beyond, partial, past } = win;

  /* What stands in for the forecast it does not have yet. Brian, 2026-11-17:
     "Leading up to the trip, this should continue to provide information...
     When the dates enter the forecast window, data can then appear." The
     season-to-date report (claude/calendar-shaping-up-plan.md) goes here;
     until it exists, say plainly how far off the forecast is. */
  /* Segments, like the verdict: the numbers that matter in red so the line
     reads at a glance. Plain grey prose alone all but vanished (Brian tried
     it on the live site, 2026-11-17). */
  const note = past
    ? [{ t: "This trip is over." }]
    : beyond && countdown
      ? [{ t: `${countdown.daysOut} days out.`, hot: true },
         { t: ` The ${countdown.horizon}-day forecast reaches this trip around ` },
         { t: shortDate(countdown.reach), hot: true }, { t: "." }]
      : beyond
        ? [{ t: "These dates are past the forecast. Check back closer to the trip." }]
        : partial
          ? [{ t: "The forecast covers " }, { t: rangeLabel(dates[win.ta], dates[win.tb]), hot: true },
             { t: " so far. The rest of the trip fills in as it arrives." }]
          : null;

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
      {note && (
        <>
          <p className="td-verdict td-note">
            {note.map((seg, i) => (seg.hot ? <b key={i}>{seg.t}</b> : <span key={i}>{seg.t}</span>))}
          </p>
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

      {/* Empty means the trip has no resorts — not that the forecast has
          nothing for them yet. A trip past the forecast used to land here and
          tell you it was empty while holding five resorts. */}
      {trip.resorts.length === 0 ? (
        <p className="fav-empty">
          Nothing in this trip yet. Tap the search above to add a resort, or add a
          whole region from its sheet on the radar.
        </p>
      ) : rows.length === 0 ? (
        <ul className="td-names">
          {trip.resorts.map((r) => {
            const hit = catalog.find((c) => c.name === r.name);
            return (
              <li key={r.name}>
                {hit ? <button onClick={() => onOpenResort?.(hit)}>{r.name}</button> : r.name}
              </li>
            );
          })}
        </ul>
      ) : (
        <Table data={rows} metric={metric} onOpen={onOpen} favs={favs} />
      )}
      </>
      )}
    </div>
  );
}
