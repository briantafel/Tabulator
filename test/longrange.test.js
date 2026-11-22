import { test } from "node:test";
import assert from "node:assert/strict";
import { oddsFor, dayNumber } from "../src/lib/longrange.js";
import { parseFlags } from "../src/lib/flags.js";

const NOW = Date.parse("2026-11-22T18:00:00Z");
const days = ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01"];
const lr = (over = {}) => ({
  generatedAt: "2026-11-22T10:30:00Z", calibration: { winters: ["a", "b", "c", "d", "e", "f"] },
  resorts: { alta: { windows: [{ end: "2026-12-04", p: 0.35, lead: 13 }, { end: "2026-12-05", p: 0.2, lead: 14 }] } }, ...over,
});

test("odds start the day after the sheet's last day and carry day numbers", () => {
  const o = oddsFor(lr(), "alta", days, NOW);
  assert.deepEqual(o.rows.map((r) => [r.label, r.pct, r.steps]), [["Dec 2–4", 35, 2], ["Dec 3–5", 20, 1]]);
  assert.equal(o.from, 11); assert.equal(o.to, 14); assert.equal(o.dates, "Dec 2–5"); assert.equal(o.winters, 6);
  assert.equal(dayNumber(days[0], "2026-12-05"), 14);
});

test("a window that starts inside the inches the sheet shows is not an odds row", () => {
  const w = lr({ resorts: { alta: { windows: [{ end: "2026-12-02", p: 0.5 }, { end: "2026-12-04", p: 0.3 }] } } });
  assert.deepEqual(oddsFor(w, "alta", days, NOW).rows.map((r) => r.label), ["Dec 2–4"]);   // Nov 30–Dec 2 starts on day 9
});

test("hidden, never zero: missing file, stale file, other resort, nothing past the sheet, bad number", () => {
  assert.equal(oddsFor(null, "alta", days, NOW), null);
  assert.equal(oddsFor(lr({ generatedAt: "2026-11-20T10:30:00Z" }), "alta", days, NOW), null);
  assert.equal(oddsFor(lr(), "snowbird", days, NOW), null);
  assert.equal(oddsFor(lr(), "alta", [...days, "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"], NOW), null);
  assert.equal(oddsFor(lr({ resorts: { alta: { windows: [{ end: "2026-12-04", p: NaN }] } } }), "alta", days, NOW), null);
  assert.equal(oddsFor(lr({ resorts: { alta: { windows: [] } } }), "alta", days, NOW), null);
});

test("a day past the 14th is not shown", () => {
  const w = lr({ resorts: { alta: { windows: [{ end: "2026-12-06", p: 0.4 }] } } });
  assert.equal(oddsFor(w, "alta", days, NOW), null);
});

test("the switch: off unless the file says otherwise", () => {
  assert.equal(parseFlags(null).longRange, "off");
  assert.equal(parseFlags({ longRange: "on" }).longRange, "on");
  assert.equal(parseFlags({ longRange: "yes" }).longRange, "off");
});
