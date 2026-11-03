import { Fragment, useMemo, useRef, useState } from "react";
import { fromIso } from "../lib/dates.js";
import { snowWithUnit, cellSnowTxt, farCellSnowTxt, purpleAlpha, CELL_KO_FROM } from "../lib/units.js";
import { outlook } from "../lib/outlook.js";
import { readoutMatches } from "../lib/readout.js";
import { GLASS, STAR } from "./tripIcons.js";
import ResortSearch from "./ResortSearch.jsx";
import { useResortSearch } from "../lib/useResortSearch.js";

/** Where and when snow lands across the whole network.
 *
 *  At six days this reads as "the shape of this week" rather than the
 *  storm-spotting it did over Open-Meteo's sixteen. Whether it still earns a
 *  tab is an open question — see claude/RESUME-HERE.md. */
export default function Radar({
  resorts, dates, metric, onPlace, editorial, generatedAt, weather,
  favs = [], onOpen, onToggleFav,
  /* With projections on, the grid alone reaches past Snow-Forecast's six
     days (purple, lightness-matched). The paragraph, the ranking and the
     search stay on the forecast. */
  gridResorts = resorts, gridDates = dates,
}) {
  /* Resort search — "if I just want to know how much it's going to snow at
     a specific resort." The grid shows the top twelve; this finds the rest.
     The sheet it opens covers the full forecast (App scores it). */
  const search = useResortSearch();
  const [hold, setHold] = useState(null);      // the grid's height, kept while searching
  const top = useRef(null);
  const openSearch = () => {
    // The paragraph below must not jump up into the space the grid leaves.
    setHold(top.current?.offsetHeight ?? null);
    search.open();
  };

  const rows = useMemo(
    () =>
      [...gridResorts]
        .map((r) => {
          const byDate = new Map(r.days.map((d) => [d.date, d]));
          return {
            id: r.id,
            name: r.name,
            days: gridDates.map((date) => byDate.get(date) ?? { date, snow: null }),
            // Ranked on the forecast only — projected snow is never scored.
            total: r.days.reduce((s, d) => s + (d.projected ? 0 : d.snow ?? 0), 0),
          };
        })
        .sort((a, b) => b.total - a.total)
        .slice(0, 12),
    [gridResorts, gridDates]
  );
  const far = gridDates.length - dates.length;

  const max = Math.max(0.5, ...rows.flatMap((r) => r.days.map((d) => d.snow ?? 0)));
  /* Read over every resort, not just the twelve on the grid: a storm in the
     Northeast still belongs in the paragraph. */
  const said = useMemo(() => outlook(resorts, { metric, weather }), [resorts, metric, weather]);

  return (
    <div className="radar">
      <div className="rd-top" ref={top} style={search.searching && hold ? { minHeight: hold } : undefined}>
      {search.searching ? (
        <ResortSearch
          resorts={resorts}
          query={search.query}
          onQuery={search.setQuery}
          onOpen={onOpen}
          onClose={search.close}
          action={(r) => {
            const on = favs.includes(r.name);
            return (
              <button
                className={`fs-star rd-star${on ? " on" : ""}`}
                onClick={() => onToggleFav?.(r.name)}
                aria-pressed={on}
                aria-label={on ? `Unfavourite ${r.name}` : `Favourite ${r.name}`}
              >
                <svg viewBox="0 0 19.583 18.601" aria-hidden="true"><path d={STAR} /></svg>
              </button>
            );
          }}
        />
      ) : (
        <>
      <div className="rd-head">
        <h2 className="screen-h">Where it's snowing</h2>
        <button className="rd-glass" onClick={openSearch} aria-label="Search resorts">
          <svg viewBox="365.427 206.427 20.323 20.323" aria-hidden="true"><path d={GLASS} /></svg>
        </button>
      </div>
      <p className="screen-p">
        {far > 0
          ? <>Next {gridDates.length} days, the last {far} <span className="rd-proj">projected</span>. Darker means deeper.</>
          : <>Next {dates.length} days. Darker means deeper.</>}
      </p>

      {/* Brian's revised radar (Figma 2142:535): a 164 name column, the six
          days sharing what is left, and each day's amount printed in its
          cell — black on the lighter reds, white on the darkest. */}
      <div
        className={`rd-grid${gridDates.length > 6 ? " rd-wide" : ""}`}
        style={{ gridTemplateColumns: `${gridDates.length > 6 ? 118 : 164}px repeat(${gridDates.length}, minmax(0, 1fr))` }}
      >
        <span />
        {/* Plain labels. They used to start a trip on tap; Brian, 2026-10-31:
            "A trip where? The column is a date." */}
        {gridDates.map((d) => (
          <span key={d} className="rd-col">{fromIso(d).getDate()}</span>
        ))}

        {rows.map((r) => (
          <Fragment key={r.id}>
            <span className="rd-name">{r.name}</span>
            {r.days.map((d) => {
              const amount = d.projected ? farCellSnowTxt(d.snow, metric) : cellSnowTxt(d.snow, metric);
              const alpha = amount ? 0.12 + ((d.snow ?? 0) / max) * 0.88 : 0;
              const fill = !amount ? "transparent"
                : d.projected ? `rgba(155,89,208,${purpleAlpha(alpha).toFixed(3)})`
                  : `rgba(239,74,56,${alpha})`;
              return (
                <span
                  key={d.date}
                  className={`rd-cell${alpha >= CELL_KO_FROM ? " ko" : ""}`}
                  style={{ background: fill }}
                  title={`${r.name} · ${d.projected ? "~" : ""}${snowWithUnit(d.snow, metric)}${d.projected ? " projected" : ""}`}
                >
                  {amount}
                </span>
              );
            })}
          </Fragment>
        ))}
      </div>
        </>
      )}
      </div>

      {/* The forecaster's paragraph — Brian's Figma 2142:872. Grey prose, red
          where the numbers speak, like the resort sheet's summary. */}
      <p className="rd-outlook">
        {said.map((seg, i) => {
          if (seg.link) {
            return (
              <button key={i} className="rd-place" onClick={() => onPlace?.(seg.link)}>
                {seg.t}
              </button>
            );
          }
          return seg.hot ? <b key={i}>{seg.t}</b> : <span key={i}>{seg.t}</span>;
        })}
      </p>

      {/* The read-out, region by region (claude/radar-readout-spec.md).
          Live for everyone since 2026-10-30 (Brian). Only ever shown when it
          was written from the forecast on screen. Inches only for now. */}
      {readoutMatches(editorial, generatedAt) && (
        <section className="rd-read" aria-label="Read-out">
          {editorial.regions.map((g) => (
            <div key={g.key} className="rd-read-g">
              <h3 className="rd-read-h">{g.title}</h3>
              <p className="rd-read-p">{g.text}</p>
            </div>
          ))}
          {editorial.ahead && (
            <div className="rd-read-g rd-ahead">
              <h3 className="rd-read-h">Looking ahead</h3>
              <p className="rd-read-p">{editorial.ahead.text}</p>
            </div>
          )}
          <p className="rd-read-src">
            {[...editorial.sources, ...(editorial.ahead?.sources ?? [])].map((x) => x.name).join(" · ")}
            {editorial.writer === "claude" ? " · Written by Claude from these sources." : ""}
          </p>
        </section>
      )}
    </div>
  );
}
