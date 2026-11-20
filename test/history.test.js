import { test } from "node:test";
import assert from "node:assert/strict";
import { openHistory, recordDay, HISTORY_DAYS } from "../scripts/history.js";

// A day-0 as the parser emits it: periods named am / pm / night.
const day = (date, am, pm, night) => ({
  date, snow: am + pm + night,
  periods: [{ name: "am", snow: am }, { name: "pm", snow: pm }, { name: "night", snow: night }],
});
// The table opens at the current period, so a late scrape holds only the rest.
const late = (date, night) => ({ date, snow: night, periods: [{ name: "night", snow: night }] });
const resorts = (snow, date = "2026-01-10") => [
  { id: "alta", days: [day(date, snow, 0, 0)] },
  { id: "taos", days: [day(date, snow * 2, 0, 0)] },
];

test("a synthetic archive is discarded, never merged", () => {
  // `npm run fixture` and `npm run scrape` write the same path. Appending real
  // observations onto invented ones would put fabricated snowfall in the one
  // column the user reads as ground truth.
  const fake = { synthetic: true, days: { "2026-01-09": { alta: 99 } } };
  const opened = openHistory(fake);
  assert.deepEqual(opened.days, {});
  assert.equal(opened.discarded, true);
});

test("a real archive is carried forward", () => {
  const real = { days: { "2026-01-09": { alta: 4 } }, parts: { "2026-01-09": { alta: { am: 4, pm: 0, night: 0 } } } };
  const opened = openHistory(real);
  assert.deepEqual(opened.days, { "2026-01-09": { alta: 4 } });
  assert.deepEqual(opened.parts, real.parts);
  assert.equal(opened.discarded, false);
});

test("a missing or malformed archive starts clean without claiming contamination", () => {
  for (const input of [null, undefined, "nonsense", 42]) {
    const o = openHistory(input);
    assert.deepEqual(o.days, {});
    assert.deepEqual(o.parts, {});
    assert.equal(o.discarded, false, `${input} is absent, not synthetic`);
  }
});

test("records each resort's day-0 snowfall under its date", () => {
  const h = recordDay(openHistory(null), resorts(3), new Date("2026-01-10T06:00:00Z"));
  assert.deepEqual(h.days["2026-01-10"], { alta: 3, taos: 6 });
  assert.equal(h.updatedAt, "2026-01-10T06:00:00.000Z");
});

test("a later scrape that only sees the night cannot shrink the day", () => {
  // Kirkwood, 2026-11-18: a morning scrape saw the whole 66 cm day, and the
  // evening scrape (day 0 = night only) used to overwrite it with 41.
  let h = recordDay(openHistory(null), [{ id: "kirkwood", days: [day("2026-11-18", 60, 5, 1)] }]);
  assert.equal(h.days["2026-11-18"].kirkwood, 66);
  h = recordDay(h, [{ id: "kirkwood", days: [late("2026-11-18", 1)] }]);
  assert.equal(h.days["2026-11-18"].kirkwood, 66, "am and pm are kept from the earlier scrape");
});

test("a later scrape replaces a period it still sees (closer to the event)", () => {
  let h = recordDay(openHistory(null), [{ id: "alta", days: [day("2026-01-10", 4, 4, 4)] }]);
  h = recordDay(h, [{ id: "alta", days: [late("2026-01-10", 10)] }]);
  assert.equal(h.days["2026-01-10"].alta, 18);
  assert.deepEqual(h.parts["2026-01-10"].alta, { am: 4, pm: 4, night: 10 });
});

test("a day whose morning was never seen is missing, never a short total", () => {
  // First scrape of the day came after the am period had passed.
  const h = recordDay(openHistory(null), [{ id: "alta", days: [late("2026-01-10", 7)] }]);
  assert.equal(h.days["2026-01-10"]?.alta, undefined);
  assert.deepEqual(h.parts["2026-01-10"].alta, { night: 7 });
});

test("a day-0 with no periods records nothing rather than guessing", () => {
  const h = recordDay(openHistory(null), [{ id: "alta", days: [{ date: "2026-01-10", snow: 4 }] }]);
  assert.deepEqual(h.days, {});
  assert.deepEqual(h.parts, {});
});

test("resorts that failed to parse are skipped, not written as zero", () => {
  const partial = [
    { id: "alta", days: [day("2026-01-10", 4, 0, 0)] },
    { id: "taos", days: [] },
    { id: "stowe", days: [{ date: "2026-01-10", snow: null, periods: [{ name: "am", snow: null }] }] },
  ];
  const h = recordDay(openHistory(null), partial);
  assert.deepEqual(h.days["2026-01-10"], { alta: 4 });
});

test("the archive is trimmed to the retention window, keeping the newest", () => {
  let parts = {};
  for (let i = 1; i <= HISTORY_DAYS + 5; i++) {
    parts[`2026-01-${String(i).padStart(2, "0")}`] = { alta: { am: i, pm: 0, night: 0 } };
  }
  const h = recordDay({ parts }, []);
  const keys = Object.keys(h.days);
  assert.equal(keys.length, HISTORY_DAYS);
  assert.equal(keys[keys.length - 1], `2026-01-${HISTORY_DAYS + 5}`);
  assert.ok(!keys.includes("2026-01-01"), "oldest day should be dropped");
});
