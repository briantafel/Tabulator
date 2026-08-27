import { test } from "node:test";
import assert from "node:assert/strict";
import { tripVerdict, tempWord, tempClause, windWord, closingWord } from "../src/lib/verdict.js";
/* The thresholds are authored in °F, mph and inches and stored metric, so the
   test speaks the authored units too — a band expressed in °C here would be
   unreadable against the numbers in constants.js. */
const F = (f) => ((f - 32) * 5) / 9;
const MPH = (m) => m * 1.60934;
const IN = (i) => i * 2.54;

const day = (o = {}) => ({ snow: IN(1), tempMax: F(25), tempMin: F(15), windMax: MPH(8), ...o });
const win = (n, o) => Array.from({ length: n }, () => day(o));
const say = (v) => v.map((s) => s.t).join("");
const hot = (v) => v.filter((s) => s.hot).map((s) => s.t);
/* tempWord reads window extremes, so the tests hand it extremes directly. */
const T = (hi, lo, wind = MPH(5)) => tempWord({ hi: F(hi), lo: F(lo), wind });

test("the warm ladder runs from a bit warm up to spring", () => {
  assert.equal(T(32, 25), "a bit warm");
  assert.equal(T(36, 25), "pretty damn warm");
  assert.equal(T(39, 25), "almost too warm to ski");
});

test("over 40 is its own sentence, not a word in the frame", () => {
  // Brian: "Anything over 40 should be something like 'it's spring, baby!'"
  const C = (hi) => tempClause({ hi: F(hi), lo: F(25), wind: MPH(5) });
  assert.deepEqual(C(44), { t: "It's spring, baby!", bang: true });
  assert.equal(C(39).bang, false);
  assert.equal(C(39).t, "Temps look almost too warm to ski");
  // 40 itself is not over 40.
  assert.equal(C(40).bang, false);
});

test("the cold ladder runs from cold to frigid", () => {
  assert.equal(T(20, 8), "cold");
  assert.equal(T(20, -5), "properly cold");
  assert.equal(T(20, -20), "frigid");
});

test("wind bends the cold half of the ladder, not the warm half", () => {
  // Brian: "A combination of low temps and wind would read Temps look fairly
  // miserable."
  assert.equal(T(20, 5, MPH(22)), "fairly miserable");
  assert.equal(T(20, -20, MPH(35)), "downright miserable");
  // Frigid is still the headline when the wind is merely dicey.
  assert.equal(T(20, -20, MPH(22)), "frigid");
  // A warm windy day is still a warm day; the wind clause says the rest.
  assert.equal(T(36, 25, MPH(35)), "pretty damn warm");
});

test("a clean window is pleasant when it is actually nice, good when it is just fine", () => {
  assert.equal(T(25, 15), "pleasant");
  assert.equal(T(14, 12), "good");
});

test("both ends misbehaving is admitted, not resolved", () => {
  assert.equal(T(36, -20), "all over the place");
});

test("wind climbs a six-rung ladder", () => {
  assert.equal(windWord(MPH(5)), "calm");
  assert.equal(windWord(MPH(14)), "light");
  assert.equal(windWord(MPH(20)), "moderate");
  assert.equal(windWord(MPH(27)), "a little high");
  assert.equal(windWord(MPH(35)), "howling");
  assert.equal(windWord(MPH(50)), "absolutely howling");
  assert.equal(windWord(null), "calm");
});

