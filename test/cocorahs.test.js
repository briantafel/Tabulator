import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, obsTime, reportRows, statesFor } from "../scripts/archive/cocorahs.js";

const CSV = `ObservationDate,ObservationTime,EntryDateTime,StationNumber,StationName,Latitude,Longitude,TotalPrecipAmt,NewSnowDepth,NewSnowSWE,TotalSnowDepth,TotalSnowSWE,DateTimeStamp
2026-11-10, 02:00 PM, 2026-11-10 03:51 PM, UT-SL-27, Sandy 2.0 NE, 40.6, -111.85, 0.52, 6.5, T, NA, NA, 2026-11-10 10:50 PM`;

test("CoCoRaHS: GMT obs time, inches to metric, trace kept as 0 with T, NA dropped", () => {
  const [rep] = parseCsv(CSV, ["StationNumber"]);
  assert.equal(obsTime(rep.ObservationDate, rep.ObservationTime), "2026-11-10T14:00:00.000Z");
  assert.equal(obsTime("2026-11-10", "12:30 AM"), "2026-11-10T00:30:00.000Z");
  const rows = reportRows(rep, { lat: 40.6, lon: -111.85, elevation_m: 1400 }, { fetchedAt: "f", runId: "r" });
  assert.deepEqual(rows.map((r) => [r.variable, r.value, r.value_text]),
    [["precip_24h", 13.21, null], ["new_snow_24h", 16.51, null], ["new_snow_water_24h", 0, "T"]]);
  assert.equal(rows[1].valid_start, "2026-11-09T14:00:00.000Z");
});

test("CoCoRaHS: missing column fails loudly", () => {
  assert.throws(() => parseCsv("A,B\n1,2", ["NewSnowDepth"]), /format changed/);
});

test("CoCoRaHS: states from resort regions, Canada adds provinces, overseas skipped", () => {
  assert.deepEqual(statesFor([{ region: "Utah" }, { region: "Canada" }, { country: "CH", archiveOnly: true, region: "Valais" }]),
    ["AB", "BC", "ON", "QC", "UT"]);
});
