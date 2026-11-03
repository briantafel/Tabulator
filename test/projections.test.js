import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localDate, dailyByMember, wQuantile, pool, summarize, runEvidence, learn, correct, projectionDates,
} from "../scripts/projections/lib.js";

/* A tiny Open-Meteo-shaped response: `hours` hourly steps from a UTC start,
   a control run plus `n` members, each with a constant hourly value. */
function fake({ start = "2026-11-03T00:00", hours = 72, n = 2, snow = 0.1, temp = -5, wind = 10 }) {
  const t0 = Date.parse(`${start}Z`);
  const time = Array.from({ length: hours }, (_, i) => new Date(t0 + i * 3600e3).toISOString().slice(0, 16));
  const hourly = { time };
  const put = (suffix, k) => {
    hourly[`snowfall${suffix}`] = time.map(() => snow * k);
    hourly[`temperature_2m${suffix}`] = time.map(() => temp);
    hourly[`wind_speed_10m${suffix}`] = time.map(() => wind * k);
  };
  put("", 1);
  for (let m = 1; m <= n; m++) put(`_member${String(m).padStart(2, "0")}`, 1 + m);
  return { hourly };
}

test("dates are the resort's own, and an hour is dated by its start", () => {
  // 06:00 UTC on Nov 4 is 23:00 Nov 3 in Denver.
  assert.equal(localDate(Date.parse("2026-11-04T06:00:00Z"), "America/Denver"), "2026-11-03");
  assert.equal(localDate(Date.parse("2026-11-04T06:00:00Z"), "UTC"), "2026-11-04");
});

test("only complete 24-hour days survive; snow sums, wind takes the max", () => {
  const out = dailyByMember(fake({ hours: 72 }), "UTC");
  const control = out.get(0);
  // Hours ending 00:00..23:00 Nov 3 → the first value dates to Nov 2 23:00 (partial day dropped).
  assert.equal(control.has("2026-11-02"), false);
  const full = [...control.keys()].filter((d) => control.get(d));
  assert.ok(full.includes("2026-11-03") && full.includes("2026-11-04"));
  const d = control.get("2026-11-04");
  assert.equal(d.snow, 2.4);       // 24 × 0.1
  assert.equal(d.windMax, 10);
  assert.equal(d.tempMax, -5);
  assert.equal(out.size, 3);       // control + 2 members
});

test("weighted quantiles interpolate and respect weights", () => {
  const even = [{ v: 0, w: 1 }, { v: 10, w: 1 }];
  assert.equal(wQuantile(even, 0.5), 5);
  assert.equal(wQuantile(even, 0.1), 0);
  assert.equal(wQuantile(even, 0.9), 10);
  assert.equal(wQuantile([], 0.5), null);
  // A heavy weight pulls the median toward it.
  assert.ok(wQuantile([{ v: 0, w: 3 }, { v: 10, w: 1 }], 0.5) < 5);
});

test("two models count equally however many members each has", () => {
  const a = dailyByMember(fake({ n: 4, snow: 0.1 }), "UTC");   // 5 members, 2.4..12 cm
  const b = dailyByMember(fake({ n: 1, snow: 1 }), "UTC");     // 2 members, 24..48 cm
  const s = summarize(pool({ big: a, small: b }).get("2026-11-04"));
  assert.equal(s.members, 7);
  // Half the weight sits on the small model's big totals, so the median is well above model A's range.
  assert.ok(s.snow.p50 > 12, `p50 ${s.snow.p50}`);
  assert.ok(s.snow.p10 <= s.snow.p25 && s.snow.p25 <= s.snow.p50 && s.snow.p50 <= s.snow.p75 && s.snow.p75 <= s.snow.p90);
});

test("evidence compares Snow-Forecast with the ensemble median on shared dates", () => {
  const summary = new Map([
    ["2026-11-04", { windMax: 20, tempMax: -6 }],
    ["2026-11-05", { windMax: 10, tempMax: -4 }],
    ["2026-11-06", { windMax: 2, tempMax: 0 }],     // wind too light to form a ratio
  ]);
  const sf = [
    { date: "2026-11-04", windMax: 40, tempMax: -3 },
    { date: "2026-11-05", windMax: 30, tempMax: -2 },
    { date: "2026-11-06", windMax: 50, tempMax: 1 },
    { date: "2026-11-09", windMax: 30, tempMax: 0 },  // not in the ensemble: ignored
  ];
  const ev = runEvidence(sf, summary);
  assert.equal(ev.wind.days, 2);
  assert.equal(ev.wind.factor, 2.5);   // median of 2 and 3
  assert.equal(ev.temp.days, 3);
  assert.equal(ev.temp.offset, 2);     // median of 3, 2, 1
});

test("the correction is learned run over run, and bounded", () => {
  let cal = learn(null, { wind: { factor: 2 }, temp: { offset: 3 } });
  assert.deepEqual(cal, { wind: { factor: 2, runs: 1 }, temp: { offset: 3, runs: 1 } });
  cal = learn(cal, { wind: { factor: 3 }, temp: { offset: -2 } });
  assert.equal(cal.wind.factor, 2.2);   // 2 + 0.2 × (3 − 2)
  assert.equal(cal.temp.offset, 2);     // 3 + 0.2 × (−2 − 3)
  assert.equal(cal.wind.runs, 2);
  // A run with no evidence leaves the correction alone.
  assert.deepEqual(learn(cal, { wind: null, temp: null }), cal);
  // A wild ratio is clamped before it is folded in.
  assert.equal(learn(null, { wind: { factor: 40 }, temp: null }).wind.factor, 3);
});

test("correction applies to the projected day and keeps the raw values", () => {
  const day = { snow: { p50: 4 }, tempMax: -5, tempMin: -12, windMax: 20, members: 82 };
  const out = correct(day, { wind: { factor: 1.5 }, temp: { offset: 2 } });
  assert.equal(out.windMax, 30);
  assert.equal(out.tempMax, -3);
  assert.equal(out.tempMin, -10);
  assert.deepEqual(out.raw, { tempMax: -5, tempMin: -12, windMax: 20 });
  assert.equal(out.snow.p50, 4);       // snow is not corrected yet
  assert.equal(correct(day, null).windMax, 20);
});

test("projected dates are the ones past Snow-Forecast's horizon, up to day 10", () => {
  const sf = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  const avail = new Set(["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
  assert.deepEqual(projectionDates(sf, avail), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.deepEqual(projectionDates([], avail), []);
});
