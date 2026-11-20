import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  clampView, doubleTapTarget, fitView, naturalSize, panBy, pinchStep, zoomAt,
} from "../lib/panzoom.js";
import TerrainLabels from "./TerrainLabels.jsx";
import TerrainLegend from "./TerrainLegend.jsx";
import { FULL } from "../lib/terrainLabels.js";

/* Fullscreen Snow by terrain (Brian, 2026-11-19, Figma 4026:546): the map fills
   the screen edge to edge under a floating title and close button, and can be
   panned and zoomed.

   Gestures: one finger / mouse drag pans, two fingers pinch, wheel (and a
   trackpad pinch, which arrives as ctrl+wheel) zooms about the cursor, double
   tap / double click toggles fit ↔ 2.5×. Keys: + − 0 and the arrows. The view
   is a ref written straight to the picture's transform — React state per
   pointer move would be a re-render per frame for nothing. */

const DOUBLE_MS = 300;
const DOUBLE_PX = 28;
const TAP_SLOP = 8;

/* The picture (2026-11-20): a portrait render sized for this screen. `ref` is its size in
   Figma px at the 402 x 874 reference phone, `focus` the outline's rect (0-1 fractions).
   At fit the outline sits centred in the band between the header and the legend; the
   rest of the render's terrain is there to pan to. No `ref` = the old square picture. */
const GAP = 20;
const SQUARE = [874, 874];

