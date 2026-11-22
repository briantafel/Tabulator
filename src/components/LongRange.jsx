import { oddsFor } from "../lib/longrange.js";

/** Long range (Brian, 2026-11-22): past the last day the sheet shows in inches, the chance of a big storm, not a number.
 *  Same heading, caption and band styles as Snow by terrain and Avalanche. `days` is the sheet's own dates;
 *  `forecastDays` how many of them are Snow-Forecast's (the rest are projected). Renders nothing when there are no odds
 *  (lib/longrange.js says when). */
export default function LongRange({ lr, id, days, forecastDays, metric }) {
  const o = oddsFor(lr, id, days.map((d) => d.date ?? d));
  if (!o) return null;
  const last = days.length, nF = forecastDays;
  const kind = nF >= last
    ? `Days 1–${nF} are forecast, in inches in the chart above.`
    : `Days 1–${nF} are forecast and days ${nF + 1}–${last} are projected, both in inches in the chart above.`;
  return (
    <section className="tm lr" aria-label="Long range">
      <div className="tm-h"><h3>Long range</h3><span>Days {o.from}–{o.to} · {o.dates}</span></div>
      <div className="su-h lr-kind"><span className="su-av-name">Odds, not inches</span></div>
      {o.rows.map((r) => (
        <div key={r.end} className="su-av-band lr-band">
          <span>{r.label}</span>
          <span className="su-av-steps" aria-hidden="true">
            {[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= r.steps ? "lr-on" : ""} />)}
          </span>
          <b>{r.pct}%</b>
        </div>
      ))}
      <p className="su-small">
        {metric
          ? "Chance of 25 mm or more of water in 72 hours, about 30 cm of snow if it stays cold. Not a snow total."
          : "Chance of 1\" or more of water in 72 hours, about a foot of snow if it stays cold. Not a snow total."}
      </p>
      <p className="su-prose lr-p">Past day {last} we can't give inches we trust, so this shows how likely a big storm is instead. {kind}</p>
      <p className="su-small">
        NOAA's 31-member ensemble{o.winters ? `, corrected against ${o.winters} past winters of SNOTEL data` : ""}. A chance, not a forecast of the amount.
      </p>
    </section>
  );
}
