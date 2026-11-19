import { test } from "node:test";
import assert from "node:assert/strict";
import { due, SCHEDULE } from "../workers/scheduler/index.js";

/* Rules, not a hard-coded list (2026-11-18): adding a job to the table must
   not break every deploy, as it did twice that evening (ac6c289, 5578331). */
test("every scheduled job starts exactly on its own hours, and only then", () => {
  for (const { file, every, offset } of SCHEDULE) {
    const hours = [...Array(24).keys()].filter((h) => due(h).includes(file));
    const want = [...Array(24).keys()].filter((h) => h % every === offset);
    // a file listed twice (blend: 07 and 21) is due at the union of its entries
    const all = SCHEDULE.filter((e) => e.file === file)
      .flatMap((e) => [...Array(24).keys()].filter((h) => h % e.every === e.offset));
    assert.ok(want.every((h) => hours.includes(h)), `${file} missing at ${want.filter((h) => !hours.includes(h))}`);
    assert.deepEqual(hours, [...new Set(all)].sort((a, b) => a - b), file);
  }
});

test("known fixed points of the table", () => {
  const n = (f) => Array.from({ length: 24 }, (_, h) => due(h)).flat().filter((x) => x === f).length;
  assert.equal(n("watchdog.yml"), 24);
  assert.equal(n("regional-eps.yml"), 8);
  assert.ok(due(0).includes("upper-air.yml") && due(1).includes("regional-eps.yml") && due(5).includes("temps.yml"));
});

test("daily jobs start once a day, at their hour (2026-11-11)", () => {
  const hours = (f) => [...Array(24).keys()].filter((h) => due(h).includes(f));
  assert.deepEqual(hours("ensembles-om.yml"), [8]);
  assert.deepEqual(hours("projections-dyn.yml"), [10]);
  // 2026-11-16: the scoring job and the temperature build, skipped by GitHub's cron.
  assert.deepEqual(hours("verify.yml"), [9]);
  assert.deepEqual(hours("blend.yml"), [7, 21]); // twice a day since 2026-11-18
  assert.deepEqual(hours("temps.yml"), [5, 11, 17, 23]);
});

test("our blend runs twice a day, 07 and 21 UTC (2026-11-18)", () => {
  const hours = [...Array(24).keys()].filter((h) => due(h).includes("blend.yml"));
  assert.deepEqual(hours, [7, 21]);
});
