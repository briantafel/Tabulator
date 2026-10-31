import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resortVoice, SNOW, CONDITIONS, GALE, SO_WHAT, soWhatKey, snowBucket, tempBucket, windBand,
} from "../src/lib/voice.js";
import { resortVerdict } from "../src/lib/verdict.js";

const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;
const IN = (i) => i * 2.54;

/* A resort with a window built from authored-unit extremes. */
function resort({ id = "alta", days = 4, total = 9, hi = 25, lo = 15, wind = 8, freezeMin = null, mid = 2600 } = {}) {
  const win = Array.from({ length: days }, (_, i) => ({
    date: `2026-12-${String(10 + i).padStart(2, "0")}`,
    snow: IN(total / days),
    tempMax: F(i === 0 ? hi : Math.min(hi, 20)),
    tempMin: F(i === days - 1 ? lo : Math.max(lo, 15)),
    windMax: MPH(i === 1 ? wind : Math.min(wind, 5)),
  }));
  return { id, name: id, total: IN(total), win, freezeMin, elevation: { mid } };
}
const say = (v) => v.map((s) => s.t).join("");
const hot = (v) => v.filter((s) => s.hot).map((s) => s.t);
const highlights = (tpl) => (tpl.match(/\[[^\]]+\]/g) ?? []).length;

test("every snow template highlights exactly one thing", () => {
  for (const [k, pool] of Object.entries(SNOW)) {
    for (const t of pool) assert.equal(highlights(t), 1, `${k}: ${t}`);
  }
});

test("every conditions template highlights exactly two things", () => {
  for (const [k, cols] of Object.entries(CONDITIONS)) {
    for (const [c, pool] of Object.entries(cols)) {
      assert.ok(pool.length >= 3, `${k}.${c} needs at least three variants`);
      for (const t of pool) assert.equal(highlights(t), 2, `${k}.${c}: ${t}`);
    }
  }
  for (const t of GALE) assert.equal(highlights(t), 2, t);
});

test("the so-what line is never highlighted", () => {
  for (const pool of Object.values(SO_WHAT)) for (const t of pool) assert.equal(highlights(t), 0, t);
});

test("the same window always reads the same sentence", () => {
  const a = say(resortVoice(resort(), false));
  for (let i = 0; i < 5; i++) assert.equal(say(resortVoice(resort(), false)), a);
});

test("different resorts and windows get different wording", () => {
  const ids = ["alta", "snowbird", "vail", "stowe", "whistler", "mammoth", "taos", "big-sky"];
  const seen = new Set(ids.map((id) => say(resortVoice(resort({ id }), false))));
  assert.ok(seen.size >= 4, `only ${seen.size} distinct sentences across ${ids.length} resorts`);
});

test("over 40 reads LIKE spring and is a deal breaker, not a celebration", () => {
  const s = say(resortVoice(resort({ hi: 44 }), false));
  assert.ok(!/spring, baby/i.test(s), s);
  assert.match(s, /spring|April|T-shirt/i);
  assert.match(s, /deal breaker/);
});

test("warm snow is called heavy, and only the Sierra gets cement", () => {
  const sierra = say(resortVoice(resort({ id: "kirkwood", total: 18, days: 3, hi: 36 }), false));
  assert.match(sierra, /Sierra cement/);
  const utah = say(resortVoice(resort({ id: "alta", total: 18, days: 3, hi: 36 }), false));
  assert.ok(!/cement|blower|light and dry/.test(utah), utah);
  assert.match(utah, /heavy|Dense/i);
});

test("cold dumps are light, and the Wasatch gets its own word", () => {
  const k = (id) => soWhatKey(
    { totalIn: 24, days: 3, rate: 8, hi: 18, lo: 5, wind: 6, m: { hi: F(18), lo: F(5), wind: MPH(6) } },
    { id, elevation: { mid: 2600 } },
  );
  assert.equal(k("alta"), "dryWasatch");
  assert.equal(k("vail"), "dryRockies");
  assert.equal(k("whistler"), "dry");
});

test("rain beats every snow line", () => {
  const s = say(resortVoice(resort({ total: 15, days: 3, hi: 33, freezeMin: 3000, mid: 2600 }), false));
  assert.match(s, /rain/i);
});

test("one day reads 'the day', not '1 days'", () => {
  const s = say(resortVoice(resort({ days: 1, total: 0 }), false));
  assert.ok(!/1 days/.test(s), s);
});

