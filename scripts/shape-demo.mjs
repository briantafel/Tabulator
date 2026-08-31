#!/usr/bin/env node
/* Shape the SAMPLE forecast so the ranking argues for itself.
 *
 * Brian's spec, verbatim: "the recommended resort should receive less
 * snowfall that one other with frigid temps and howling winds. It should
 * receive the same amount of snow as another resort with very warm temps.
 * But the recommended resort has stable temps and light wind. No concerns."
 *
 * And then: "every single day is exactly the same … change this back to
 * randomized but realistic data for each day and each resort."
 *
 * So the numbers vary day to day and resort to resort — storms arrive, peak
 * and pass, temperatures drift, wind gusts and drops — while the three
 * relationships above still hold. They are held by CONSTRAINT rather than by
 * flattening: every series is drawn at random, then the running totals are
 * checked from the third day out, and a draw that would let the wrong resort
 * lead is thrown away and redrawn. If four hundred draws cannot satisfy a
 * resort, its shape is blended toward the pick's until it can, which cannot
 * fail: a series proportional to the pick's keeps the ordering of the totals
 * at every prefix by construction.
 *
 * The check deliberately skips the FIRST day. Holding the ordering from a
 * single day forces every resort onto the pick's own storm shape — one big
 * day, the same big day, everywhere — which is the flat fixture all over
 * again in a different disguise. A one-day window is a coin toss in real
 * weather too; from two days out the argument is the one Brian asked for.
 *
 * The randomness is SEEDED. Two runs of this script produce the same fixture,
 * so a rebuilt snapshot differs from the last one only where the code did.
 *
 *   node scripts/shape-demo.mjs [forecast.json] [history.json]
 */
import { readFile, writeFile } from "node:fs/promises";
const IN = (i) => i * 2.54, F = (f) => ((f - 32) * 5) / 9, MPH = (m) => m * 1.60934;

/* mulberry32 — small, fast, and good enough for a fixture. Seeded so the
   demo is reproducible; nothing here needs cryptographic randomness. */
const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const fPath = process.argv[2] ?? "public/forecast.json";
const hPath = process.argv[3] ?? "public/history.json";
const f = JSON.parse(await readFile(fPath, "utf8"));
const h = JSON.parse(await readFile(hPath, "utf8"));

/* Inches PER DAY on average, °F, mph. The averages are what the old flat
   version used; only the distribution across the days is new. */
const CAST = {
  // The pick. Not the most snow, not the least — the only one with nothing
  // wrong with it, and the best base underneath. Its bands are chosen to
  // clear every amber threshold: never colder than 10F, never warmer than
  // 31F, never windier than 18mph. "No concerns" has to be literally true.
  telluride: { rate: 7.5, hi: [22, 30], lo: [11, 18], wind: [5, 16] },
  // The most snow on the board by a distance, and it still loses. Deliberately
  // just INSIDE both deal breakers — never below -9F against a -10 veto, never
  // above 44mph against 45 — because a vetoed resort sorts dead last and the
  // whole demonstration ends up ten rows below the fold where nobody sees it.
  // Brian: "Move Alta's numbers."
  alta: { rate: 10, hi: [1, 12], lo: [-9, -2], wind: [30, 44] },
  // The same snowfall as the pick, decided entirely on temperature. Warm
  // enough to be marked red (above 34F) and still short of the 40F veto.
  heavenly: { rate: 7.5, hi: [35, 39], lo: [26, 33], wind: [7, 16] },
};
/* Everyone else: a spread of averages, no two alike, all below the pick. */
const REST = [5.5, 5.1, 4.8, 4.4, 4.1, 3.8, 3.4, 3.1, 2.8, 2.4, 2.1, 1.8,
              1.5, 1.3, 1.1, 0.9, 0.7, 0.5, 0.3, 0.2];

const sum = (a) => a.reduce((x, y) => x + y, 0);
const cum = (a) => a.reduce((acc, x) => (acc.push((acc.at(-1) ?? 0) + x), acc), []);

/* A storm cycle across the window: one or two systems, a peak, quiet days
   either side. Weights only — the caller scales them to the total it wants. */
