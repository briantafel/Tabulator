import { useEffect, useRef } from "react";

/* Brian's close X from Tabulator-radar-2, in his own coordinates. */
const CLOSE =
  "M377.414 122L384 115.414L382.586 114L376 120.586L369.414 114L368 115.414L374.586 122L368 128.586L369.414 130L376 123.414L382.586 130L384 128.586L377.414 122Z";

/** Find a resort by name — the radar's search, and the same search inside a
 *  trip. Tabulator-radar, -radar-1, -radar-2.
 *
 *  It is the Favorites picker's search: the same 83 bar, full-bleed rule,
 *  Resort head and 82 rows (.fs-*). Brian's rulings, 2026-10-31:
 *    - the X shows as soon as search opens, not only once you type
 *    - results in ink
 *    - the icon on the right is its own tap and never opens the sheet;
 *      the name opens the sheet
 *  What that icon is belongs to the caller: the star on the radar, the trip
 *  calendar inside a trip ("so we don't have to open the resort sheet to
 *  add it"). `action(resort)` renders it.
 *
 *  The query lives in the caller, so closing a sheet opened from here comes
 *  back to the same results. */
export default function ResortSearch({ resorts, query, onQuery, onOpen, onClose, action }) {
  const field = useRef(null);
  useEffect(() => { field.current?.focus(); }, []);

  /* Contains, case-folded, alphabetical — the Favorites picker's rules, for
     its reason: you are looking for a name you already know. */
  const q = query.trim().toLowerCase();
  const matches = q
    ? resorts.filter((r) => r.name.toLowerCase().includes(q)).sort((x, y) => x.name.localeCompare(y.name))
    : [];

  return (
    <>
      <div className="fs-bar rd-bar">
        <input
          ref={field}
          className="fs-field"
          value={query}
          aria-label="Search resorts"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />
        <button className="rd-close" onClick={onClose} aria-label="Close search">
          <svg viewBox="368 114 16 16" aria-hidden="true"><path d={CLOSE} /></svg>
        </button>
      </div>
      <div className="fs-rule" />

      {matches.length > 0 && (
        <div className="fs-list rd-results">
          <div className="fs-head">Resort</div>
          {matches.map((r) => (
            <div className="tp-row fs-row rd-hit" key={r.id}>
              <button className="rd-hit-open" onClick={() => onOpen?.(r)}>
                <span className="tp-name">{r.name}</span>
              </button>
              {action(r)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
