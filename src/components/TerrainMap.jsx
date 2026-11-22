import { useEffect, useMemo, useState } from "react";
import { snowWithUnit } from "../lib/units.js";
import TerrainFullscreen from "./TerrainFullscreen.jsx";
import TerrainLabels from "./TerrainLabels.jsx";
import { SHEET, hasVectorLabels } from "../lib/terrainLabels.js";
import { anchorMatches } from "../lib/terrainAnchor.js";
import { useLiveTerrain } from "../lib/useLiveTerrain.js";

/* Snow by terrain (Brian, 2026-11-19): one resort's skiable terrain on the white
   plaster relief, NBM's 5-day snow split by elevation with our terrain step.
   Below Weather, above Avalanche; square, no rounded corners.

   public/terrain/index.json lists the resorts that have a map (Alta first). A
   map is one NBM run, so it hides itself once that run is more than MAX_AGE_H hours
   old — no section beats a stale picture of snow. Missing index, missing
   resort, missing image: no section, never a placeholder. */
/* A map is one forecast run and is redrawn after every run (terrain-refresh.yml, twice a day: a map is 8-23 h old in
   normal service). Past 30 h a refresh has been missed, and a map beside a newer forecast is a trust problem, so hide it
   rather than show old snow. (Was 48 h, Brian 2026-11-22.) */
