import { test } from "node:test";
import assert from "node:assert/strict";
import { openHistory, recordDay, HISTORY_DAYS } from "../scripts/history.js";

const resorts = (snow, date = "2026-01-10") => [
  { id: "alta", days: [{ date, snow }] },
  { id: "taos", days: [{ date, snow: snow * 2 }] },
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
  const real = { days: { "2026-01-09": { alta: 4 } } };
  const opened = openHistory(real);
  assert.deepEqual(opened.days, { "2026-01-09": { alta: 4 } });
  assert.equal(opened.discarded, false);
});

test("a missing or malformed archive starts clean without claiming contamination", () => {
  for (const input of [null, undefined, "nonsense", 42]) {
    const o = openHistory(input);
    assert.deepEqual(o.days, {});
    assert.equal(o.discarded, false, `${input} is absent, not synthetic`);
  }
});

test("records each resort's day-0 snowfall under its date", () => {
  const h = recordDay(openHistory(null), resorts(3), new Date("2026-01-10T06:00:00Z"));
  assert.deepEqual(h.days["2026-01-10"], { alta: 3, taos: 6 });
  assert.equal(h.updatedAt, "2026-01-10T06:00:00.000Z");
});

test("a second run the same day overwrites rather than duplicating", () => {
  let h = recordDay(openHistory(null), resorts(3));
  h = recordDay({ days: h.days }, resorts(5));
  assert.deepEqual(h.days["2026-01-10"], { alta: 5, taos: 10 });
  assert.equal(Object.keys(h.days).length, 1);
});

test("resorts that failed to parse are skipped, not written as zero", () => {
  const partial = [
    { id: "alta", days: [{ date: "2026-01-10", snow: 4 }] },
    { id: "taos", days: [] },
    { id: "stowe", days: [{ date: "2026-01-10", snow: null }] },
  ];
  const h = recordDay(openHistory(null), partial);
  assert.deepEqual(h.days["2026-01-10"], { alta: 4 });
});

test("the archive is trimmed to the retention window, keeping the newest", () => {
  let days = {};
  for (let i = 1; i <= HISTORY_DAYS + 5; i++) {
    days[`2026-01-${String(i).padStart(2, "0")}`] = { alta: i };
  }
  const h = recordDay({ days }, []);
  const keys = Object.keys(h.days);
  assert.equal(keys.length, HISTORY_DAYS);
  assert.equal(keys[keys.length - 1], `2026-01-${HISTORY_DAYS + 5}`);
  assert.ok(!keys.includes("2026-01-01"), "oldest day should be dropped");
});