function stormShape(n, rnd) {
  const phase = rnd() * Math.PI * 2;
  const cycles = 0.8 + rnd() * 1.4;
  const w = [];
  for (let i = 0; i < n; i++) {
    const s = 0.5 + 0.5 * Math.sin(phase + (i / n) * cycles * Math.PI * 2);
    w.push(Math.max(0.18, s ** 1.3 * (0.6 + 0.8 * rnd())));
  }
  return w;
}
const scaleTo = (w, total) => { const k = total / sum(w); return w.map((x) => x * k); };
const blend = (w, ref, m) => w.map((x, i) => x * (1 - m) + ref[i] * m);

/* Draw a series summing to `total` whose cumulative curve satisfies `ok` at
   every window length. Falls back to blending toward the pick's curve, which
   always satisfies an ordering that the totals already satisfy. */
function draw(n, total, rnd, ok, ref) {
  for (let i = 0; i < 400; i++) {
    const w = scaleTo(stormShape(n, rnd), total);
    if (ok(cum(w))) return w;
  }
  const refShape = scaleTo(ref, total);
  for (let m = 0.1; m <= 1.0001; m += 0.1) {
    const w = scaleTo(blend(stormShape(n, rnd), refShape, m), total);
    if (ok(cum(w))) return w;
  }
  return refShape;
}

/* Move a series' extreme day to the front.
   The window's MIN temperature and MAX wind are what the ranking reads, so a
   resort whose cold snap lands on day five looks mild at any window shorter
   than five days — and Alta, which is supposed to lose on conditions at every
   window, quietly won the four-day one because its worst day had not arrived
   yet. Putting the extreme first makes the window read the same whatever its
   length, without flattening the other five days. */
const extremeFirst = (a, pick) => {
  const j = a.indexOf(pick(...a));
  const out = a.slice();
  [out[0], out[j]] = [out[j], out[0]];
  return out;
};

/* A drifting value inside a band: neither a flat line nor white noise. */
function wander(n, [lo, hi], rnd) {
  const mid = (lo + hi) / 2, half = (hi - lo) / 2;
  const phase = rnd() * Math.PI * 2, cycles = 0.6 + rnd();
  return Array.from({ length: n }, (_, i) => {
    const s = Math.sin(phase + (i / n) * cycles * Math.PI * 2);
    const v = mid + half * (0.75 * s + 0.35 * (rnd() * 2 - 1));
    return Math.min(hi, Math.max(lo, v));
  });
}

const n = f.resorts[0].days.length;
const rnd = rng(20260831);

/* The pick first: everything else is measured against its curve.
   Its RUNNING RATE is held between 6.3 and 8.4 inches a day. The days still
   vary — four inches one day, ten the next — but the window never averages
   out to a lull, so the pick sits near the snow term's 8"/day ceiling at two
   days and at six alike. Without that, a storm arriving on day four leaves
   the pick looking thin on a short window and Alta walks away with it. */
const tell = draw(n, CAST.telluride.rate * n, rnd,
  (c) => c.every((v, i) => v >= 6.3 * (i + 1) && v <= 8.4 * (i + 1)),
  Array(n).fill(1));
const tellCum = cum(tell);

/* Alta leads at every window length, not just at six days — and the lead is
   capped as well as floored. The snow term saturates at 8"/day, so the pick
   is deliberately set just under that: it scores nearly full marks on snow at
   ANY window length, which is what makes the comparison stable. Alta clears
   the same ceiling and can gain nothing more from the extra foot, so the
   decision falls to base, temperature and wind — which is the argument. Let
   the lead run past about twice and the two rows converge to a coin flip
   instead, because Alta's surplus is all above the ceiling. */
const FROM = 1;                                    // check from the second day
const alta = draw(n, CAST.alta.rate * n, rnd,
  (c) => c.every((v, i) =>
    i < FROM || (v >= tellCum[i] * 1.1 + 1 && v <= tellCum[i] * 2 + 2)), tell);
/* Heavenly is the pick's twin on snow and its opposite on temperature, so
   "the same amount of snow" has to read true at EVERY window, not only at
   six days — Brian reads the four-day board. It is therefore built as the
   pick's series plus a small zero-sum wobble rather than drawn on its own:
   the running totals never part by more than half an inch, which is inside
   the rounding the table displays, while the individual days still differ by
   up to an inch so the two bar charts are not the same picture twice. */