const MAX_AGE_H = 30;
let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch(`${import.meta.env.BASE_URL}terrain/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return indexPromise;
}

export default function TerrainMap({ id, name = null, metric, zoom = false, vectors = false, live: liveOn = false, sheet = null }) {
  const [m, setM] = useState(null);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadIndex().then((idx) => { if (live) setM(idx?.[id] ?? null); });
    return () => { live = false; };
  }, [id]);
  const lt = useLiveTerrain(m, sheet, liveOn && vectors);
  function renderLive(t) {
    const L = m.live, ready = t.state === "ready", d = t.draw;
    const alt = `Forecast snow across ${id} by terrain, ${ready ? d.label : "loading"}`;
    return (
      <section className="tm" aria-label="Snow by terrain">
        <div className="tm-h"><h3>Snow by terrain</h3><span>{ready ? d.label : ""}</span></div>
        <div className="tm-img">
          <img src={`${B}${L.sheet_relief}`} alt={alt} onError={() => setFailed(true)} />
          {ready && (
            <>
              {/* Same blend as full screen and as the finished picture: the fill multiplies into the relief at .85 */}
              <svg className="tm-vec tm-live tm-live-fill" viewBox={`${L.sheet[0]} ${L.sheet[1]} ${L.sheet[2]} ${L.sheet[2]}`} aria-hidden="true" focusable="false">
                <g dangerouslySetInnerHTML={{ __html: t.fillMarkup }} />
              </svg>
              <svg className="tm-vec tm-live" viewBox={`${L.sheet[0]} ${L.sheet[1]} ${L.sheet[2]} ${L.sheet[2]}`} aria-hidden="true" focusable="false">
                <g dangerouslySetInnerHTML={{ __html: t.linesMarkup }} />
              </svg>
            </>
          )}
          {ready && <TerrainLabels labels={d.sheet} metric={metric} S={SHEET} />}
          {zoom && fullPic0 && ready && (
            <button type="button" className="tm-expand" onClick={() => setFull(true)} aria-label="Full screen map">
              <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M10.5 2H16v5.5M16 2 10.2 7.8M7.5 16H2v-5.5M2 16l5.8-5.8" /></svg>
            </button>
          )}
        </div>
        {zoom && full && ready && fullPic0 && <TerrainFullscreen src={`${B}${fullPic0.img}`} alt={alt} title={name || "Snow by terrain"} metric={metric}
            labels={d.full} pic={fullPic0.ref} focus={fullPic0.focus} vec={{ inline: fullInline, px: fullPic0.px }}
            legend={{ range: d.range_in, label: m.label, day: d.label, nosnow: d.nosnow, anchored: true, midCm: d.mid_cm }} onClose={() => setFull(false)} />}
        {ready && (
          <div className="tm-cap tm-cap-live">
            {d.nosnow ? <span>No snow in the forecast</span>
              : <span>Base <b>{snowWithUnit(d.base_in * 2.54, metric)}</b> · Mid <b className="tm-cap-mid">{snowWithUnit(d.mid_cm, metric)}</b> · Top <b>{snowWithUnit(d.top_in * 2.54, metric)}</b></span>}
            <span>{m.label}</span>
          </div>
        )}
      </section>
    );
  }
  const B = import.meta.env.BASE_URL;
  const fullPic0 = vectors && hasVectorLabels(m) && m?.full?.img ? m.full : null;
  const fullInline = useMemo(() => (lt.state === "ready" ? { fill: lt.fillMarkup, lines: lt.linesMarkup } : null), [lt]);
  if (!m || failed) return null;
  const run = new Date(m.run);
  if (!(run > 0) || (Date.now() - run) / 3.6e6 > MAX_AGE_H) return null;
  /* Drawn by the app (2026-11-22): the map is the sheet's days, whatever they are; its total is the sheet's total by
     construction, and when it cannot be (no grids for those days) the section is hidden. If the grids cannot be fetched
     at all, the finished picture below stands in, behind the same anchor check. */
  if (lt.state === "hidden") return null;
  if (lt.state === "loading" || lt.state === "ready") return renderLive(lt);
  /* Anchored (lib/terrainAnchor.js): shown only when its total IS the sheet's total; its header names its days. */
  if (!anchorMatches(m.anchor, sheet)) return null;
  const day = m.anchor?.label ?? run.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  /* terrainVectors (Brian, 2026-11-20): labels drawn by the app as vectors over a labels-free
     picture. Off, or no label data for this resort: the old picture with labels baked in. */
  const vec = vectors && hasVectorLabels(m);
  const src = `${import.meta.env.BASE_URL}${vec ? m.img_clean : m.img}`;
  /* A portrait render made for the full-screen view (m.full), when the run has one. */
  const fullPic = vec && m.full?.img ? m.full : null;
  const fullSrc = fullPic ? `${B}${fullPic.img}` : src;
  const fullVec = fullPic?.fill && fullPic?.lines ? { fill: `${B}${fullPic.fill}`, lines: `${B}${fullPic.lines}`, px: fullPic.px } : null;
  const alt = m.anchor ? `Forecast snow across ${id} by terrain, ${day}` : `Five-day snow across ${id} by terrain`;
  return (
    <section className="tm" aria-label="Snow by terrain">
      <div className="tm-h"><h3>Snow by terrain</h3><span>{m.anchor ? day : `${day} run`}</span></div>
      <div className="tm-img">
        <img src={src} alt={alt} onError={() => setFailed(true)} />
        {vec && <TerrainLabels labels={m.labels} metric={metric} S={SHEET} />}
        {/* Full screen + pan/zoom (Brian, 2026-11-19, Figma 4030:511). flags.json `terrainZoom`. */}
        {zoom && (
          <button type="button" className="tm-expand" onClick={() => setFull(true)} aria-label="Full screen map">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M10.5 2H16v5.5M16 2 10.2 7.8M7.5 16H2v-5.5M2 16l5.8-5.8" />
            </svg>
          </button>
        )}
      </div>
      {zoom && full && <TerrainFullscreen src={fullSrc} alt={alt} title={name || "Snow by terrain"} metric={metric}
          labels={fullPic ? fullPic.labels : vec ? m.labels : null} pic={fullPic?.ref} focus={fullPic?.focus} vec={fullVec}
          legend={vec && m.range_in ? { range: m.range_in, label: m.label, day, nosnow: !!m.nosnow, anchored: !!m.anchor } : null} onClose={() => setFull(false)} />}
      <div className="tm-cap">
        <span>{m.label}</span>
        {m.nosnow ? <span>No snow in the forecast</span>
          : <span>Base <b>{snowWithUnit(m.base_in * 2.54, metric)}</b> · Top <b>{snowWithUnit(m.top_in * 2.54, metric)}</b></span>}
      </div>
    </section>
  );
}
