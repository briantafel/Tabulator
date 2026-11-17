import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOni, ensoClass, regionWinters, summarise } from "../scripts/season/enso-history.js";
import { ensoCheckpoint, currentEnso, ensoHistoryLine } from "../src/lib/lookahead.js";

test("ONI: DJF rows by water year, other seasons ignored", () => {
  const t = " SEAS  YR   TOTAL   ANOM\n DJF 1998 28.49  2.40\n JFM 1998 28.30  2.10\n DJF 2000 24.60 -1.70\n";
  assert.deepEqual(parseOni(t), { 1998: 2.4, 2000: -1.7 });
  assert.equal(ensoClass(2.4), "strongElNino");
  assert.equal(ensoClass(0.7), "elNino");
  assert.equal(ensoClass(-0.6), "laNina");
  assert.equal(ensoClass(0.1), "neutral");
  assert.equal(ensoClass(null), null);
});

test("winters: % of each station's 1991–2020 median, current season left out, thin medians dropped", () => {
  const swe = {}; for (let y = 1991; y <= 2020; y++) swe[y] = 200; swe[1998] = 400; swe[2027] = 999;
  const thin = {}; for (let y = 1991; y <= 2020; y++) thin[y] = 10;
  const w = regionWinters([{ "04-01": { swe } }, { "04-01": { swe: thin } }], 2027);
  assert.equal(w[1998]["04-01"], 200);
  assert.equal(w[2027], undefined);
  const s = summarise(w, { 1998: 2.4, 1999: -1.4, 2000: 0 });
  assert.equal(s["04-01"].strongElNino.n, 1);
  assert.equal(s["04-01"].all.n, 3);
});

test("checkpoint follows the trip start", () => {
  assert.equal(ensoCheckpoint("2026-12-20"), "01-01");
  assert.equal(ensoCheckpoint("2027-01-10"), "02-01");
  assert.equal(ensoCheckpoint("2027-03-05"), "04-01");
  assert.equal(ensoCheckpoint(null), "04-01");
});

test("current class from NOAA's words", () => {
  assert.equal(currentEnso({ status: "El Niño Advisory", synopsis: "a strong-to-very strong El Niño is likely" }), "strongElNino");
  assert.equal(currentEnso({ status: "La Niña Watch", synopsis: "" }), "laNina");
  assert.equal(currentEnso({ status: "Not Active", synopsis: "ENSO-neutral is favored" }), null);
});

const season = (years) => ({
  enso: { status: "El Niño Advisory", synopsis: "strong El Niño likely" },
  ensoHistory: { regions: { "the Sierra": { "04-01": { strongElNino: {
    n: years.length, median: [...years].sort((a, b) => a - b)[Math.floor(years.length / 2)],
    above: years.filter((p) => p >= 100).length, years: years.map((p, i) => [1992 + i, 2, p]) } } } } },
});
const text = (l) => l.segs.map((s) => s.t).join("");

test("either way when the past is split, and a small sample is named", () => {
  const l = ensoHistoryLine("the Sierra", season([62, 166, 107, 110, 85]), "2027-03-01");
  assert.match(text(l), /The Sierra's snowpack on Apr 1 ran 62–166% of normal, 3 of 5 at or above it\. Here it has gone either way/);
  assert.match(text(l), /5 winters is a small sample/);
});

test("favor and short only on a lopsided record", () => {
  assert.match(text(ensoHistoryLine("the Sierra", season([120, 140, 115, 130]), null)), /tended to favor the Sierra/);
  assert.match(text(ensoHistoryLine("the Sierra", season([70, 80, 60, 105]), null)), /tended to leave the Sierra short/);
});

test("no history, no line (never a guess)", () => {
  assert.equal(ensoHistoryLine("the Wasatch", season([100, 100, 100]), null), null);
  assert.equal(ensoHistoryLine("the Sierra", season([100, 120]), null), null);
});