function twinOf(base, rnd, tol = 0.45) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const e = [];
    let run = 0, ok = true;
    for (let i = 0; i < base.length - 1; i++) {
      const step = (rnd() * 2 - 1) * 0.9;
      const capped = Math.max(-tol - run, Math.min(tol - run, step));
      e.push(capped); run += capped;
    }
    e.push(-run);
    if (Math.abs(e.at(-1)) > 1.2) ok = false;
    const out = base.map((v, i) => v + e[i]);
    if (ok && out.every((v) => v > 0.15)) return out;
  }
  return base.slice();
}
const heav = twinOf(tell, rnd);

const SNOW = { telluride: tell, alta, heavenly: heav };

/* Bands for the rest — varied, plausible, and none of them tripping a veto,
   which would bin a resort for reasons the demo is not trying to show. */
const restBand = (i) => {
  const warm = (i * 7) % 17;                       // 0..16, a stable spread
  const hi = 20 + warm, lo = hi - (9 + ((i * 5) % 8));
  return { hi: [hi - 4, hi], lo: [lo - 3, lo], wind: [5 + ((i * 3) % 9), 14 + ((i * 4) % 17)] };
};

let i = 0;
for (const r of f.resorts) {
  const c = CAST[r.id];
  const k = c ? null : i++;
  const total = (c ? c.rate : REST[k % REST.length]) * n;
  const snow = SNOW[r.id] ??
    draw(n, total, rnd, (cc) => cc.every((v, j) => j < FROM || v <= tellCum[j] - 0.5), tell);
  const band = c ?? restBand(k);
  let his = wander(n, band.hi, rnd);
  let los = wander(n, band.lo, rnd);
  let winds = wander(n, band.wind, rnd);
  if (r.id === "alta") {
    los = extremeFirst(los, Math.min);
    winds = extremeFirst(winds, Math.max);
  }
  if (r.id === "heavenly") his = extremeFirst(his, Math.max);

  r.days.forEach((d, j) => {
    const daySnow = +IN(snow[j]).toFixed(2);
    const hi = Math.max(his[j], los[j] + 3);       // a max is never below a min
    d.snow = daySnow;
    d.tempMax = +F(hi).toFixed(2);
    d.tempMin = +F(los[j]).toFixed(2);
    d.windMax = +MPH(winds[j]).toFixed(2);
    /* The am/pm/night rows are not rendered anywhere, but leaving the scraped
       originals in place would leave the fixture contradicting itself — a day
       totalling two inches with a period claiming nine. Split the day across
       them instead. */
    if (Array.isArray(d.periods)) {
      const share = [0.3, 0.45, 0.25];
      d.periods.forEach((p, q) => {
        p.snow = +(daySnow * (share[q] ?? 1 / d.periods.length)).toFixed(2);
        p.tempMax = +F(q === 2 ? los[j] : hi).toFixed(2);
        p.wind = +MPH(winds[j] * (0.7 + 0.3 * (q / 2))).toFixed(2);
      });
    }
  });
}

/* A real base under the pick — it is one of the four things the ranking
   weighs, and the demo should show it counting for something. Varied across
   the three days too, but holding the same three-day totals: 10" under the
   pick, 6" under Alta, 3" under Heavenly. */
const start = f.resorts[0].days[0].date;
const base = {
  telluride: scaleTo(stormShape(3, rnd), 10),
  alta: scaleTo(stormShape(3, rnd), 6),
  heavenly: scaleTo(stormShape(3, rnd), 3),
};
for (let k = 1; k <= 3; k++) {
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - k);
  const key = d.toISOString().slice(0, 10);
  h.days[key] = h.days[key] || {};
  for (const [id, series] of Object.entries(base)) {
    h.days[key][id] = +IN(series[k - 1]).toFixed(2);
  }
}

await writeFile(fPath, JSON.stringify(f, null, 1));
await writeFile(hPath, JSON.stringify(h, null, 1));
console.error(`shaped ${f.resorts.length} resorts over ${n} days`);
