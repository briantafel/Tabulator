import { useEffect } from "react";
import Table from "./Table.jsx";
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
export default function TripDetail({ trip, data, favs, metric, onOpen, onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

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

      <div className="td-head">
        <h2>{trip.name}</h2>
        {trip.label && <p>{trip.label}</p>}
      </div>

      <div className="td-rule" />

      {/* The call, in words. Grey prose, coral where the numbers decided
          something — his design highlights the resort, the total, and the two
          verdicts, and deliberately leaves the day count in the prose. */}
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
          Nothing in this trip yet. Open a resort and tap the calendar to add it.
        </p>
      ) : (
        <Table data={rows} metric={metric} onOpen={onOpen} favs={favs} />
      )}
    </div>
  );
}
