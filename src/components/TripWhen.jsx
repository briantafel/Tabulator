import { BINOCULARS_SM } from "./tripIcons.js";

/** The line under a trip's name: its dates, or — for a watchlist, which has
 *  none — Brian's binoculars and the word "Watchlist". One component so the
 *  Trips list, the trip page and both Add-to-trip panels say the same thing.
 *
 *  The glyph sits inline on the baseline: measured off Tabulator-trips-main,
 *  its foot is on the text's baseline and its top on the cap height. */
export default function TripWhen({ trip, className = "" }) {
  if (!trip.watch) return <span className={className}>{trip.label}</span>;
  return (
    <span className={`${className} tw-watch`.trim()}>
      <svg className="tw-glyph" viewBox="16 612 12 10" aria-hidden="true">
        <path d={BINOCULARS_SM} />
      </svg>
      Watchlist
    </span>
  );
}