export default function TerrainFullscreen({ src, alt, onClose, title = "Snow by terrain", labels = null, metric = false, legend = null, pic = null, focus = null }) {
  const root = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);
  const closeBtn = useRef(null);
  const view = useRef({ s: 1, x: 0, y: 0 });
  const dims = useRef({ vw: 0, vh: 0, pw: 0, ph: 0 });
  const fit = useRef({ s: 1, x: 0, y: 0 });
  const ref = pic || SQUARE;
  const pointers = useRef(new Map());
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const moved = useRef(false);
  const settle = useRef(0);

  const apply = useCallback((v, animate = false) => {
    view.current = v;
    const el = img.current;
    if (!el) return;
    const { pw, ph } = dims.current;
    el.style.width = `${pw}px`; el.style.height = `${ph}px`;
    el.style.transition = animate ? "transform .26s cubic-bezier(.2,.8,.3,1)" : "none";
    el.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.s})`;
    el.style.setProperty("--tm-s", String(v.s * (pw / ref[0])));   // labels counter-scale: they stay Figma-sized on screen
    if (animate) {
      clearTimeout(settle.current);
      settle.current = setTimeout(() => { if (img.current) img.current.style.transition = "none"; }, 300);
    }
  }, [ref]);

  /* Geometry: viewport, the picture at s = 1, and the fit view for the band the header
     and the legend leave free (measured, so safe areas and a taller legend just work). */
  const measure = useCallback(() => {
    const r = stage.current?.getBoundingClientRect();
    if (!r || !(r.height > 0)) return false;
    const { pw, ph } = naturalSize(ref, r.height);
    dims.current = { vw: r.width, vh: r.height, pw, ph };
    const u = Math.min(1, r.width / 402);
    const top = root.current?.querySelector(".tmf-top")?.getBoundingClientRect();
    const lg = root.current?.querySelector(".tmf-legend")?.getBoundingClientRect();
    const band = {
      side: 15 * u,
      top: (top ? top.bottom - r.top : 44 * u) + GAP * u,
      bottom: (lg ? r.bottom - lg.top : 15 * u) + GAP * u,
    };
    fit.current = fitView(dims.current, focus, band);
    return true;
  }, [ref, focus]);

  /* Fit before first paint, so there is never a frame of the picture at the wrong size. */
  useLayoutEffect(() => {
    if (!measure()) return;
    apply(fit.current);
    const onResize = () => {
      if (!measure()) return;
      apply(clampView(view.current, dims.current));
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); clearTimeout(settle.current); };
  }, [apply, measure]);

  /* Escape closes only this layer. Capture + stopImmediatePropagation: the
     resort sheet underneath also listens for Escape and would close too. */
  useEffect(() => {
    const prior = document.activeElement;
    closeBtn.current?.focus({ preventScroll: true });
    const k = (e) => {
      const g = dims.current, { vw, vh } = g;
      const v = view.current;
      const c = { x: vw / 2, y: vh / 2 };
      if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); onClose(); return; }
      if (e.key === "+" || e.key === "=") apply(zoomAt(v, v.s * 1.5, c.x, c.y, g), true);
      else if (e.key === "-" || e.key === "_") apply(zoomAt(v, v.s / 1.5, c.x, c.y, g), true);
      else if (e.key === "0") apply(fit.current, true);
      else if (e.key === "ArrowLeft") apply(panBy(v, 80, 0, g), true);
      else if (e.key === "ArrowRight") apply(panBy(v, -80, 0, g), true);
      else if (e.key === "ArrowUp") apply(panBy(v, 0, 80, g), true);
      else if (e.key === "ArrowDown") apply(panBy(v, 0, -80, g), true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", k, true);
    return () => {
      window.removeEventListener("keydown", k, true);
      if (prior instanceof HTMLElement) prior.focus({ preventScroll: true });
    };
  }, [apply, onClose]);

  /* Wheel has to be a non-passive native listener to be allowed to preventDefault. */
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const w = (e) => {
      e.preventDefault();
      const g = dims.current;
      const r = el.getBoundingClientRect();
      /* ctrl+wheel is a trackpad pinch: its deltas are small, so it needs more gain. */
      const gain = e.ctrlKey ? 0.01 : 0.0018;
      const lines = e.deltaMode === 1 ? 16 : 1;
      const next = view.current.s * Math.exp(-e.deltaY * lines * gain);
      apply(zoomAt(view.current, next, e.clientX - r.left, e.clientY - r.top, g));
    };
    el.addEventListener("wheel", w, { passive: false });
    return () => el.removeEventListener("wheel", w);
  }, [apply]);

  const local = (e) => {
    const r = stage.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const down = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stage.current.setPointerCapture?.(e.pointerId);
    const at = local(e);
    pointers.current.set(e.pointerId, { ...at, sx: at.x, sy: at.y });
    if (pointers.current.size === 1) moved.current = false;
    else moved.current = true;       // a second finger is never a tap
  };

  const move = (e) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const g = dims.current;
    const n = local(e);
    if (pointers.current.size >= 2) {
      const before = pair();
      pointers.current.set(e.pointerId, { ...p, ...n });
      const after = pair();
      apply(pinchStep(view.current, before.mid, before.dist, after.mid, after.dist, g));
    } else {
      if (Math.hypot(n.x - p.sx, n.y - p.sy) > TAP_SLOP) moved.current = true;
      pointers.current.set(e.pointerId, { ...p, ...n });
      apply(panBy(view.current, n.x - p.x, n.y - p.y, g));
    }
  };

  const up = (e) => {
    const p = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    stage.current?.releasePointerCapture?.(e.pointerId);
    if (!p || e.type === "pointercancel" || moved.current || pointers.current.size > 0) return;
    /* A tap. Two close together toggles zoom. */
    const now = performance.now();
    const t = lastTap.current;
    if (now - t.t < DOUBLE_MS && Math.hypot(p.x - t.x, p.y - t.y) < DOUBLE_PX) {
      const g = dims.current;
      const target = doubleTapTarget(view.current, fit.current.s);
      apply(target === fit.current.s ? fit.current : zoomAt(view.current, target, p.x, p.y, g), true);
      lastTap.current = { t: 0, x: 0, y: 0 };
    } else {
      lastTap.current = { t: now, x: p.x, y: p.y };
    }
  };

  return createPortal(
    <div className="tmf" ref={root} role="dialog" aria-modal="true" aria-label="Snow by terrain, full screen">
      <div
        className="tmf-stage" ref={stage}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      >
        <div ref={img} className="tmf-img">
          <img src={src} alt={alt} draggable={false} />
          {labels && <TerrainLabels labels={labels} metric={metric} S={{ ...FULL, w: ref[0], h: ref[1] }} counter />}
        </div>
      </div>
      {legend && <TerrainLegend {...legend} metric={metric} />}
      <div className="tmf-top">
        <h3>{title}</h3>
        <button type="button" className="tmf-x" ref={closeBtn} onClick={onClose} aria-label="Close full screen map">
          <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 2 16 16M16 2 2 16" /></svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
