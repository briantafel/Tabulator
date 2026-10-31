import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { fromIso } from "../lib/dates.js";
import { snowWithUnit, cellSnowTxt, CELL_KO_FROM } from "../lib/units.js";
import { outlook } from "../lib/outlook.js";
import { readoutMatches } from "../lib/readout.js";
import { GLASS, STAR } from "./tripIcons.js";

/** Where and when snow lands across the whole network.
 *
 *  At six days this reads as "the shape of this week" rather than the
 *  storm-spotting it did over Open-Meteo's sixteen. Whether it still earns a
 *  tab is an open question — see claude/RESUME-HERE.md. */
/* Brian's close X from Tabulator-radar-2, in his own coordinates. */
const CLOSE =
  "M377.414 122L384 115.414L382.586 114L376 120.586L369.414 114L368 115.414L374.586 122L368 128.586L369.414 130L376 123.414L382.586 130L384 128.586L377.414 122Z";

export default function Radar({
  resorts, dates, metric, onPlace, editorial, generatedAt, weather,
  favs = [], onOpen, onToggleFav,
}) {
  /* Resort search — Tabulator-radar, -radar-1, -radar-2. "If I just want to
     know how much it's going to snow at a specific resort." The grid shows
     the top twelve of every resort; this finds the other forty-odd.

     It is the Favorites picker's search wearing the radar's title: the same
     83 bar, full-bleed rule, Resort head and 82 rows (.fs-*). Brian's
     rulings, 2026-10-31:
       - the X shows as soon as search opens, not only once you type
       - results in ink, like the Favorites results
       - the star is its own tap and does not open the sheet
       - closing the sheet comes back here with the search still typed
       - the sheet covers the full forecast (App scores it) */
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hold, setHold] = useState(null);      // the grid's height, kept while searching
  const top = useRef(null);
  const field = useRef(null);

  useEffect(() => { if (searching) field.current?.focus(); }, [searching]);

  const openSearch = () => {
    // The paragraph below must not jump up into the space the grid leaves.
    setHold(top.current?.offsetHeight ?? null);
    setSearching(true);
  };
  const closeSearch = () => { setSearching(false); setQuery(""); };

  /* Contains, case-folded, alphabetical — the same rules as the Favorites
     picker, for the same reason: you are looking for a name you know. */
  const q = query.trim().toLowerCase();
  const matches = q
    ? resorts.filter((r) => r.name.toLowerCase().includes(q)).sort((x, y) => x.name.localeCompare(y.name))
    : [];

  const rows = useMemo(
    () =>
      [...resorts]
        .map((r) => ({
          id: r.id,
          name: r.name,
          days: r.days,
          total: r.days.reduce((s, d) => s + (d.snow ?? 0), 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 12),
    [resorts]
  );

  const max = Math.max(0.5, ...rows.flatMap((r) => r.days.map((d) => d.snow ?? 0)));
  /* Read over every resort, not just the twelve on the grid: a storm in the
     Northeast still belongs in the paragraph. */
  const said = useMemo(() => outlook(resorts, { metric, weather }), [resorts, metric, weather]);

  return (
    <div className="radar">
      <div className="rd-top" ref={top} style={searching && hold ? { minHeight: hold } : undefined}>
      {searching ? (
        <>
          <div className="fs-bar rd-bar">
            <input
              ref={field}
              className="fs-field"
              value={query}
              aria-label="Search resorts"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
            />
            <button className="rd-close" onClick={closeSearch} aria-label="Close search">
              <svg viewBox="368 114 16 16" aria-hidden="true"><path d={CLOSE} /></svg>
            </button>
          </div>
          <div className="fs-rule" />

          {matches.length > 0 && (
            <div className="fs-list rd-results">
              <div className="fs-head">Resort</div>
              {matches.map((r) => {
                const on = favs.includes(r.name);
                return (
                  <div className="tp-row fs-row rd-hit" key={r.id}>
                    <button className="rd-hit-open" onClick={() => onOpen?.(r)}>
                      <span className="tp-name">{r.name}</span>
                    </button>
                    <button
                      className={`fs-star rd-star${on ? " on" : ""}`}
                      onClick={() => onToggleFav?.(r.name)}
                      aria-pressed={on}
                      aria-label={on ? `Unfavourite ${r.name}` : `Favourite ${r.name}`}
                    >
                      <svg viewBox="0 0 19.583 18.601" aria-hidden="true"><path d={STAR} /></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
      <div className="rd-head">
        <h2 className="screen-h">Where it's snowing</h2>
        <button className="rd-glass" onClick={openSearch} aria-label="Search resorts">
          <svg viewBox="365.427 206.427 20.323 20.323" aria-hidden="true"><path d={GLASS} /></svg>
        </button>
      </div>
      <p className="screen-p">
        Next {dates.length} days. Darker means deeper.
      </p>

      {/* Brian's revised radar (Figma 2142:535): a 164 name column, the six
          days sharing what is left, and each day's amount printed in its
          cell — black on the lighter reds, white on the darkest. */}
      <div
        className="rd-grid"
        style={{ gridTemplateColumns: `164px repeat(${dates.length}, minmax(0, 1fr))` }}
      >
        <span />
        {/* Plain labels. They used to start a trip on tap; Brian, 2026-10-31:
            "A trip where? The column is a date." */}
        {dates.map((d) => (
          <span key={d} className="rd-col">{fromIso(d).getDate()}</span>
        ))}

        {rows.map((r) => (
          <Fragment key={r.id}>
            <span className="rd-name">{r.name}</span>
            {r.days.map((d) => {
              const amount = cellSnowTxt(d.snow, metric);
              const alpha = amount ? 0.12 + ((d.snow ?? 0) / max) * 0.88 : 0;
              return (
                <span
                  key={d.date}
                  className={`rd-cell${alpha >= CELL_KO_FROM ? " ko" : ""}`}
                  style={{ background: amount ? `rgba(239,74,56,${alpha})` : "transparent" }}
                  title={`${r.name} · ${snowWithUnit(d.snow, metric)}`}
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
            <div className="rd-read-g">
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
