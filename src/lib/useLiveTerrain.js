import { useEffect, useMemo, useState } from "react";
import { loadGrids, loadText } from "./terrainGrids.js";
import { drawLive, sheetWindow } from "./terrainLive.js";

const DEFS = /<defs[\s>][\s\S]*?<\/defs>/;

/* The Snow by terrain map drawn on this device for the days the sheet shows (flags.json `terrainLive`).
   state: "off" (flag off or this resort has no grids) | "loading" | "ready" | "failed" (could not fetch or decode:
   the caller falls back to the finished pictures) | "hidden" (the numbers did not add up to the sheet's: no map).
   Never a half-drawn map: `draw` exists only in "ready". */
export function useLiveTerrain(m, sheet, enabled) {
  const on = !!(enabled && m?.live);
  const [data, setData] = useState(null);          // { grids, staticTxt } once fetched
  const [failed, setFailed] = useState(false);
  const B = import.meta.env.BASE_URL;
  const key = m?.live ? `${m.live.grid}|${m.run}` : "";
  useEffect(() => {
    if (!on) return undefined;
    let alive = true;
    setData(null); setFailed(false);
    Promise.all([loadGrids(B, m.live, m.run), loadText(`${B}${m.live.static}?v=${encodeURIComponent(m.run)}`)])
      .then(([grids, staticTxt]) => { if (alive) setData({ grids, staticTxt }); })
      .catch((e) => { console.warn("terrain live: falling back to the finished picture", e); if (alive) setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);

  const win = useMemo(() => sheetWindow(sheet), [sheet]);
  const winKey = win ? `${win.dates.join(",")}|${win.totalCm.toFixed(3)}` : "";
  return useMemo(() => {
    if (!on) return { state: "off" };
    if (failed) return { state: "failed" };
    if (!data) return { state: "loading" };
    let d;
    try { d = drawLive(m.live, data.grids, win); } catch (e) { console.warn("terrain live: draw failed", e); return { state: "failed" }; }
    if (d.hidden) return { state: "hidden", reason: d.hidden };
    const txt = data.staticTxt.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    const defs = (txt.match(DEFS) || [""])[0];
    const rest = txt.replace(DEFS, "");
    return { state: "ready", draw: d, defs, rest, fillMarkup: defs + d.fill, linesMarkup: d.lines + rest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, failed, data, winKey, key]);
}
