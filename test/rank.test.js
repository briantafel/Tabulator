import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, rankParts, byRank, tempScore, windScore } from "../src/lib/rank.js";
/* Authored units, as everywhere else: °F, mph, inches. */
const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;
const IN = (i) => i * 2.54;

const r = (o) => ({ total: IN(10), before: IN(6), hi: F(25), lo: F(15), wind: MPH(8), ...o });

test("the snow bar scales with the window, not with a fixed number", () => {
  // 32" is everything over four days and only two thirds of it over six, so a
  // long trip cannot saturate the field and hand the ranking to the weather.
  const four = { total: IN(32), before: null, hi: F(25), lo: F(15), wind: MPH(5), win: Array(4) };
  const six = { ...four, win: Array(6) };
  assert.equal(rank(four), 100);
  assert.ok(rank(six) < 100);
});

test("snow still dominates a real gap", () => {
  // Brian's rule only applies to "similar snowfalls". 8" of perfect must not
  // beat 24" of merely fine.
  const deep = r({ total: IN(24), hi: F(33), lo: F(5), wind: MPH(24), before: null });
  const shallow = r({ total: IN(8) });
  assert.ok(rank(deep) > rank(shallow), `${rank(deep)} should beat ${rank(shallow)}`);
});

test("conditions settle a close call — the thing he asked for", () => {
  const a = r({ total: IN(22), before: IN(1), hi: F(38), wind: MPH(35) });
  const b = r({ total: IN(20), before: IN(10) });
  assert.ok(rank(b) > rank(a), `${rank(b)} should edge out ${rank(a)}`);
});

test("recent snow alone can decide it", () => {
  const dry = r({ before: 0 });
  const based = r({ before: IN(12) });
  assert.ok(rank(based) > rank(dry));
  // and it is the only difference, so the gap is exactly the base weight
  assert.ok(rank(based) - rank(dry) > 5);
});

test("a missing archive is not a zero", () => {
  // before: null must not score the same as before: 0 — that would punish a
  // resort for our gap in history rather than for its own conditions.
  assert.ok(rank(r({ before: null })) > rank(r({ before: 0 })));
  // With the term dropped, the remaining weights re-normalise to 100.
  const perfect = { total: IN(32), before: null, hi: F(25), lo: F(15), wind: MPH(5) };
  assert.equal(rank(perfect), 100);
});

test("every term saturates — one freak number cannot outvote the rest", () => {
  assert.equal(rank(r({ total: IN(32) })), rank(r({ total: IN(60) })));
  assert.equal(rank(r({ before: IN(12) })), rank(r({ before: IN(40) })));
});

test("temperature is bad in both directions and the worse one wins", () => {
  assert.equal(tempScore(F(25), F(15)), 1);
  assert.equal(tempScore(F(40), F(15)), 0);
  assert.equal(tempScore(F(25), F(-16)), 0);
  assert.ok(tempScore(F(35), F(15)) > 0 && tempScore(F(35), F(15)) < 1);
  // A window that is both too warm and too cold takes the worse penalty once,
  // not twice.
  assert.equal(tempScore(F(40), F(-16)), 0);
});

test("wind is free until it is dicey, and gone by the time it howls", () => {
  assert.equal(windScore(MPH(10)), 1);
  assert.equal(windScore(MPH(17)), 1);
  assert.equal(windScore(MPH(45)), 0);
  assert.equal(windScore(MPH(60)), 0);
  assert.equal(windScore(null), null);
});

test("the parts add up to the score, and explain it", () => {
  const parts = rankParts(r({ total: IN(32), before: IN(12), wind: MPH(5) }));
  assert.deepEqual(Object.keys(parts), ["snow", "base", "temp", "wind"]);
  const got = Object.values(parts).reduce((s, p) => s + p.got, 0);
  const max = Object.values(parts).reduce((s, p) => s + p.max, 0);
  assert.equal(max, 100);
  assert.equal(Number(((got / max) * 100).toFixed(2)), rank(r({ total: IN(32), before: IN(12), wind: MPH(5) })));
});

test("ties fall back to depth, not to array order", () => {
  const a = { rank: 50, total: IN(5) };
  const b = { rank: 50, total: IN(9) };
  assert.ok(byRank(a, b) > 0, "the deeper of two equal scores sorts first");
  assert.deepEqual([a, b].sort(byRank), [b, a]);
});
