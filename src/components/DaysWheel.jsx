import { useEffect, useRef } from "react";

/** Horizontal number wheel. The selected value sits centre-stage; its
 *  neighbours bleed off both edges so the range is felt, not read.
 *  This is the signature interaction — see docs/DESIGN.md. */
export default function DaysWheel({ value, onChange }) {
  const ref = useRef(null);
  const settle = useRef(null);
  const opts = Array.from({ length: 13 }, (_, i) => i + 2);

  // Centre once on mount. Deliberately not re-run on `value` change: scrolling
  // the wheel is what sets the value, so re-centring would fight the finger.
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
        if (d < bestD) {
          bestD = d;
          best = i;
        }
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
