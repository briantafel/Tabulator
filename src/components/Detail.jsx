import { useEffect, useRef, useState } from "react";
import { snowWithUnit, tempTxt, windTxt, elevTxt, cmToIn, snowUnit } from "../lib/units.js";
import { shortDate, weekdayShort } from "../lib/dates.js";
import { rainRisk, windSeverity, tempSeverity } from "../lib/scoring.js";
import { resortVerdict } from "../lib/verdict.js";
import { resortVoice } from "../lib/voice.js";
import { copyVoice } from "../lib/flags.js";
import { toDays, sfDays, iconPaths, shortLabel } from "../lib/wx.js";
import { reportsFor, reportDate, REPORT_DAYS } from "../lib/reports.js";
import { snowpack } from "../lib/depths.js";
import Dot from "./Dot.jsx";
import { CHECK_RING, CHECK_FULL, CAL_FRAME, CAL_PLUS, CAL_X, RT_X } from "./tripIcons.js";

/* Brian's exports. Filled paths; the clipPath wrapper Figma emits is dropped
   and the fills become currentColor so the button state drives the colour. */
const STAR =
  "M8.83977 0.693242C9.1378 -0.230842 10.4452 -0.230841 10.7432 0.693242L12.3595 5.7047C12.4929 6.11855 12.8785 6.39871 13.3134 6.39776L18.579 6.38625C19.5499 6.38413 19.954 7.62756 19.1672 8.19655L14.9005 11.2823C14.5481 11.5371 14.4008 11.9904 14.5361 12.4037L16.1742 17.408C16.4763 18.3308 15.4185 19.0993 14.6343 18.5269L10.3811 15.4225C10.0298 15.1661 9.55318 15.1661 9.20195 15.4225L4.94874 18.5269C4.16447 19.0993 3.10675 18.3308 3.40881 17.408L5.04692 12.4037C5.1822 11.9904 5.03491 11.5371 4.68256 11.2823L0.415816 8.19655C-0.370946 7.62756 0.033069 6.38413 1.00402 6.38625L6.26964 6.39776C6.70448 6.39871 7.09009 6.11855 7.22355 5.7047L8.83977 0.693242Z";

