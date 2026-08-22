import { useEffect, useRef } from "react";
import { HORIZON_DAYS } from "../lib/constants.js";

/** Horizontal number wheel. The selected value sits centre-stage; its
 *  neighbours bleed off both edges so the range is felt, not read.
 *  This is the signature interaction — see docs/DESIGN.md.
 *
 *  The range now stops at Snow-Forecast's 6-day horizon. It used to run to 14
 *  on Open-Meteo's 16-day window, most of which the app then had to disclaim. */
export default function DaysWheel({ value, onChange }) {
  const ref = useRef(null);
  const settle = useRef(null);
  const mounted = useRef(false);
  const opts = Array.from({ length: HORIZON_DAYS }, (_, i) => i + 1); // 1…6

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[opts.indexOf(value)];
    if (item) el.scrollLeft = item.offsetLeft - (el.clientWidth - item.clientWidth) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(settle.current), []);

  /* A vertical mouse wheel does not scroll a horizontal container, and
     nudging scrollLeft directly fights `scroll-snap-type: mandatory` — the
     snap pulls it straight back. Step the selection instead and let the
     browser animate to the snap point, which is what the gesture means. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      acc += d;
      if (Math.abs(acc) < 40) return;
      const step = acc > 0 ? 1 : -1;
      acc = 0;
      const i = opts.indexOf(value) + step;
      if (i >= 0 && i < opts.length) onChange(opts[i]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [value, onChange, opts]);

  /* Keep the selected numeral centred whenever it changes from outside the
     scroll gesture — a wheel step, a click, or the arrow keys. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[opts.indexOf(value)];
    if (item) item.scrollIntoView({ inline: "center", block: "nearest",
      behavior: mounted.current ? "smooth" : "auto" });
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onScroll = () => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let bestD = Infinity;
      Array.from(el.children).forEach((c, i) => {
        const d = Math.abs(c.offsetLeft + c.clientWidth / 2 - mid);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (opts[best] !== value) onChange(opts[best]);
    }, 90);
  };

  return (
    <div className="wheel" ref={ref} onScroll={onScroll} role="group" aria-label="Number of days">
      {opts.map((n) => (
        <button
          key={n}
          className={`wheel-n${n === value ? " on" : ""}`}
          onClick={() => onChange(n)}
          onKeyDown={(e) => {
            const i = opts.indexOf(value);
            if (e.key === "ArrowRight" && i < opts.length - 1) onChange(opts[i + 1]);
            if (e.key === "ArrowLeft" && i > 0) onChange(opts[i - 1]);
          }}
          aria-pressed={n === value}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
