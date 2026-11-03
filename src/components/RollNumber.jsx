import { useEffect, useLayoutEffect, useRef, useState } from "react";

/* An odometer number (claude/range-chart-spec.md, "Headline number").
   Each digit is a 0–9 strip in a one-line window; a change rolls each digit
   0.5s, staggered 0.16s from the left. Non-digits (the " or cm unit, a
   decimal point) sit still. Digits are matched from the right, so 9 → 12
   keeps the ones column and a new tens column rolls up from 0.

   `fromZero`: on first mount every digit starts at 0 and rolls to its value
   (the intro). Without it, the first value simply appears. */
export default function RollNumber({ text, fromZero = false }) {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  const chars = [...text];
  let order = 0;
  return (
    <span className="rn" role="text" aria-label={text}>
      {chars.map((c, i) => {
        const fromRight = chars.length - i;
        if (!/\d/.test(c)) return <span key={`s${fromRight}`} className="rn-s" aria-hidden="true">{c}</span>;
        const delay = order++ * 0.16;
        // A digit column that appears after the first render (9 → 12 adds
        // a tens column) rolls up from 0, like the intro.
        return <Digit key={`d${fromRight}`} d={Number(c)} delay={delay} start0={fromZero || mounted.current} />;
      })}
    </span>
  );
}

function Digit({ d, delay, start0 }) {
  const [shown, setShown] = useState(start0 ? 0 : d);
  useLayoutEffect(() => {
    if (shown === d) return undefined;
    // Two frames, so the start position is painted before the roll begins.
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setShown(d)); });
    return () => cancelAnimationFrame(id);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="rn-col" aria-hidden="true">
      <span className="rn-strip" style={{ transform: `translateY(${-shown * 10}%)`, transitionDelay: `${delay}s` }}>
        {"0123456789".split("").map((n) => <span key={n}>{n}</span>)}
      </span>
    </span>
  );
}