test("no snow never prints a zero amount", () => {
  const s = say(resortVoice(resort({ total: 0 }), false));
  assert.ok(!/0(\.0)?"/.test(s), s);
});

test("metric prints centimetres", () => {
  assert.match(say(resortVoice(resort({ total: 9 }), true)), /cm/);
});

test("the buckets match the classic ladder's thresholds", () => {
  assert.equal(snowBucket({ totalIn: 0.2, rate: 0.05 }), "none");
  assert.equal(snowBucket({ totalIn: 12, rate: 4 }), "dump");
  assert.equal(snowBucket({ totalIn: 36, rate: 6 }), "cycle");
  assert.equal(tempBucket({ hi: 41, lo: 20 }), "spring");
  assert.equal(tempBucket({ hi: 33, lo: 5 }), "mixed");
  assert.equal(tempBucket({ hi: 10, lo: -20 }), "frigid");
  assert.equal(windBand(30), "stiff");
  assert.equal(windBand(46), "gale");
});

test("every combination reads as finished prose with three highlights", () => {
  const ids = ["alta", "kirkwood", "crystal", "stowe", "vail", "revelstoke", "nowhere"];
  let n = 0;
  for (const id of ids)
    for (const total of [0, 1, 4, 10, 18, 40])
      for (const days of [1, 3, 6])
        for (const hi of [12, 24, 32, 36, 39, 44])
          for (const lo of [-20, -5, 5, 18])
            for (const wind of [5, 15, 22, 28, 38, 55]) {
              if (lo > hi) continue;
              const v = resortVoice(resort({ id, total, days, hi, lo, wind }), false);
              const s = say(v);
              assert.equal(hot(v).length, 3, s);
              assert.ok(!/[{}[\]]/.test(s), `unfilled token: ${s}`);
              assert.ok(!/ {2}|\s[.,]/.test(s), `spacing: ${s}`);
              assert.match(s, /[.!]$/, s);
              // Warm snow is never sold as powder.
              if (hi > 34) assert.ok(!/light and dry|blower|cold smoke|bottomless/.test(s), s);
              n++;
            }
  assert.ok(n > 10000);
});

test("the classic sentence is untouched", () => {
  const s = say(resortVerdict({ total: IN(9), win: resort().win.map((d) => ({ ...d, tempMax: F(25), tempMin: F(15), windMax: MPH(8) })) }, false));
  assert.equal(s, 'Looking like 9.0" of snow over 4 days. Temps look pleasant, and winds are calm.');
});

/* Period-level windows: three periods a day, temps in °F, snow in inches. */
const P = (spec) => {
  const days = [];
  for (let i = 0; i < spec.length; i += 3) {
    const ps = spec.slice(i, i + 3).map(([t, sn], n) => ({ name: ["am", "pm", "night"][n], tempMax: F(t), snow: IN(sn) }));
    days.push({
      date: `2026-12-${10 + i / 3}`,
      snow: ps.reduce((a, p) => a + p.snow, 0),
      tempMax: Math.max(...ps.map((p) => p.tempMax)),
      tempMin: Math.min(...ps.map((p) => p.tempMax)),
      windMax: MPH(6),
      periods: ps,
    });
  }
  return days;
};
import { layering } from "../src/lib/voice.js";

test("snow, then warm, then very cold reads crust on fluff", () => {
  const win = P([[24, 3], [26, 4], [22, 3], [30, 0], [38, 0], [30, 0], [12, 0], [14, 0], [8, 0]]);
  assert.equal(layering(win), "crustOnFluff");
  const r = { id: "alta", total: win.reduce((a, d) => a + d.snow, 0), win, elevation: { mid: 2600 } };
  assert.match(say(resortVoice(r, false)), /crust over soft snow|[Cc]rust on fluff/);
});

test("snow, warm, freeze, then a light coat inside 48 hours reads fluff on crust", () => {
  const win = P([[24, 4], [26, 4], [22, 2], [30, 0], [37, 0], [24, 0], [22, 1], [20, 2], [18, 0]]);
  assert.equal(layering(win), "fluffOnCrust");
  const r = { id: "vail", total: win.reduce((a, d) => a + d.snow, 0), win, elevation: { mid: 2600 } };
  assert.match(say(resortVoice(r, false)), /fluff on crust|refrozen crust/i);
});

test("a real storm after the freeze buries the crust, and says nothing about it", () => {
  const win = P([[24, 4], [26, 4], [22, 2], [30, 0], [37, 0], [10, 0], [20, 6], [18, 8], [16, 6]]);
  assert.equal(layering(win), null);
});

test("the light coat has to land within 48 hours of the thaw", () => {
  const win = P([[24, 4], [26, 4], [22, 2], [37, 0], [24, 0], [22, 0], [20, 0], [20, 0], [20, 0], [20, 0], [18, 2], [18, 0]]);
  assert.notEqual(layering(win), "fluffOnCrust");
});

test("no snow before the thaw means no layer to speak of", () => {
  assert.equal(layering(P([[24, 0], [26, 0], [22, 0], [38, 0], [10, 0], [8, 0]])), null);
});

test("daily-only data still finds the sequence", () => {
  const d = (hi, lo, sn) => ({ snow: IN(sn), tempMax: F(hi), tempMin: F(lo), windMax: MPH(5) });
  assert.equal(layering([d(25, 15, 6), d(38, 26, 0), d(18, 8, 0)]), "crustOnFluff");
  assert.equal(layering([d(25, 15, 6), d(38, 24, 0), d(22, 15, 2)]), "fluffOnCrust");
});
