import { test } from "node:test";
import assert from "node:assert/strict";
import { dataToRows, toMetric, DAILY_TEMP_ELEMENTS } from "../scripts/archive/snotel.js";

test("TMAX / TMIN convert °F → °C like TOBS", () => {
  assert.deepEqual(toMetric("TMAX", 32, "degF"), { value: 0, unit: "C" });
  assert.deepEqual(toMetric("TMIN", 14, "degF"), { value: -10, unit: "C" });
  assert.throws(() => toMetric("TMAX", 5, "K"), /unknown unit/);
  assert.deepEqual(DAILY_TEMP_ELEMENTS, ["TMAX", "TMIN"]);
});

test("daily TMAX / TMIN become temp_max / temp_min rows for the station-local day", () => {
  const stationsById = new Map([["1067:CA:SNTL", { latitude: 38.7, longitude: -120.1, elevation: 8000, dataTimeZone: -8 }]]);
  const json = [{
    stationTriplet: "1067:CA:SNTL",
    data: [
      { stationElement: { elementCode: "TMAX", storedUnitCode: "degF" }, values: [{ date: "2026-11-09", value: 50 }] },
      { stationElement: { elementCode: "TMIN", storedUnitCode: "degF" }, values: [{ date: "2026-11-09", value: 23 }] },
    ],
  }];
  const rows = dataToRows(json, { stationsById, duration: "DAILY", fetchedAt: "2026-11-10T00:00:00Z", runId: "t" });
  assert.equal(rows.length, 2);
  const hi = rows.find((r) => r.variable === "temp_max");
  assert.equal(hi.value, 10);
  assert.equal(hi.valid_start, "2026-11-09T08:00:00.000Z");
  assert.equal(hi.period_label, "daily");
  assert.equal(rows.find((r) => r.variable === "temp_min").value, -5);
});
