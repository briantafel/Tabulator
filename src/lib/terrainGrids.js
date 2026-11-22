import { readGrids } from "./terrainField.js";

/* Fetch and decode a resort's per-day grids (index.json `live`): two small PNGs read back to numbers through a
   canvas. Cached per resort + run, so reopening the sheet costs nothing. Any failure rejects: the caller falls back
   to the finished pictures, never to a half-drawn map. */
const cache = new Map();

async function decode(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close?.();
  return { data, width, height };
}

export function loadGrids(base, live, run) {
  const key = `${live.grid}|${run}`;
  if (!cache.has(key)) {
    const p = Promise.all([decode(`${base}${live.grid}?v=${encodeURIComponent(run)}`), decode(`${base}${live.days}?v=${encodeURIComponent(run)}`)])
      .then(([g, d]) => readGrids(live, g, d));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

/** The text of an SVG file without its <svg> wrapper (defs and groups), for inline use. */
export const svgInner = (txt) => txt.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const textCache = new Map();
export function loadText(url) {
  if (!textCache.has(url)) {
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); });
    p.catch(() => textCache.delete(url));
    textCache.set(url, p);
  }
  return textCache.get(url);
}
