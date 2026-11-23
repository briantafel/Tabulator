import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { due, SCHEDULE, DEFAULT_MINUTE } from "../workers/scheduler/index.js";

/* Rules, not a hard-coded list (2026-11-18): adding a job to the table must
   not break every deploy, as it did twice that evening (ac6c289, 5578331). */
test("every scheduled job starts exactly on its own hours, and only then", () => {
  for (const { file, every, offset, minute = DEFAULT_MINUTE } of SCHEDULE) {
    const hours = [...Array(24).keys()].filter((h) => due(h, SCHEDULE, minute).includes(file));
    const want = [...Array(24).keys()].filter((h) => h % every === offset);
    // a file listed twice (blend: 07 and 21) is due at the union of its entries (at this minute)
    const all = SCHEDULE.filter((e) => e.file === file && (e.minute ?? DEFAULT_MINUTE) === minute)
      .flatMap((e) => [...Array(24).keys()].filter((h) => h % e.every === e.offset));
    assert.ok(want.every((h) => hours.includes(h)), `${file} missing at ${want.filter((h) => !hours.includes(h))}`);
    assert.deepEqual(hours, [...new Set(all)].sort((a, b) => a - b), file);
  }
});

/* 2026-11-23: a schedule entry whose minute has no cron trigger in wrangler.toml would deploy fine and then
   silently never start. Every (hour, minute) the table asks for must be matched by a trigger. */
test("every start in the table is matched by a cron trigger in wrangler.toml", () => {
  const toml = readFileSync(new URL("../workers/scheduler/wrangler.toml", import.meta.url), "utf8");
  const crons = [...toml.matchAll(/^\s*"([^"]+)",?\s*(?:#.*)?$/gm)].map((m) => m[1])
    .filter((c) => c.split(" ").length === 5);
  assert.ok(crons.length >= 2, "expected the hourly trigger and the :45 trigger, got " + JSON.stringify(crons));
  const matches = (field, n) => field === "*" || field.split(",").map(Number).includes(n);
  const fires = (h, m) => crons.some((c) => { const [cm, ch] = c.split(" "); return matches(cm, m) && matches(ch, h); });
  for (const { file, minute = DEFAULT_MINUTE } of SCHEDULE) {
    for (let h = 0; h < 24; h++) {
      if (due(h, SCHEDULE, minute).includes(file)) assert.ok(fires(h, minute), `${file} is due at ${h}:${minute} but no cron trigger fires then`);
    }
  }
});

test("jobs moved onto the Worker on 2026-11-23 start where their old GitHub cron did, or just after (see index.js)", () => {
  const at = (f, m = DEFAULT_MINUTE) => [...Array(24).keys()].filter((h) => due(h, SCHEDULE, m).includes(f));
  assert.deepEqual(at("archive.yml", 45), [6, 21]);   // 30 min after forecast.yml (06:07 / 21:07), as before
  assert.deepEqual(at("archive.yml"), []);            // never at :07, which would overlap the app's own scrape
  assert.deepEqual(at("season.yml"), [14]);
  assert.deepEqual(at("nohrsc.yml"), [15]);
  assert.deepEqual(at("longrange.yml"), [11]);        // after projections-dyn.yml (10:07)
  assert.equal(SCHEDULE.some((e) => e.file === "hrrr-backfill.yml"), false); // finished 2026-11-19
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
  assert.deepEqual(hours("blend.yml"), [1, 4, 7, 10, 13, 16, 19, 22]); // woken every 3 h since 2026-11-22; builds only on a new model run
  assert.deepEqual(hours("temps.yml"), [5, 11, 17, 23]);
});

test("our blend is woken every 3 h, 01 UTC on (2026-11-22)", () => {
  const hours = [...Array(24).keys()].filter((h) => due(h).includes("blend.yml"));
  assert.deepEqual(hours, [1, 4, 7, 10, 13, 16, 19, 22]);
});