test("the closing line answers to the snow, not to nothing", () => {
  const c = (o) => closingWord({ hi: F(25), lo: F(15), wind: MPH(5), days: 4, ...o });
  // A real dump and nothing wrong with it.
  assert.match(c({ total: IN(24) }), /this is the move right now\.$/);
  // A dump you have to earn — Brian's own caveat. Both stay the right side of
  // the deal breakers: 35mph is howling but not a veto, and 0°F with a 22mph
  // wind is "fairly miserable" without tripping the -10°F line.
  assert.match(c({ total: IN(24), wind: MPH(35) }), /storming, but if you can hack it/);
  assert.match(c({ total: IN(24), lo: F(0), hi: F(10), wind: MPH(22) }),
    /^, but if you can hack it, it's gonna be a powderpalooza\.$/);
  // The bug this fixes: a snowless trip used to be "the move right now".
  assert.match(c({ total: IN(1) }), /not much falling right now\.$/);
  assert.match(c({ total: IN(1), wind: MPH(35) }), /this one's a skip\.$/);
  // Decent snow, rough conditions.
  assert.match(c({ total: IN(10), wind: MPH(35) }), /a fight for a decent day\.$/);
  // Cold plus a merely dicey wind reads "miserable" in the clause above, so
  // the closing must not then call it the move.
  assert.match(c({ total: IN(10), lo: F(5), wind: MPH(22) }), /a fight for a decent day\.$/);
  // The deal breakers outrank every snow line — no amount of powder argues.
  assert.match(c({ total: IN(24), wind: MPH(50) }), /non-starter — nothing will be running\.$/);
  assert.match(c({ total: IN(24), lo: F(-20) }), /non-starter — too cold to be out in\.$/);
  assert.match(c({ total: IN(24), hi: F(45) }), /spring, not skiing — give it a miss\.$/);
  assert.match(c({ total: IN(1), hi: F(45) }), /spring, not skiing — give it a miss\.$/);
  // The honest unskiable case is rain, read off the freezing level.
  assert.match(c({ total: IN(24), rain: true }), /that is rain, not snow — sit this one out\.$/);
});

test("the best bet is the deepest resort, not the first", () => {
  const rows = [
    { name: "Snowbird", total: IN(4), win: win(4) },
    { name: "Alta", total: IN(18), win: win(4) },
  ];
  const v = tripVerdict(rows, true);
  assert.match(say(v), /^Your best bet is looking like Alta, with /);
  assert.match(say(v), / over 4 days\./);
});

test("only the decided clauses are highlighted — the day count is prose", () => {
  const v = tripVerdict([{ name: "Alta", total: IN(18), win: win(4) }], true);
  assert.deepEqual(hot(v), ["Alta", "46cm", "Temps look pleasant", "winds are calm"]);
  assert.ok(!hot(v).some((t) => /days/.test(t)), "the day count must stay in the prose");
});

test("the verdict reads as one sentence however the clauses land", () => {
  const rows = [{ name: "Alta", total: IN(24), win: win(3, { tempMin: F(-8), tempMax: F(5), windMax: MPH(35) }) }];
  const s = say(tripVerdict(rows, false));
  assert.match(s, /^Your best bet is looking like Alta, with 24" over 3 days\. /);
  assert.match(s, /Temps look fairly miserable, and winds are howling, so it's going to be storming, but if you can hack it, it's gonna be a powderpalooza\.$/);
});

test("an unscored row still gets a real reading, not a default one", () => {
  // extremes() derives hi/lo/wind from the window, so a row that never went
  // through score() cannot silently read "good and calm".
  const v = tripVerdict([{ name: "Alta", total: IN(2), win: win(3, { tempMax: F(44) }) }], false);
  assert.match(say(v), /days\. It's spring, baby! Winds are calm\. Overall, that is spring, not skiing — give it a miss\.$/);
});

test("rain is read off the freezing level, not guessed from temperature", () => {
  const rows = [{
    name: "Alta", total: IN(24), win: win(3),
    freezeMin: 2600, elevation: { mid: 2400 },
  }];
  assert.match(say(tripVerdict(rows, false)), /that is rain, not snow — sit this one out\.$/);
});

test("nothing to have an opinion about returns null", () => {
  assert.equal(tripVerdict([], true), null);
  assert.equal(tripVerdict([{ name: "x", total: 0 }], true), null);
});

test("a deal breaker is never the recommendation", () => {
  // Brian: "winds over 45 mph would be a deal breaker entirely. Temps below
  // -10º F and over 40º would also be a deal breaker."
  const rows = [
    { name: "Gale", total: IN(40), win: win(4, { windMax: MPH(55) }) },
    { name: "Deepfreeze", total: IN(36), win: win(4, { tempMin: F(-20) }) },
    { name: "Slush", total: IN(34), win: win(4, { tempMax: F(46) }) },
    { name: "Fine", total: IN(9), win: win(4) },
  ];
  // Every vetoed resort is deeper than the one that wins, which is the point.
  assert.match(say(tripVerdict(rows, false)), /^Your best bet is looking like Fine, /);
});

test("when everything is a deal breaker, say so rather than pick silently", () => {
  const rows = [
    { name: "Gale", total: IN(20), win: win(4, { windMax: MPH(55) }) },
    { name: "Bigger gale", total: IN(40), win: win(4, { windMax: MPH(60) }) },
  ];
  const s = say(tripVerdict(rows, false));
  assert.match(s, /^Your best bet is looking like Bigger gale, /);
  assert.match(s, /non-starter — nothing will be running\.$/);
});
