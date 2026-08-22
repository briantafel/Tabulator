import { useState } from "react";
import Table from "./Table.jsx";
import Chart from "./Chart.jsx";

/** The Trips screen, measured off Brian's Tabulator-trips-main export.
 *
 *  Two blocks. Favourites at the top — the same results table as the mountains
 *  screen, on the same column grid, with his 10x10 star before each name and a
 *  two-dot pager beneath. Then the trips themselves, in full-bleed rows that
 *  match the Add-to-trip panel, ending in a ghosted New trip row. */
export default function Trips({ trips, favs, data, metric, onOpen, onNewTrip }) {
  const [page, setPage] = useState(0);

  /* Favourites keep the order they were starred in, not snowfall order — the
     design shows the deepest resort last, highlighted in place rather than
     promoted, which is the same reading as the results-table PDF. */
  const rows = favs.map((n) => data.find((r) => r.name === n)).filter(Boolean);

  return (
    <div className="trips">
      <div className="fav-head">
        <div>
          <h2>Favorites</h2>
          <p>Next 6 days</p>
        </div>
        {rows.length > 0 && <button className="fav-edit">Edit</button>}
      </div>

      <div className="fav-rule" />

      {rows.length === 0 ? (
        <p className="screen-p">
          No favourites yet. Open a resort and tap the star to keep it here.
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
          <div className="tp-row" key={t.id}>
            <span className="tp-name">{t.name}</span>
            <span className="tp-when">{t.label}</span>
          </div>
        ))}
        <button className="tp-row tp-new" onClick={onNewTrip}>
          <span className="tp-name">New trip</span>
          <span className="tp-plus" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
