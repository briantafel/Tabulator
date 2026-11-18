import { DANGER, avalancheTrend } from "../lib/season.js";

/** One avalanche forecast zone: danger by elevation band, the problems, the
 *  center's link. Shared by Shaping up (one block per zone in a region) and
 *  the resort sheet (the resort's own zone, with its trend).
 *
 *  No rating is shown as "No rating yet", never as Low: missing is not zero. */
export function AvalancheZone({ z, trend = null, trip = true }) {
  return (
    <div className="su-av-zone">
      <div className="su-h">
        <span className="su-av-name">{z.zone ?? z.center}</span>
        {z.link ? <a href={z.link} target="_blank" rel="noreferrer">{z.center}</a> : <span>{z.center}</span>}
      </div>
      {z.max == null ? (
        <p className="su-small">No rating yet{z.offSeason ? ": the center is between seasons" : ": forecasts start when the center opens for the season"}.</p>
      ) : (
        <>
          {[["Above treeline", z.bands?.upper], ["Near treeline", z.bands?.middle], ["Below treeline", z.bands?.lower]].map(([label, v]) => (
            <div key={label} className="su-av-band">
              <span>{label}</span>
              {/* Five steps, lit up to the level in that level's colour: danger is a
                  1–5 rating, not an amount, so no proportional bar (2026-11-18). */}
              <span className="su-av-steps" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((n) => <i key={n} className={v && n <= v ? `su-av-bg-${v}` : ""} />)}
              </span>
              <b>{v ? `${v} ${DANGER[v]}` : "—"}</b>
            </div>
          ))}
          {trend && <p className="su-small su-av-trend">{trend}</p>}
          {z.problems?.length > 0 && (
            <p className="su-prose su-av-p">
              <b className="ink">{z.problems.join(", ")}</b>
              {z.persistent ? (trip ? ". A persistent layer like this can last for weeks, so it is worth watching all the way to your trip." : ". A persistent layer like this can last for weeks; new snow on top of it is when it tends to wake up.") : "."}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export const BACKCOUNTRY_NOTE = "Ratings are for the backcountry. Inside the resort, ski patrol controls the terrain; this matters for sidecountry and anything past the gates.";

/** The resort sheet's section. `stormCm` is the sheet's own forecast for the
 *  next three days; at 30 cm or more we say what heavy snow usually does to
 *  the danger, without predicting the rating — that is the center's call. */
export default function AvalancheSection({ a, stormCm = null }) {
  if (!a) return null;
  const zone = a.zone && !/^[0-9a-f]{20,}$/i.test(a.zone) && a.zone !== "CAIC zone" ? a.zone : null;
  const z = { ...a, zone };
  const trend = avalancheTrend(a.history);
  const storm = typeof stormCm === "number" && stormCm >= 30 && a.max != null;
  return (
    <section className="su-av rs-av" aria-label="Avalanche">
      <h3>Avalanche</h3>
      <AvalancheZone z={z} trend={trend} trip={false} />
      {storm && (
        <p className="su-prose su-av-p">
          A big storm is in the forecast. Heavy new snow and wind usually push the danger up, often for a day or two after it stops, so check the morning forecast before heading past the gates.
        </p>
      )}
      <p className="su-small">{BACKCOUNTRY_NOTE}</p>
    </section>
  );
}

/** The region sheet (Brian, 2026-11-18). A region is not one avalanche
 *  forecast: Tahoe sits in one zone, the Cascades in four from three
 *  centers. One zone → the full block, as on the resort sheet. Several →
 *  one compact row per zone, highest danger first, each naming its resorts,
 *  so nothing reads as a rating for the whole region. `zones` comes from
 *  regionAvalanche(). */
export function PlaceAvalanche({ zones }) {
  if (!zones?.length) return null;
  if (zones.length === 1) {
    const z = zones[0];
    return (
      <section className="su-av rs-av ps-av" aria-label="Avalanche">
        <h3>Avalanche</h3>
        <AvalancheZone z={z} trend={avalancheTrend(z.history)} trip={false} />
        <p className="su-small">{BACKCOUNTRY_NOTE}</p>
      </section>
    );
  }
  /* Unrated zones fold into one line at the end; rated ones get a row,
     titled by the zone, or by its resorts where the center names none
     (CAIC, Avalanche Canada). */
  const rated = zones.filter((z) => z.max != null);
  const unrated = zones.filter((z) => z.max == null);
  return (
    <section className="su-av rs-av ps-av" aria-label="Avalanche">
      <h3>Avalanche</h3>
      <p className="su-small ps-av-lead">These resorts sit in different forecast areas, each rated on its own; there is no single rating for the region.</p>
      {rated.map((z) => (
        <div className="ps-av-row" key={`${z.center}|${z.zone}|${z.resorts.join(",")}`}>
          <div className="ps-av-top">
            <span className="su-av-name">{z.zone ?? z.resorts.join(", ")}</span>
            <b className={`su-av-${z.max}`}>{`${z.max} ${DANGER[z.max]}`}</b>
          </div>
          <p className="su-small">
            {z.link ? <a href={z.link} target="_blank" rel="noreferrer">{z.center}</a> : z.center}
            {z.problems?.length > 0 && ` · ${z.problems.join(", ")}`}
            {z.zone && ` · ${z.resorts.join(", ")}`}
          </p>
        </div>
      ))}
      {unrated.length > 0 && (
        <p className="su-small ps-av-unrated">
          No rating yet: {unrated.map((z, i) => (
            <span key={`${z.center}|${z.zone}|${z.resorts.join(",")}`}>
              {i > 0 && "; "}
              {z.link ? <a href={z.link} target="_blank" rel="noreferrer">{z.zone ?? z.center}</a> : (z.zone ?? z.center)}
              {` (${z.resorts.join(", ")})`}
            </span>
          ))}.
        </p>
      )}
      <p className="su-small">{BACKCOUNTRY_NOTE}</p>
    </section>
  );
}
