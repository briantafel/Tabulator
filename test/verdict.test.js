import { test } from "node:test";
import assert from "node:assert/strict";
import { tripVerdict, tempWord, windWord } from "../src/lib/verdict.js";
/* The thresholds are authored in °F and mph and stored metric, so the test
   speaks the authored units too — a band expressed in °C here would be
   unreadable against the numbers in constants.js. */
const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;

const day = (o = {}) => ({ snow: 3, tempMax: F(20), tempMin: F(15), windMax: MPH(8), ...o });
const win = (n, o) => Array.from({ length: n }, () => day(o));
const say = (v) => v.map((s) => s.t).join("");
const hot = (v) => v.filter((s) => s.hot).map((s) => s.t);

test("a clean window reads good and calm", () => {
  assert.equal(tempWord(win(4)), "good");
  assert.equal(windWord(win(4)), "calm");
});

test("warm and cold are different trips, not both 'dicey'", () => {
  assert.equal(tempWord(win(3, { tempMax: F(33) })), "warm");
  assert.equal(tempWord(win(3, { tempMin: F(-20) })), "cold");
  // One of each in the same window is worth admitting rather than picking one.
  assert.equal(
    tempWord([day({ tempMax: F(33) }), day({ tempMin: F(-20) })]),
    "all over the place",
  );
});

test("wind climbs through the same bands the markers use", () => {
  assert.equal(windWord(win(2, { windMax: MPH(10) })), "calm");
  assert.equal(windWord(win(2, { windMax: MPH(20) })), "moderate");
  assert.equal(windWord(win(2, { windMax: MPH(40) })), "a little high");
  // A single bad day in an otherwise calm window still counts.
  assert.equal(windWord([day(), day({ windMax: MPH(40) })]), "a little high");
});

test("the best bet is the deepest resort, not the first", () => {
  const rows = [
    { name: "Snowbird", total: 10, win: win(4) },
    { name: "Alta", total: 46, win: win(4) },
  ];
  const v = tripVerdict(rows, true);
  assert.match(say(v), /^Your best bet is looking like Alta, with /);
  assert.match(say(v), / over 4 days\./);
});

test("only the decided clauses are highlighted — the day count is prose", () => {
  const v = tripVerdict([{ name: "Alta", total: 46, win: win(4) }], true);
  assert.deepEqual(hot(v), ["Alta", "46cm", "Temps look good", "winds are calm"]);
  assert.ok(!hot(v).some((t) => /days/.test(t)), "the day count must stay in the prose");
});

test("nothing to have an opinion about returns null", () => {
  assert.equal(tripVerdict([], true), null);
  assert.equal(tripVerdict([{ name: "x", total: 0 }], true), null);
});
