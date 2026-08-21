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
  const opts = Array.from({ length: HORIZON_DAYS - 1 }, (_, i) => i + 2); // 2…6

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[opts.indexOf(value)];
    if (item) el.scrollLeft = item.offsetLeft - (el.clientWidth - item.clientWidth) / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(settle.current), []);

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
          aria-pressed={n === value}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
