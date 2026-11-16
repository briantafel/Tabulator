import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNdbc, dailyMax, findPops, gainsFromAccum, regionDaily, stormWithin, score, lagScan,
  persistenceSplit, seasonOf, dayOfSeason, addDays, PRIMARY,
} from "../scripts/research/buoy-stats.js";

// NDBC's own layout (header names, units row, 99.00 = missing).
const NDBC = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi    ft
2023 01 01 00 00 999 99.0 99.0  2.31 13.79  7.65 321 9999.0 999.0  25.0 999.0 99.0 99.00
2023 01 01 01 00 999 99.0 99.0  2.55 13.79  7.65 321 9999.0 999.0  25.0 999.0 99.0 99.00
2023 01 01 02 00 999 99.0 99.0 99.00 99.00 99.00 999 9999.0 999.0  25.0 999.0 99.0 99.00
2023 01 02 00 00 999 99.0 99.0  4.10 16.00  9.00 320 9999.0 999.0  25.0 999.0 99.0 99.00
`;

test("NDBC files parse by header, skipping missing readings", () => {
  const r = parseNdbc(NDBC);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { date: "2023-01-01", wvhtM: 2.31 });
  const d = dailyMax(r);
  assert.equal(d.get("2023-01-01"), 2.55);
  assert.equal(d.get("2023-01-02"), 4.1);
  assert.throws(() => parseNdbc("no header\n1 2 3"));
});

test("old files without a minute column still parse", () => {
  const old = "YY MM DD hh WD   WSPD GST  WVHT  DPD   APD  MWD  BAR    ATMP  WTMP  DEWP  VIS\n98 12 01 00 999 99.0 99.0  3.20 14.0  8.0 999 9999.0 999.0 999.0 999.0 99.0\n";
  assert.deepEqual(parseNdbc(old), [{ date: "1998-12-01", wvhtM: 3.2 }]);
});

test("winters and days of winter", () => {
  assert.equal(seasonOf("2015-11-20"), "2015-16");
  assert.equal(seasonOf("2016-02-01"), "2015-16");
  assert.equal(dayOfSeason("2015-10-01"), 0);
  assert.equal(dayOfSeason("2015-11-01"), 31);
});

test("a pop is a big jump to a big swell; one swell is one pop", () => {
  const d = new Map([
    ["2020-12-01", 1.8], ["2020-12-02", 1.9], ["2020-12-03", 2.0],
    ["2020-12-04", 3.8], // +1.8 over the 3-day low, ≥ 3.0 → pop
    ["2020-12-05", 4.2], // same swell, within 5 days
    ["2020-12-06", 2.0], ["2020-12-07", 2.0], ["2020-12-08", 2.0], ["2020-12-09", 2.0], ["2020-12-10", 2.1],
    ["2020-12-11", 3.4], // only +1.4: not a pop
    ["2020-12-12", 2.0], ["2020-12-13", 2.0], ["2020-12-14", 2.0],
    ["2020-12-15", 3.6], // +1.6 and ≥ 3.0, 11 days after the first → pop
  ]);
  assert.deepEqual(findPops(d), ["2020-12-04", "2020-12-15"]);
  // A gap in the 3 days before means it can't be judged.
  d.delete("2020-12-13");
  assert.deepEqual(findPops(d), ["2020-12-04"]);
});

test("gauge gains drop resets and gaps, never invent zeros", () => {
  const g = gainsFromAccum([
    { date: "2020-09-29", value: 40 }, { date: "2020-09-30", value: 40.5 },
    { date: "2020-10-01", value: 0 }, // Oct 1 reset
    { date: "2020-10-02", value: 0.3 }, { date: "2020-10-04", value: 0.6 }, // gap
  ]);
  assert.deepEqual([...g.entries()], [["2020-09-30", 0.5], ["2020-10-02", 0.3]]);
});

test("region value is the median of reporting stations, if at least half report", () => {
  const r = regionDaily([new Map([["d1", 0.2], ["d2", 1.0]]), new Map([["d1", 0.6]]), new Map([["d1", 0.4], ["d2", 0.0]])]);
  assert.equal(r.get("d1"), 0.4);
  assert.equal(r.get("d2"), 0.5);
  assert.equal(regionDaily([new Map([["d1", 1]]), new Map(), new Map()]).get("d1"), undefined);
});

test("a window with too much missing has no answer", () => {
  const region = new Map();
  for (let k = 11; k <= 17; k++) if (k < 14) region.set(addDays("2021-01-01", k), 0);
  assert.equal(stormWithin("2021-01-01", region), null);
  for (let k = 14; k <= 17; k++) region.set(addDays("2021-01-01", k), k === 16 ? 0.7 : 0);
  assert.equal(stormWithin("2021-01-01", region), true);
});

/* Synthetic winters: storms on random days at a realistic rate, plus
   pops. In `planted`, a storm always follows a pop 14 days later. */
function winters({ planted, years = 16, seed = 7 }) {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const region = new Map(), pops = [];
  for (let y = 2005; y < 2005 + years; y++) {
    for (let d = `${y}-10-15`; d < `${y + 1}-04-30`; d = addDays(d, 1)) region.set(d, r() < 0.07 ? 0.8 : 0.05);
    for (let k = 0; k < 9; k++) {
      const p = addDays(`${y}-11-05`, k * 15 + Math.floor(r() * 5));
      if (p > `${y + 1}-03-31`) continue;
      pops.push(p);
      if (planted) region.set(addDays(p, 14), 1.2);
    }
  }
  return { region, pops };
}

test("a planted two-week signal is found, and peaks at day 14", () => {
  const { region, pops } = winters({ planted: true });
  const s = score(pops, region, PRIMARY, { boot: 400 });
  assert.equal(s.pPop, 1);
  assert.ok(s.pBase < 0.7, `base ${s.pBase}`);
  assert.equal(s.skill, true);
  const lag = lagScan(pops, region);
  const best = lag.reduce((a, b) => (b.pPop - b.pBase > a.pPop - a.pBase ? b : a));
  assert.equal(best.lag, 14);
});

test("pops with no real link: they 'come true' often, but skill shows up only at the chance rate", () => {
  // One noise sample can pass a 90% test by luck (1 in 20 by design); what
  // matters is the rate over many. This is also why the study fixes ONE
  // definition in advance: try twenty on noise and one will "work".
  let passed = 0, sum = 0;
  const seeds = 40;
  for (let k = 0; k < seeds; k++) {
    const { region, pops } = winters({ planted: false, seed: 1000 + k });
    const s = score(pops, region, PRIMARY, { boot: 200 });
    assert.ok(s.pPop > 0.25, `random pops still 'come true' ${Math.round(s.pPop * 100)}% of the time`);
    if (s.skill) passed++;
    sum += s.diff;
  }
  assert.ok(passed <= 6, `${passed}/${seeds} noise samples passed (expect about 2)`);
  assert.ok(Math.abs(sum / seeds) < 0.03, `mean difference ${sum / seeds} should be near zero`);
});

test("the interval is reproducible", () => {
  const { region, pops } = winters({ planted: false });
  assert.deepEqual(score(pops, region, PRIMARY, { boot: 200 }).diff90, score(pops, region, PRIMARY, { boot: 200 }).diff90);
});

test("the persistence split counts both sides", () => {
  const { region, pops } = winters({ planted: true });
  const p = persistenceSplit(pops, region);
  assert.ok(p.afterStorm.pop.n + p.afterQuiet.pop.n > 50);
  assert.ok(p.afterQuiet.base.n > 0);
});
