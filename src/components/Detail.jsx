import { useEffect, useRef, useState } from "react";
import { snowWithUnit, tempTxt, windTxt, elevTxt } from "../lib/units.js";
import { shortDate, weekdayShort } from "../lib/dates.js";
import { rainRisk, windSeverity, tempSeverity } from "../lib/scoring.js";
import { resortVerdict } from "../lib/verdict.js";
import { reportsFor, reportDate, REPORT_DAYS } from "../lib/reports.js";
import Dot from "./Dot.jsx";

/** Snow-Forecast runs its label straight into the sentence —
 *  "Next 3 days weather summary:Heavy rain (total 24.0mm)…" — so drop the
 *  label and restore the space. */
const tidySummary = (t) =>
  String(t).replace(/^[^:]*summary:\s*/i, "").replace(/([a-z]):(?=[A-Z])/g, "$1: ").trim();

/* Brian's exports. Filled paths; the clipPath wrapper Figma emits is dropped
   and the fills become currentColor so the button state drives the colour. */
const STAR =
  "M8.83977 0.693242C9.1378 -0.230842 10.4452 -0.230841 10.7432 0.693242L12.3595 5.7047C12.4929 6.11855 12.8785 6.39871 13.3134 6.39776L18.579 6.38625C19.5499 6.38413 19.954 7.62756 19.1672 8.19655L14.9005 11.2823C14.5481 11.5371 14.4008 11.9904 14.5361 12.4037L16.1742 17.408C16.4763 18.3308 15.4185 19.0993 14.6343 18.5269L10.3811 15.4225C10.0298 15.1661 9.55318 15.1661 9.20195 15.4225L4.94874 18.5269C4.16447 19.0993 3.10675 18.3308 3.40881 17.408L5.04692 12.4037C5.1822 11.9904 5.03491 11.5371 4.68256 11.2823L0.415816 8.19655C-0.370946 7.62756 0.033069 6.38413 1.00402 6.38625L6.26964 6.39776C6.70448 6.39871 7.09009 6.11855 7.22355 5.7047L8.83977 0.693242Z";
/* The two check states from Brian's exports, kept in his own coordinates —
   the viewBox is set to match rather than the path data rewritten. */
const CHECK_RING = [
  "M382.969 234.128L378.815 229.974L379.99 228.8L382.969 231.78L389.269 225.477L390.446 226.654L382.969 234.128Z",
  "M384.631 218C378.206 218 373 223.206 373 229.631C373 236.055 378.206 241.262 384.631 241.262C391.055 241.262 396.262 236.055 396.262 229.631C396.262 223.206 391.055 218 384.631 218ZM384.631 239.6C379.126 239.6 374.662 235.136 374.662 229.631C374.662 224.126 379.126 219.662 384.631 219.662C390.136 219.662 394.6 224.126 394.6 229.631C394.6 235.136 390.136 239.6 384.631 239.6Z",
];
const CHECK_FULL =
  "M384.5 218C382.226 218 380.002 218.674 378.111 219.938C376.22 221.202 374.746 222.998 373.875 225.099C373.005 227.2 372.777 229.513 373.221 231.744C373.665 233.974 374.76 236.023 376.368 237.632C377.977 239.24 380.026 240.335 382.256 240.779C384.487 241.223 386.8 240.995 388.901 240.125C391.002 239.254 392.798 237.78 394.062 235.889C395.326 233.998 396 231.774 396 229.5C396 226.45 394.788 223.525 392.632 221.368C390.475 219.212 387.55 218 384.5 218ZM382.857 234.092L378.75 229.985L380.057 228.679L382.857 231.479L388.944 225.393L390.255 226.696L382.857 234.092Z";

const CAL_PLUS = [
  "M26.0032 4.00073H22.0027V2.00049H20.0024V4.00073H12.0015V2.00049H10.0012V4.00073H6.00073C4.9006 4.00073 4.00049 4.90084 4.00049 6.00097V26.0033C4.00049 27.1035 4.9006 28.0036 6.00073 28.0036H26.0032C27.1033 28.0036 28.0034 27.1035 28.0034 26.0033V6.00097C28.0034 4.90084 27.1033 4.00073 26.0032 4.00073ZM26.0032 26.0033H6.00073V12.0017H26.0032V26.0033ZM26.0032 10.0014H6.00073V6.00097H10.0012V8.00121H12.0015V6.00097H20.0024V8.00121H22.0027V6.00097H26.0032V10.0014Z",
  "M17.002 17.9995L19 17.9993V19.9998H17.002V22H15.0017V19.9998H13V17.9995H15.0017V15.9993H17.002V17.9995Z",
];

export default function Detail({
  r, metric, onClose, fav, onFav, trips, onAddToTrip, onNewTrip, reports,
}) {
  const [adding, setAdding] = useState(false);
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
  useEffect(() => { setAdding(false); setNaming(false); setDraft(""); setMax(false); }, [r]);
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

  if (!r || !r.win?.length) return null;
  const dayMax = Math.max(0.1, ...r.win.map((d) => d.snow ?? 0));
  const verdict = resortVerdict(r, metric);
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

  const up = (e) => {
    const d = drag.current, el = sheet.current;
    drag.current = null;
    if (!d || !el) return;
    el.classList.remove("dragging");
    el.style.height = "";                             // hand back to the class
    const dy = d.y - e.clientY;
    if (!d.moved) return setMax((v) => !v);           // a tap toggles
    if (dy > GRAB) return setMax(true);
    if (dy < -GRAB) return setMax(false);
    // Released mid-flight without travelling far: settle to whichever end the
    // sheet is actually nearer, so it never rests at a height it cannot hold.
    const frame = window.innerHeight;
    setMax((d.h2 ?? d.h) > frame * ((REST + TALL) / 2));
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
          {/* The forecaster's prose — the thing a raw model output never gives
              you, and the reason for moving off Open-Meteo. */}
          {r.summary?.next3 && <p className="sheet-prose">{tidySummary(r.summary.next3)}</p>}

          {rainRisk(r) && (
            <p className="sheet-warn">
              Freezing level stays above the mid station all window — expect rain, not snow.
            </p>
          )}

          <div className="sd-list">
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
            className={`sheet-add${adding ? " on" : ""}`}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            aria-label="Add to trip"
          >
            <svg viewBox="0 0 32 32" aria-hidden="true">
              {CAL_PLUS.map((d) => <path key={d.slice(0, 12)} d={d} />)}
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
