import { depthText } from "../lib/terrainLabels.js";

/* Legend for the full-screen Snow by terrain map (Brian, 2026-11-20): a floating
   card, inset from the screen edges, that lives outside the pan/zoom layer so it
   never moves with the map. Gradient runs lowest -> highest snow on this map; the
   two end values are this map's real minimum and maximum (public/terrain/index.json
   `range_in`), in the viewer's unit. */
export default function TerrainLegend({ range, label, day, metric, nosnow = false }) {
  if (!range || range.length !== 2) return null;
  if (nosnow) {   // under an inch everywhere: no ramp to explain
    return (
      <div className="tmf-legend" role="group" aria-label="Snow by terrain legend">
        <div className="tmf-lg-h"><b>No snow in the 5-day forecast</b><span>{day} run</span></div>
        <div className="tmf-lg-f"><span>{label}</span></div>
      </div>
    );
  }
  return (
    <div className="tmf-legend" role="group" aria-label="Snow by terrain legend">
      <div className="tmf-lg-h"><b>5-day snow</b><span>{day} run</span></div>
      <div className="tmf-lg-bar" aria-hidden="true" />
      <div className="tmf-lg-f">
        <b>{depthText(range[0], metric)}</b>
        <span>{label}</span>
        <b>{depthText(range[1], metric)}</b>
      </div>
    </div>
  );
}
