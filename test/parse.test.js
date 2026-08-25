import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResortPage, parseSnow, parseWind, resolveDates } from "../scripts/parse.js";
import { buildPage } from "./sf-fixture.js";

const NOW = new Date("2026-08-20T12:00:00Z");
const parse = (opts) => parseResortPage(buildPage(opts), { now: NOW });

test("em-dash means no snow, not missing data", () => {
  // The single most consequential quirk: Snow-Forecast renders zero snow as
  // an em-dash. Read as null it would poison every sum downstream.
  assert.equal(parseSnow("—"), 0);
  assert.equal(parseSnow("–"), 0);
  assert.equal(parseSnow("-"), 0);
  assert.equal(parseSnow(""), 0);
  assert.equal(parseSnow("2"), 2);
  assert.equal(parseSnow("0.4"), 0.4);
  assert.equal(parseSnow("garbage"), 0);
});

test("wind splits magnitude from bearing", () => {
  assert.deepEqual(parseWind("15NNW"), { speed: 15, dir: "NNW" });
  assert.deepEqual(parseWind("0S"), { speed: 0, dir: "S" });
  assert.deepEqual(parseWind("5"), { speed: 5, dir: null });
  assert.deepEqual(parseWind("—"), { speed: null, dir: null });
});

test("day-of-month headers resolve to real dates across a month boundary", () => {
  const d = resolveDates(["Thursday28", "Friday29", "Saturday30", "Sunday31", "Monday1", "Tuesday2"],
    new Date("2026-08-28T00:00:00Z"));
  assert.deepEqual(d, ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
});

test("resolves dates across a year boundary", () => {
  const d = resolveDates(["Wednesday30", "Thursday31", "Friday1"], new Date("2026-12-30T00:00:00Z"));
  assert.deepEqual(d, ["2026-12-30", "2026-12-31", "2027-01-01"]);
});

test("parses six days with three periods each", () => {
  const r = parse();
  assert.equal(r.days.length, 6);
  for (const d of r.days) {
    assert.equal(d.periods.length, 3);
    assert.deepEqual(d.periods.map((p) => p.name), ["am", "pm", "night"]);
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(r.days[0].date, "2026-08-20");
});

test("reads tier elevations off the page instead of a maintained constant", () => {
  const r = parse({ elev: [3369, 2896, 2424] });
  assert.deepEqual(r.elevation, { top: 3369, mid: 2896, bot: 2424 });
});

test("daily snow is the sum of its three periods", () => {
  const snow = Array(18).fill("—");
  snow[3] = "5"; snow[4] = "2.5"; snow[5] = "—";   // day 2: 7.5cm
  const r = parse({ snow });
  assert.equal(r.days[0].snow, 0);
  assert.equal(r.days[1].snow, 7.5);
});

test("temp is the day max, wind the day max, freezing level min and max", () => {
  const tmax = Array(18).fill(0); tmax[0] = 5; tmax[1] = 11; tmax[2] = -2;
  const wind = Array(18).fill("0N"); wind[0] = "10NW"; wind[1] = "40S"; wind[2] = "5E";
  const freeze = Array(18).fill(3000); freeze[0] = 2800; freeze[1] = 3400; freeze[2] = 2600;
  const r = parse({ tmax, wind, freeze });
  assert.equal(r.days[0].tempMax, 11);
  assert.equal(r.days[0].windMax, 40);
  assert.equal(r.days[0].freezeMin, 2600);
  assert.equal(r.days[0].freezeMax, 3400);
});

test("keeps the forecaster's prose — the reason for leaving Open-Meteo", () => {
  const r = parse();
  assert.match(r.summary.next3, /Heavy rain/);
  assert.match(r.summary.days46, /Light rain/);
});

test("reads the snow-depths table by class, not position", () => {
  const r = parse({ lastSnowfall: "3 Jan 2027" });
  assert.equal(r.depths["Last snowfall"], "3 Jan 2027");
  assert.equal(r.depths["Top snow depth"], "0 cm");
});

test("a missing optional row degrades instead of throwing", () => {
  const r = parse({ omitRows: ["freezing-level", "phrases"] });
  assert.equal(r.days[0].freezeMin, null);
  assert.equal(r.days[0].periods[0].phrase, null);
  assert.equal(r.days.length, 6, "the rest of the parse still completes");
});

test("a missing REQUIRED row throws loudly rather than returning empty data", () => {
  // Silent degradation is how the spreadsheet rotted for months. If the page
  // shape changes underneath us the scrape must fail visibly.
  assert.throws(() => parse({ omitRows: ["days"] }), /data-row="days"/);
  assert.throws(() => parseResortPage("<html><body>nope</body></html>"), /forecast table not found/);
});

test("units are declared, so the app never has to guess", () => {
  assert.deepEqual(parse().units, { snow: "cm", temp: "C", wind: "km/h", elevation: "m" });
});

/* --- The morning-scrape regression, 2026-08-25 ---------------------------
 * The 06:15 UTC run catches most US resorts partway through their local
 * night. Snow-Forecast leads the table with the tail of the previous day in
 * a cell carrying no weekday label, so day zero came back
 * `{ date: null, label: null }` for 19 of 23 resorts, twice a day. The app
 * silently dropped that column, and — worse — recordDay() keys the "-3 days"
 * archive off day zero's date, so half of every day's history was never
 * written. That is the one loss a later scrape cannot repair. */
test("a blank leading day header is recovered, not dropped", () => {
  const out = resolveDates(
    ["", "Tuesday25", "Wednesday26", "Thursday27", "Friday28", "Saturday29"],
    new Date("2026-08-25T06:15:00Z"),
  );
  assert.deepEqual(out, [
    "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29",
  ]);
});

test("a header for yesterday resolves to yesterday, not to next month", () => {
  // The cursor could only walk forward, so "24" on the 25th landed on the
  // 24th of SEPTEMBER — a month-long jump presented as a six-day forecast.
  const out = resolveDates(["Monday24", "Tuesday25"], new Date("2026-08-25T06:15:00Z"));
  assert.deepEqual(out, ["2026-08-24", "2026-08-25"]);
});

test("a blank in the middle or at the end is filled from its neighbour", () => {
  const out = resolveDates(
    ["Tuesday25", "", "Thursday27", ""],
    new Date("2026-08-25T06:15:00Z"),
  );
  assert.deepEqual(out, ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]);
});

test("a table of nothing but blanks stays null — no invented week", () => {
  assert.deepEqual(resolveDates(["", "", ""], new Date("2026-08-25T06:15:00Z")),
    [null, null, null]);
});

test("month and year rollovers still resolve", () => {
  assert.deepEqual(
    resolveDates(["Sunday30", "Monday31", "Tuesday1"], new Date("2026-08-31T06:15:00Z")),
    ["2026-08-30", "2026-08-31", "2026-09-01"],
  );
  assert.deepEqual(
    resolveDates(["Thursday31", "Friday1"], new Date("2026-12-31T06:15:00Z")),
    ["2026-12-31", "2027-01-01"],
  );
});
