import { test } from "node:test";
import assert from "node:assert/strict";
import { previousRunsToRows, PARSER_VERSION } from "../scripts/archive/previous-runs.js";

test("Previous Runs: hourly temp rows per lead (lift-hours low), gaps dropped not zero", () => {
  const time = Array.from({ length: 6 }, (_, h) => `2025-01-01T0${h}:00`);
  const json = { latitude: 1, longitude: 2, elevation: 2500,
    hourly_units: { temperature_2m: "°C", temperature_2m_previous_day1: "°C" },
    hourly: { time, temperature_2m: [1, 2, 3, 4, 5, 6], temperature_2m_previous_day1: [0, 1, 2, 3, 4, null] } };
  const rows = previousRunsToRows(json, { resort: { id: "alta" }, model: "gfs_seamless", fetchedAt: "x", runId: "r" });
  const temps = rows.filter((r) => r.variable === "temp");
  assert.equal(temps.filter((r) => r.period_label === "previous_day0").length, 6);
  assert.equal(temps.filter((r) => r.period_label === "previous_day1").length, 5); // null hour: no row
  const r = temps.find((x) => x.period_label === "previous_day1" && x.valid_start === "2025-01-01T03:00:00.000Z");
  assert.equal(r.value, 3);
  assert.equal(r.valid_end, "2025-01-01T04:00:00.000Z");
  assert.equal(r.issued_at, "2024-12-31T03:00:00.000Z");
  assert.equal(r.parser_version, PARSER_VERSION);
});
