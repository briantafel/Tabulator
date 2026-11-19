import { useEffect, useState } from "react";
import { snowWithUnit } from "../lib/units.js";
import TerrainFullscreen from "./TerrainFullscreen.jsx";

/* Snow by terrain (Brian, 2026-11-19): one resort's skiable terrain on the white
   plaster relief, NBM's 5-day snow split by elevation with our terrain step.
   Below Weather, above Avalanche; square, no rounded corners.

   public/terrain/index.json lists the resorts that have a map (Alta first). A
   map is one NBM run, so it hides itself once that run is more than 48 hours
   old — no section beats a stale picture of snow. Missing index, missing
   resort, missing image: no section, never a placeholder. */
const MAX_AGE_H = 48;
let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch(`${import.meta.env.BASE_URL}terrain/index.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return indexPromise;
}

export default function TerrainMap({ id, metric, zoom = false }) {
  const [m, setM] = useState(null);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadIndex().then((idx) => { if (live) setM(idx?.[id] ?? null); });
    return () => { live = false; };
  }, [id]);
  if (!m || failed) return null;
  const run = new Date(m.run);
  if (!(run > 0) || (Date.now() - run) / 3.6e6 > MAX_AGE_H) return null;
  const day = run.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const src = `${import.meta.env.BASE_URL}${m.img}`;
  const alt = `Five-day snow across ${id} by terrain`;
  return (
    <section className="tm" aria-label="Snow by terrain">
      <div className="tm-h"><h3>Snow by terrain</h3><span>{day} run</span></div>
      <div className="tm-img">
        <img src={src} alt={alt} onError={() => setFailed(true)} />
        {/* Full screen + pan/zoom (Brian, 2026-11-19, Figma 4030:511). flags.json `terrainZoom`. */}
        {zoom && (
          <button type="button" className="tm-expand" onClick={() => setFull(true)} aria-label="Full screen map">
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="M10.5 2H16v5.5M16 2 10.2 7.8M7.5 16H2v-5.5M2 16l5.8-5.8" />
            </svg>
          </button>
        )}
      </div>
      {zoom && full && <TerrainFullscreen src={src} alt={alt} onClose={() => setFull(false)} />}
      <div className="tm-cap">
        <span>{m.label}</span>
        <span>Base <b>{snowWithUnit(m.base_in * 2.54, metric)}</b> · Top <b>{snowWithUnit(m.top_in * 2.54, metric)}</b></span>
      </div>
    </section>
  );
}
