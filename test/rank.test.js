import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, rankParts, byRank, bestOf, tempScore, windScore, vetoOf } from "../src/lib/rank.js";
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

test("a deal breaker is a veto, not a weight", () => {
  // Brian, 2026-08-27. A weight can be outvoted by enough snow; that is the
  // outcome he is ruling out, so these have to sit outside the weighting.
  const huge = { total: IN(60), before: IN(12), hi: F(25), lo: F(15), wind: MPH(5) };
  assert.equal(rank(huge), 100);
  assert.equal(rank({ ...huge, wind: MPH(46) }), 0, "46mph must veto");
  assert.equal(rank({ ...huge, lo: F(-11) }), 0, "-11°F must veto");
  assert.equal(rank({ ...huge, hi: F(41) }), 0, "41°F must veto");
});

test("the last acceptable reading is not vetoed — he said over and below", () => {
  const ok = { total: IN(20), before: IN(6), hi: F(25), lo: F(15), wind: MPH(5) };
  assert.equal(vetoOf({ ...ok, wind: MPH(45) }), null);
  assert.equal(vetoOf({ ...ok, lo: F(-10) }), null);
  assert.equal(vetoOf({ ...ok, hi: F(40) }), null);
  assert.equal(vetoOf({ ...ok, wind: MPH(45.1) }), "wind");
});

test("a veto names its reason, so nothing is mysteriously last", () => {
  assert.equal(vetoOf({ wind: MPH(50), lo: F(15), hi: F(25) }), "wind");
  assert.equal(vetoOf({ wind: MPH(5), lo: F(-20), hi: F(25) }), "cold");
  assert.equal(vetoOf({ wind: MPH(5), lo: F(15), hi: F(45) }), "warm");
  assert.equal(vetoOf({ wind: MPH(5), lo: F(15), hi: F(25) }), null);
  // Missing data cannot veto — a partial scrape must not disqualify a resort.
  assert.equal(vetoOf({ wind: null, lo: null, hi: null }), null);
});

test("vetoed resorts sink below every open one, deepest first among themselves", () => {
  const mk = (name, total, o) => ({ name, total, ...{ before: IN(6), hi: F(25), lo: F(15), wind: MPH(5) }, ...o });
  const rows = [
    mk("Gale", IN(40), { wind: MPH(55) }),
    mk("Fine", IN(9)),
    mk("Bigger gale", IN(50), { wind: MPH(60) }),
  ].map((x) => ({ ...x, rank: rank(x) }));
  assert.deepEqual(rows.sort(byRank).map((x) => x.name), ["Fine", "Bigger gale", "Gale"]);
});

test("the coral row and the sentence name the same resort — by construction", () => {
  // Brian: "the resort in red is occasionally not the recommended resort using
  // the weighted variables logic we developed." The table was marking the
  // DEEPEST row, which stopped being the pick when the balance landed.
  const rows = [
    { name: "Deep but dicey", total: IN(40), before: IN(2), hi: F(38), lo: F(20), wind: MPH(35) },
    { name: "The pick", total: IN(30), before: IN(10), hi: F(25), lo: F(15), wind: MPH(6) },
  ].map((r) => ({ ...r, rank: rank(r) }));
  const deepest = rows.reduce((a, b) => ((b.total ?? 0) > (a.total ?? 0) ? b : a));
  assert.equal(deepest.name, "Deep but dicey", "the fixture must actually exercise the bug");
  assert.equal(bestOf(rows).name, "The pick");
});

test("bestOf skips deal breakers, and copes with nothing at all", () => {
  const mk = (name, o) => ({ name, total: IN(20), before: IN(6), hi: F(25), lo: F(15), wind: MPH(5), ...o });
  assert.equal(bestOf([mk("Gale", { total: IN(50), wind: MPH(55) }), mk("Fine")]).name, "Fine");
  // Everything vetoed: name the deepest rather than nothing, so the screen
  // still says something and the closing explains why it is a non-starter.
  assert.equal(bestOf([mk("A", { total: IN(20), wind: MPH(55) }), mk("B", { total: IN(40), wind: MPH(55) })]).name, "B");
  assert.equal(bestOf([]), null);
  assert.equal(bestOf(null), null);
});
