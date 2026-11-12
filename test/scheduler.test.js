import { test } from "node:test";
import assert from "node:assert/strict";
import { due } from "../workers/scheduler/index.js";

test("scheduler starts hourly jobs every hour and 3-hourly jobs on their offsets", () => {
  assert.deepEqual(due(0), ["watchdog.yml", "dynamical-history.yml", "upper-air.yml"]);
  assert.deepEqual(due(1), ["watchdog.yml", "dynamical-history.yml", "regional-eps.yml"]);
  assert.deepEqual(due(5), ["watchdog.yml", "dynamical-history.yml", "dynamical-ens.yml", "nbm.yml"]);
  const perDay = Array.from({ length: 24 }, (_, h) => due(h)).flat();
  assert.equal(perDay.filter((f) => f === "regional-eps.yml").length, 8);
});

test("daily jobs start once a day, at their hour (2026-11-11)", () => {
  const hours = (f) => [...Array(24).keys()].filter((h) => due(h).includes(f));
  assert.deepEqual(hours("ensembles-om.yml"), [8]);
  assert.deepEqual(hours("projections-dyn.yml"), [10]);
});
