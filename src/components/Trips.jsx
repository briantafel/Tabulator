import { snowWithUnit } from "../lib/units.js";

/** Saved trips. A trip is a named container — its own date range, and the
 *  resorts added to it from the detail sheet. In-memory only for now. */
export default function Trips({ trips, metric }) {
  return (
    <div className="trips">
      <h2 className="screen-h">Trips</h2>

      {trips.length === 0 ? (
        <p className="screen-p">
          Nothing saved yet. Open a resort and add it to a trip.
        </p>
      ) : (
        trips.map((t) => (
          <div className="trip" key={t.id}>
            <span className="trip-name">{t.name}</span>
            <span className="trip-when">{t.label}</span>
            {t.resorts.length === 0 ? (
              <span className="trip-empty">No resorts yet</span>
            ) : (
              t.resorts.map((r) => (
                <span className="trip-r" key={r.name}>
                  <span>{r.name}</span>
                  <span className="trip-n">{snowWithUnit(r.total, metric)}</span>
                </span>
              ))
            )}
          </div>
        ))
      )}

      {trips.length > 0 && <p className="screen-p sm">Saved for this session only.</p>}
    </div>
  );
}
