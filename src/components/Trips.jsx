import { snowTxt } from "../lib/units.js";

/** Saved windows. In-memory only for now — see docs/OPEN-ITEMS.md #3. */
export default function Trips({ trips, metric }) {
  return (
    <div className="trips">
      <h2 className="screen-h">Saved windows</h2>

      {trips.length === 0 ? (
        <p className="screen-p">
          Nothing saved yet. Pick a window on Mountains and save it to compare later.
        </p>
      ) : (
        trips.map((t) => (
          <div className="trip" key={t.label}>
            <span className="trip-when">{t.label}</span>
            <span className="trip-top">{t.top}</span>
            <span className="trip-n">{snowTxt(t.snow, metric)}"</span>
          </div>
        ))
      )}

      {trips.length > 0 && <p className="screen-p sm">Saved for this session only.</p>}
    </div>
  );
}
