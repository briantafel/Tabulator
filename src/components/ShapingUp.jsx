import { tripRegions, regionParagraph, surfaceChips } from "../lib/season.js";
import { snowpack } from "../lib/depths.js";
import { snowWithUnit } from "../lib/units.js";
import { shortDate } from "../lib/dates.js";

/** "Shaping up": the season so far for a trip the forecast has not reached
 *  (claude/calendar-shaping-up-plan.md; design on the canvas and in Figma,
 *  2026-11-17). Behind the `season` switch.
 *
 *  This first version shows what public/season.json carries today: the
 *  regional paragraph, the top mountains and every resort's numbers. Looking
 *  ahead and avalanche come next; they are left out rather than faked. */
export default function ShapingUp({ trip, season, resorts, metric, onOpenResort }) {
  const { regions } = tripRegions(trip, resorts, season);
  if (!regions.length) {
    return (
      <div className="su">
        <p className="su-small">No season data for these resorts yet. Shaping up covers US resorts with a SNOTEL station nearby; Canada, the Alps and Japan are coming.</p>
      </div>
    );
  }
  const sw = (cm) => snowWithUnit(cm, metric);
  const asOf = season?.resorts && Object.values(season.resorts)[0]?.asOf;
  const byId = (id) => resorts.find((r) => r.id === id);

  return (
    <div className="su">
      {regions.map((g) => {
        /* Cards: the top three by distinct station. Resorts that share a
           SNOTEL site would show identical numbers side by side (Palisades,
           Sugar Bowl and Northstar all read the Palisades Tahoe pillow);
           the table below still lists every resort. */
        const seen = new Set();
        const top = g.rows.filter(({ s }) => (seen.has(s.station.id) ? false : seen.add(s.station.id))).slice(0, 3);
        return (
          <section key={g.name} className="su-region">
            <p className="su-small su-dynamic">
              {g.leading
                ? (g.pinned
                  ? "Leading region right now, and in your trip."
                  : "Leading region right now. This changes as other regions pull ahead; add a resort or a region to the trip to keep one.")
                : "In your trip."}
            </p>
            <div className="su-h">
              <h3>{g.name.replace(/^the /, "The ")} so far</h3>
              {asOf && <span>as of {shortDate(asOf)}</span>}
            </div>
            <p className="su-prose">
              {regionParagraph(g, metric).map((s, i) => (s.hot ? <b key={i}>{s.t}</b> : <span key={i}>{s.t}</span>))}
            </p>

            <div className="su-h su-h2">
              {g.leading
                ? <><h3>Best of {g.name} so far</h3><span>top {top.length} of {g.rows.length}</span></>
                : <h3>Your resorts here</h3>}
            </div>
            {top.map(({ r, s }, i) => {
              const sf = snowpack(byId(r.id));
              /* Snow-Forecast prints 0 / 0 before a resort reports; that is
                 "not reported", not a bare mountain. */
              const sfKnown = (sf.base ?? 0) > 0 || (sf.top ?? 0) > 0;
              const chips = surfaceChips(s);
              return (
                <button key={r.id} className="su-card" onClick={() => onOpenResort?.(byId(r.id))}>
                  <div className="su-card-h">
                    <span className={`su-name${i === 0 ? " hot" : ""}`}>{r.name}</span>
                    <span className="su-pct">
                      {s.pctReliable && typeof s.swePctMedian === "number" ? `${s.swePctMedian}% of normal` : "early season"}
                    </span>
                  </div>
                  <div className="su-stats">
                    <div><i>Base / top</i><b>{sfKnown ? `${sf.base ? sw(sf.base) : "—"} / ${sf.top ? sw(sf.top) : "—"}` : "—"}</b></div>
                    <div><i>Last 7 / 14 d</i><b>{s.new7Cm != null ? sw(s.new7Cm) : "—"} / {s.new14Cm != null ? sw(s.new14Cm) : "—"}</b></div>
                    <div><i>Since a big day</i><b>{s.lastDump ? (s.daysSinceDump === 0 ? shortDate(s.lastDump) : `${s.daysSinceDump} days`) : "None yet"}</b></div>
                    <div><i>Station depth</i><b>{s.depthCm != null ? sw(s.depthCm) : "—"}</b></div>
                  </div>
                  {chips.length > 0 && <div className="su-chips">{chips.map((c) => <span key={c}>{c}</span>)}</div>}
                  <p className="su-small">vs {s.station.name} station{s.station.elevationM ? ` (${Math.round(metric ? s.station.elevationM : s.station.elevationM * 3.28084).toLocaleString()} ${metric ? "m" : "ft"})` : ""}</p>
                </button>
              );
            })}

            {/* The table earns its place when it lists more than the cards. */}
            {g.rows.length > top.length && (<>
            <div className="su-h su-h2"><h3>Every resort</h3></div>
              <div className="su-table">
                <div className="su-tr su-th"><span>Resort</span><span>vs normal</span><span>14 days</span><span>Last big day</span></div>
                {g.rows.map(({ r, s }, i) => (
                  <div key={r.id} className={`su-tr${i === 0 ? " hot" : ""}`}>
                    <span>{r.name}</span>
                    <span>{s.pctReliable && typeof s.swePctMedian === "number" ? `${s.swePctMedian}%` : "—"}</span>
                    <span>{s.new14Cm != null ? sw(s.new14Cm) : "—"}</span>
                    <span>{s.lastDump ? shortDate(s.lastDump) : "—"}</span>
                  </div>
                ))}
              </div>
              <p className="su-small">A dash means no reading or too early to compare, never zero.</p>
            </>)}
          </section>
        );
      })}

      <p className="su-small su-sources">
        Snowpack, new snow and surface: NRCS SNOTEL, against the 1991–2020 median. New snow is estimated from
        snow water and our snow-to-liquid ratio. Base and top depths: Snow-Forecast.
      </p>
    </div>
  );
}
