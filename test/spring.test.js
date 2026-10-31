import { test } from "node:test";
import assert from "node:assert/strict";
import { vetoOf, inSpring, rank } from "../src/lib/rank.js";
import { tripVerdict, resortVerdict } from "../src/lib/verdict.js";
import { resortVoice } from "../src/lib/voice.js";

const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;
const IN = (i) => i * 2.54;
const say = (v) => v.map((s) => s.t).join("");

/* Four days starting `start`, warm afternoons to `hi`, coldest night `lo`. */
function row(start, { hi = 44, lo = 22, snow = 1, id = "alta" } = {}) {
  const d0 = new Date(`${start}T12:00:00Z`);
  const win = Array.from({ length: 4 }, (_, i) => {
    const d = new Date(d0); d.setUTCDate(d.getUTCDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      snow: IN(snow / 4),
      tempMax: F(i === 1 ? hi : 30),
      tempMin: F(i === 2 ? lo : 26),
      windMax: MPH(6),
    };
  });
  return { id, name: id, total: IN(snow), win, hi: F(hi), lo: F(lo), wind: MPH(6), elevation: { mid: 2600 } };
}

test("spring starts March 20, read off the warmest day", () => {
  assert.equal(inSpring(row("2027-03-14")), false); // warmest day is the 15th
  assert.equal(inSpring(row("2027-03-19")), true);  // warmest day is the 20th
  assert.equal(inSpring(row("2026-12-10")), false);
  assert.equal(inSpring(row("2027-04-10")), true);
});

test("a warm spring day with a refreeze is not a deal breaker", () => {
  assert.equal(vetoOf(row("2027-04-01", { lo: 22 })), null);
  assert.ok(rank(row("2027-04-01", { lo: 22 })) > 0);
});

test("a warm spring day with no refreeze still is", () => {
  assert.equal(vetoOf(row("2027-04-01", { lo: 34 })), "warm");
  const r = row("2027-04-01", { lo: 34 });
  r.win.forEach((d) => { d.tempMin = Math.max(d.tempMin, F(34)); });
  assert.match(say(tripVerdict([r], false)), /nothing refreezes overnight/);
  assert.match(say(resortVoice(r, false)), /[Ss]lush all day/);
});

test("the same day in December is still a deal breaker", () => {
  assert.equal(vetoOf(row("2026-12-10", { lo: 22 })), "warm");
});

test("the classic sentence says spring, baby only in spring", () => {
  const apr = say(tripVerdict([row("2027-04-01")], false));
  assert.match(apr, /It's spring, baby! Winds are/);
  assert.match(apr, /spring skiing — let it soften, then go\.$/);
  const dec = say(resortVerdict(row("2026-12-10"), false));
  assert.ok(!/spring, baby/.test(dec), dec);
  assert.match(dec, /Temps look springlike/);
});

test("the new voice calls it corn in spring and a deal breaker in December", () => {
  const ids = ["alta", "vail", "kirkwood", "stowe", "taos"];
  for (const id of ids) {
    const apr = say(resortVoice(row("2027-04-01", { id, snow: 3 }), false));
    assert.ok(!/deal breaker/i.test(apr), apr);
    assert.ok(!/like spring|springlike/i.test(apr), `in April it IS spring: ${apr}`);
    const dec = say(resortVoice(row("2026-12-10", { id, snow: 3 }), false));
    assert.match(dec, /deal breaker/i);
  }
});
