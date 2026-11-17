import { tripRegions, regionParagraph, surfaceChips, regionAvalanche, DANGER, vsNormal } from "../lib/season.js";
import { AvalancheZone, BACKCOUNTRY_NOTE } from "./Avalanche.jsx";
import { snowpack } from "../lib/depths.js";
import { lookAhead, CONF } from "../lib/lookahead.js";
import { snowWithUnit } from "../lib/units.js";
import { shortDate } from "../lib/dates.js";

/** "Shaping up": the season so far for a trip the forecast has not reached
 *  (claude/calendar-shaping-up-plan.md; design on the canvas and in Figma,
 *  2026-11-17). Behind the `season` switch.
 *
 *  The regional paragraph, Looking ahead, the top mountains, every resort's
 *  numbers and the avalanche forecasts behind them. */
export default function ShapingUp({ trip, season, projections = null, resorts, metric, onOpenResort }) {
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

            {(() => {
              const rows = lookAhead(g, { resorts, season, metric, projections });
              if (!rows.length) return null;
              return (
                <div className="su-la">
                  <div className="su-h su-h2"><h3>Looking ahead</h3><span>nearest first</span></div>
                  {rows.map((x) => (
                    <div key={x.horizon} className="su-la-row">
                      <div className="su-la-when">
                        <span className="su-la-h">{x.horizon}{x.beta && <em className="su-beta">Beta</em>}</span>
                        {CONF[x.conf].dots && <span className={`su-la-dots${x.conf === "likely" ? " ink" : ""}`} aria-hidden="true">{CONF[x.conf].dots}</span>}
                        <span className={`su-la-conf${x.conf === "likely" ? " ink" : ""}`}>{CONF[x.conf].label}</span>
                      </div>
                      <p className="su-la-p">{x.segs.map((s, i) => (s.hot ? <b key={i}>{s.t}</b> : <span key={i}>{s.t}</span>))}</p>
                    </div>
                  ))}
                </div>
              );
            })()}

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
                    <span className="su-pct">{vsNormal(s)}</span>
                  </div>
                  <div className="su-stats">
                    <div><i>Base / top</i><b>{sfKnown ? `${sf.base ? sw(sf.base) : "—"} / ${sf.top ? sw(sf.top) : "—"}` : "—"}</b></div>
                    <div><i>Last 7 / 14 d, est.</i><b>{s.new7Cm != null ? sw(s.new7Cm) : "—"} / {s.new14Cm != null ? sw(s.new14Cm) : "—"}</b></div>
                    <div><i>Since a big day</i><b>{s.lastDump ? (s.daysSinceDump === 0 ? shortDate(s.lastDump) : `${s.daysSinceDump} days`) : "None yet"}</b></div>
                    {(() => {
                      /* Avalanche when the zone has a rating (the design's
                         fourth stat); the station's depth until then. */
                      const a = season?.avalanche?.[r.id];
                      return a?.max != null
                        ? <div><i>Avalanche</i><b className={`su-av-${a.max}`}>{a.max} · {DANGER[a.max].slice(0, 5)}{DANGER[a.max].length > 5 ? "." : ""}</b></div>
                        : <div><i>Station depth</i><b>{s.depthCm != null ? sw(s.depthCm) : "—"}</b></div>;
                    })()}
                  </div>
                  {chips.length > 0 && <div className="su-chips">{chips.map((c) => <span key={c}>{c}</span>)}</div>}
                  <p className="su-small">
                    vs {s.station.name} station{s.station.elevationM ? ` (${Math.round(metric ? s.station.elevationM : s.station.elevationM * 3.28084).toLocaleString()} ${metric ? "m" : "ft"})` : ""}
                    {s.depthCm != null && s.depthPctMedian != null ? `: ${sw(s.depthCm)} deep, ${s.depthPctMedian}% of its normal depth for the date` : ""}
                  </p>
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
                    <span>{vsNormal(s, { short: true })}</span>
                    <span>{s.new14Cm != null ? sw(s.new14Cm) : "—"}</span>
                    <span>{s.lastDump ? shortDate(s.lastDump) : "—"}</span>
                  </div>
                ))}
              </div>
              <p className="su-small">A dash means no reading or too early to compare, never zero.</p>
            </>)}
            {(() => {
              const zones = regionAvalanche(g.rows, season);
              if (!zones.length) return null;
              return (
                <div className="su-av">
                  <div className="su-h su-h2"><h3>Avalanche</h3></div>
                  {zones.map((z) => (
                    <AvalancheZone key={`${z.center}${z.zone}`} z={z} />
                  ))}
                  <p className="su-small">{BACKCOUNTRY_NOTE}</p>
                </div>
              );
            })()}
          </section>
        );
      })}

      <p className="su-small su-sources">
        Snowpack, new snow and surface: NRCS SNOTEL, against the 1991–2020 median. New snow is estimated from
        snow water and our snow-to-liquid ratio. Base and top depths: Snow-Forecast. Avalanche: avalanche.org
        and Avalanche Canada. Looking ahead: our forecast, the ECMWF and GFS ensembles, NOAA CPC.
      </p>
    </div>
  );
}