export default function Detail({
  r, metric, onClose, fav, onFav, trips, onAddToTrip, onNewTrip, onRemoveFromTrip,
  reports, weather, wxSource = "nws",
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [max, setMax] = useState(false);
  const field = useRef(null);
  const body = useRef(null);
  const sheet = useRef(null);
  const drag = useRef(null);
  /* True only while a press that STARTED on the backdrop is still in flight.
     Everything else the scrim sees began inside the sheet. */
  const fromScrim = useRef(false);
  /* Whether the sheet is actually on screen. Declared up here because the
     body-scroll lock below is an effect and cannot sit after the early
     return that uses the same test. */
  const shown = !!r && !!r.win?.length;
  useEffect(() => { setAdding(false); setNaming(false); setDraft(""); setMax(false); }, [r]);

  /* Brian: "the grabber on the resort sheet is fussy. When trying to use it,
     the page underneath scrolls sometimes."
     touch-action on the handle stops the browser claiming the gesture, but it
     cannot stop the page from having scrolled already — the results list
     behind the scrim is a perfectly ordinary scrolling document, and on iOS a
     drag that starts anywhere over it moves it. Locking the body for as long
     as the sheet is open is the only thing that actually holds.
     The scroll position is restored on close: setting overflow hidden makes
     the document jump to the top otherwise, and reopening a sheet should not
     lose your place in the table.

     GATED ON `shown`. This component is mounted for the whole life of the
     app and returns null when there is no resort to show, so an effect with
     an empty dependency list locks the body once, at startup, and never
     lets go — which is exactly what happened: nothing scrolled anywhere,
     sheet or no sheet. The lock has to come and go with the sheet. */
  useEffect(() => {
    if (!shown) return undefined;
    const y = window.scrollY;
    const { overflow, position, top, width } = document.body.style;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${y}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.position = position;
      document.body.style.top = top;
      document.body.style.width = width;
      window.scrollTo(0, y);
    };
  }, [shown]);
  useEffect(() => { if (naming) field.current?.focus(); }, [naming]);
  /* Restoring while scrolled would leave the resting sheet showing day four
     and no way back — the scroller is gone at that height. */
  useEffect(() => { if (!max && body.current) body.current.scrollTop = 0; }, [max]);

  useEffect(() => {
    // Escape backs out one layer at a time: naming, panel, size, sheet.
    const k = (e) => {
      if (e.key !== "Escape") return;
      if (naming) return setNaming(false);
      if (adding) return setAdding(false);
      if (max) return setMax(false);
      onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, adding, naming, max]);

  if (!shown) return null;
  const dayMax = Math.max(0.1, ...r.win.map((d) => d.snow ?? 0));
  /* Two voices for the summary while Brian reads the new one. "classic" is
     the old sentence; voice.js has been the default since 2026-10-31.
     ?copy=classic switches one browser back, ?copy=next undoes that. */
  const verdict = (copyVoice() === "next" ? resortVoice : resortVerdict)(r, metric);
  /* NWS covers the United States only, so most resorts have nothing here
     yet and the section simply does not render — a strip of six dashes
     would be worse than no strip. */
  /* Settings picks the row's source. Snow-Forecast covers every resort;
     the "NWS" setting is the forecasters' row — the NWS for US resorts and
     Environment Canada for the Canadian four (since 2026-10-31). */
  const pack = snowpack(r);
  /* Depths are whole numbers in the design — 5", 15" — not the forecast's
     one decimal place. */
  const depth = (cm) => `${Math.round(metric ? cm : cmToIn(cm))}${snowUnit(metric)}`;

  const wx = wxSource === "sf"
    ? sfDays(r.days)
    : toDays(weather?.resorts?.[r.id]?.periods ?? []);

  /* Which trips already carry this resort. The calendar button reads off
     this: a plus while it is in none, a red X once it is in one. */
  const inTrips = (trips ?? []).filter((t) => t.resorts?.some((x) => x.name === r.name));
  const booked = inTrips.length > 0;
  const said = reportsFor(reports, r.id);

  /* Drag the handle. The sheet follows the finger the whole way — an iOS
     sheet that only jumps on release does not read as draggable at all, which
     is what Brian hit: "it currently doesn't slide to expand".
     Pointer events cover mouse and touch together, and pointer capture keeps
     the moves coming after the finger leaves the 24pt handle. */
  const GRAB = 40;                       // a tap that wanders is still a tap
  const REST = 0.48;                     // fractions of the frame height
  const TALL = 0.8524;                   // 745 of 874, from the export

  const down = (e) => {
    const el = sheet.current;
    if (!el) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: el.getBoundingClientRect().height, moved: false };
    fromScrim.current = false;
    el.classList.add("dragging");
  };

  const move = (e) => {
    const d = drag.current, el = sheet.current;
    if (!d || !el) return;
    const dy = d.y - e.clientY;                       // up is positive
    if (Math.abs(dy) > 4) d.moved = true;
    if (!d.moved) return;
    const frame = window.innerHeight;
    // Clamped so it can never be dragged taller than the design or shorter
    // than its own resting height; past-the-end rubber banding is not in the
    // design and would only invite a drag-to-dismiss we do not have.
    const h = Math.min(frame * TALL, Math.max(frame * REST, d.h + dy));
    el.style.height = `${h}px`;
    d.h2 = h;
  };

  /* Move to a height, visibly.
   *
   * Brian: "the grabber should result in a smooth motion maximization of the
   * resort sheet, not a sudden expansion. Same with dragging it down."
   *
   * The transition was already declared and did nothing, because at rest the
   * sheet has NO height — it is a content-sized flex column — and CSS cannot
   * transition to or from `auto`. Every toggle was a jump from an implicit
   * height to a computed one, which the browser renders as a cut.
   *
   * So both ends are made concrete before anything moves: measure where it
   * is, apply the class and measure where it is going, snap back to the
   * start, force a reflow so the browser actually registers that start, then
   * set the target. The inline height is handed back after the transition so
   * the sheet can still respond to content and to rotation.
   *
   * The class is toggled directly rather than waiting for setMax, because the
   * measurement has to happen in this frame — a React re-render is a frame
   * too late and would measure the height we are trying to animate away
   * from. setMax still runs, and re-renders to the same class. */
  const settle = (next) => {
    const el = sheet.current;
    if (!el) return setMax(next);

    const from = el.getBoundingClientRect().height;
    el.style.height = "";
    el.classList.toggle("max", next);
    const to = el.getBoundingClientRect().height;

    if (Math.abs(to - from) > 1) {
      /* Reading `to` above forced a layout, so the browser now considers the
         target to BE the current height. Snapping back to `from` therefore
         starts a transition away from it, and setting `to` a line later just
         retargets that transition to where it already was — net zero, no
         movement. That is exactly why expanding jumped while collapsing
         happened to animate.
         So the start is committed with transitions switched off, and only
         then are they handed back. */
      el.style.transition = "none";
      el.style.height = `${from}px`;
      void el.offsetHeight;                           // commit the start
      el.style.transition = "";
      el.style.height = `${to}px`;
      const done = (ev) => {
        if (ev.propertyName !== "height") return;
        el.style.height = "";
        el.style.transition = "";
        el.removeEventListener("transitionend", done);
      };
      el.addEventListener("transitionend", done);
    } else {
      el.style.height = "";
    }
    setMax(next);
  };

  const up = (e) => {
    const d = drag.current, el = sheet.current;
    drag.current = null;
    if (!d || !el) return;
    // Out of dragging FIRST: that class kills the transition, and settle()
    // depends on it.
    el.classList.remove("dragging");
    const dy = d.y - e.clientY;
    if (!d.moved) return settle(!max);                // a tap toggles
    if (dy > GRAB) return settle(true);
    if (dy < -GRAB) return settle(false);
    // Released mid-flight without travelling far: settle to whichever end the
    // sheet is actually nearer, so it never rests at a height it cannot hold.
    const frame = window.innerHeight;
    settle((d.h2 ?? d.h) > frame * ((REST + TALL) / 2));
  };

  /* Brian: "the grabber on the resort sheet should never close the resort
     sheet. That's what the close button is for."
     Two things have to be true for that. The drag itself can only ever move
     between the two heights — it never calls onClose, and it cannot shrink
     the sheet below its resting height. And the BACKDROP must ignore anything
     that began on the sheet: a click is delivered to the nearest common
     ancestor of where the press went down and where it came up, so a drag
     that starts on the handle and finishes past the sheet's edge resolves to
     the scrim and dismisses it. Requiring the press to have started on the
     backdrop closes that off for every gesture, not just this one. */
  const scrimDown = (e) => { fromScrim.current = e.target === e.currentTarget; };
  const scrimUp = (e) => {
    if (drag.current) return;                       // a handle drag is in flight
    if (e.target !== e.currentTarget) return;       // landed on the sheet
    if (!fromScrim.current) return;                 // started on the sheet
    onClose();
  };

  const commit = () => {
    const name = draft.trim();
    if (!name) return;
    onNewTrip(name);
    setNaming(false);
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="scrim" onPointerDown={scrimDown} onClick={scrimUp}>
      <div
        ref={sheet}
        className={`sheet${max ? " max" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={r.name}
      >
        <button
          className="sheet-grab"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onClick={(e) => e.preventDefault()}
          aria-expanded={max}
          aria-label={max ? "Shrink the sheet" : "Expand the sheet"}
        >
          <span aria-hidden="true" />
        </button>

        <div className="sheet-head">
          <div className="sheet-id">
            <h2>{r.name}</h2>
            <p>
              {r.region} · {shortDate(r.win[0].date)}–{shortDate(r.win[r.win.length - 1].date)}
              {r.elevation?.mid != null && <> · mid {elevTxt(r.elevation.mid, metric)}</>}
            </p>
          </div>
          <span className="sheet-total">{snowWithUnit(r.total, metric)}</span>
          <button
            className={`sheet-star${fav ? " on" : ""}`}
            onClick={onFav}
            aria-pressed={!!fav}
            aria-label={fav ? `Unfavourite ${r.name}` : `Favourite ${r.name}`}
          >
            <svg viewBox="0 0 20 19" aria-hidden="true"><path d={STAR} /></svg>
          </button>
        </div>

        {/* Everything between the pinned header and the pinned action row.
            At rest it is exactly as tall as its content; maximized it is the
            scroller, which is the only reason the reports fit at all. */}
        <div className="sheet-body" ref={body}>
          {/* The forecaster's prose used to open this panel. Brian, sending the
              labelled comp: "you'll notice I removed the text summary of the
              conditions and replaced it with labels. That's intentional." The
              column heads say what the four numbers are, which the sentence
              never did, and they cost a fifth of its height. */}

          {/* Brian's Resort Sheet-max-baseTop export: what is already on the
              ground, in its own band between the header rule and the day
              rows. A value we do not have is left out rather than shown as a
              dash or a zero; with none at all the band is not drawn. */}
          {(pack.base != null || pack.top != null || pack.last) && (
            <p className="sheet-pack">
              {pack.base != null && <span>Base: <b>{depth(pack.base)}</b></span>}
              {pack.top != null && <span>Top depth: <b>{depth(pack.top)}</b></span>}
              {pack.last && <span>Last: <b>{shortDate(pack.last)}</b></span>}
            </p>
          )}

          {rainRisk(r) && (
            <p className="sheet-warn">
              Freezing level stays above the mid station all window — expect rain, not snow.
            </p>
          )}

          <div className="sd-list">
            {/* Same labels, same 9pt, same order as the results table's head —
                Brian: "The labels follow the design of the table view of
                resort results." The bar column is unlabelled: it is the same
                number as the one beside it, drawn. */}
            <div className="sd sd-head" aria-hidden="true">
              <span>Day</span>
              <span />
              <span>snow</span>
              <span>&uarr; temp</span>
              <span>&uarr; wind</span>
            </div>
            {r.win.map((d) => (
              <div className="sd" key={d.date}>
                <span className="sd-day">{weekdayShort(d.date)}</span>
                <span className="sd-bar">
                  <span style={{ width: `${((d.snow ?? 0) / dayMax) * 100}%` }} />
                </span>
                <span className="sd-n">{snowWithUnit(d.snow, metric)}</span>
                <span className="sd-n sd-f muted">
                  <Dot kind={tempSeverity(d.tempMax, d.tempMin)} label="Temperature" />
                  {tempTxt(d.tempMax, metric)}°
                </span>
                <span className="sd-n sd-f muted">
                  <Dot kind={windSeverity(d.windMax)} label="Wind" />
                  {windTxt(d.windMax, metric)}
                </span>
              </div>
            ))}
          </div>

          {/* Only in the tall sheet, like the reports below it — the resting
              height is a measured design and the extra room is what these
              sections are FOR.

              The same sentence as the trip page, scoped to this one resort:
              no name (you are on its sheet), no "Overall" line (nothing is
              being recommended over anything), and a concern clause only when
              there is a concern. Same type as .td-verdict, deliberately —
              Brian called it "a slightly modified version of the recommendation
              summary from the trips screen", so it should read as the same
              sentence in a different place, not as a second voice. */}
          {max && verdict && (
            <p className="rs-summary">
              {verdict.map((seg, i) => (seg.hot
                ? <b key={i}>{seg.t}</b>
                : <span key={i}>{seg.t}</span>))}
            </p>
          )}

          {/* The National Weather Service's own read on the mountain, beside
              Snow-Forecast's. Two sources disagreeing is information: NWS
              writes the sky ("Heavy snow", "Mostly cloudy") where
              Snow-Forecast writes the amount, and a week that reads sunny
              here and deep in the bars above is worth a second look.

              Full bleed, unlike everything else in the sheet — six columns
              across the whole 402, which is why the icons run nearly edge to
              edge in Brian's export. */}
          {max && wx.length > 0 && (
            <section className="wx" aria-label="Weather forecast">
              <h3>Weather</h3>
              <div className="wx-row">
                {wx.map((d) => (
                  <div className="wx-day" key={d.date} title={d.short}>
                    <span className="wx-icon" aria-hidden="true">
                      <svg viewBox="0 0 32 32">
                        {iconPaths(d.icon).map((p) => <path key={p.slice(0, 12)} d={p} />)}
                      </svg>
                    </span>
                    <span className="wx-name">{weekdayShort(d.date)}</span>
                    <span className="wx-cond">{shortLabel(d.short)}</span>
                    {/* Low above high, cold above warm — Brian's export, and
                        it reads as a range you scan down rather than as two
                        unrelated numbers. */}
                    <span className="wx-lo">{d.lo == null ? "—" : `${d.lo}°`}</span>
                    <span className="wx-hi">{d.hi == null ? "—" : `${d.hi}°`}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {max && (
            <section className="reports" aria-label="Skier reports">
              <h3>Skier reports</h3>
              {said.length === 0 ? (
                <p className="rep-none">
                  No first-hand reports in the last {REPORT_DAYS} days.
                </p>
              ) : (
                said.map((rep) => (
                  <article className="rep" key={rep.id ?? `${rep.author}-${rep.at}`}>
                    {rep.photo?.src && (
                      <img
                        className="rep-photo"
                        src={rep.photo.src}
                        width={rep.photo.w}
                        height={rep.photo.h}
                        alt={rep.author ? `Skier photo from ${rep.author}` : "Skier photo"}
                        loading="lazy"
                        /* These are OnTheSnow's own CDN URLs, so they can rot,
                           and the published snapshot has no network at all.
                           Hide a photo that fails rather than leaving a broken
                           image icon — the card is already built to read well
                           without one. */
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                    )}
                    {/* OnTheSnow does not expose the reporter's name to the
                        scrape, so most cards have only a date. The row keeps
                        its shape either way — the date stays hard right, where
                        the export puts it, rather than sliding left into the
                        gap and making the section look ragged. */}
                    <div className={`rep-meta${rep.author ? "" : " anon"}`}>
                      {rep.author && <span className="rep-who">{rep.author}</span>}
                      <span className="rep-when">{reportDate(rep.at, rep.age)}</span>
                    </div>
                    {rep.text && <p className="rep-text">{rep.text}</p>}
                  </article>
                ))
              )}
            </section>
          )}
        </div>

        {/* The mirror of Add to trip: the same panel, the same rows, read the
            other way round. Only the trips this resort is actually in appear,
            so there is nothing here to get wrong — tapping the X removes it
            from that trip and the row goes with it. Emptying the list closes
            the panel, because a panel headed "Remove from trip" with nothing
            in it is a dead end. */}
        {removing && (
          <div className="addtrip" role="dialog" aria-label="Remove from trip">
            <h2>Remove from trip</h2>
            {inTrips.map((t) => (
              <div className="at-row" key={t.id}>
                <span className="at-name">{t.name}</span>
                <span className="at-when">{t.label}</span>
                <button
                  className="rt-x"
                  onClick={() => {
                    onRemoveFromTrip(t.id, r.name);
                    if (inTrips.length === 1) setRemoving(false);
                  }}
                  aria-label={`Remove ${r.name} from ${t.name}`}
                >
                  <svg viewBox="373.03 135.06 23.88 23.88" aria-hidden="true">
                    <path d={RT_X} />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Covers everything above the action row — the Close button and the
            calendar-plus stay reachable, which is what the design shows. */}
        {adding && (
          <div className="addtrip" role="dialog" aria-label="Add to trip">
            <h2>Add to trip</h2>
            {trips.map((t) => (
              <button
                key={t.id}
                className="at-row"
                onClick={() => { onAddToTrip(t.id); setAdding(false); }}
              >
                <span className="at-name">{t.name}</span>
                <span className="at-when">{t.label}</span>
              </button>
            ))}
            {naming ? (
              <div className="at-row at-new naming">
                <input
                  ref={field}
                  className="at-field"
                  value={draft}
                  placeholder=""
                  aria-label="Name this trip"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                  }}
                />
                {/* Ring until there is something to save, filled once there is. */}
                <button
                  className="at-check"
                  onClick={commit}
                  disabled={!draft.trim()}
                  aria-label="Save trip name"
                >
                  <svg viewBox="373 218 23.3 23.3" aria-hidden="true">
                    {draft.trim()
                      ? <path d={CHECK_FULL} />
                      : CHECK_RING.map((d) => <path key={d.slice(0, 12)} d={d} />)}
                  </svg>
                </button>
              </div>
            ) : (
              <button className="at-row at-new" onClick={() => setNaming(true)}>
                <span className="at-name">New trip</span>
                <span className="at-plus" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button className="sheet-close" onClick={onClose}>Close</button>
          <button
            className={`sheet-add${(adding || removing) ? " on" : ""}${booked ? " booked" : ""}`}
            onClick={() => (booked ? setRemoving((v) => !v) : setAdding((v) => !v))}
            aria-expanded={adding || removing}
            aria-label={booked ? "Remove from trip" : "Add to trip"}
          >
            <svg viewBox="349 33 24 26" aria-hidden="true">
              <path d={CAL_FRAME} />
              <path d={booked ? CAL_X : CAL_PLUS} />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
