import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastRow, ensembleRow, noaaRow, ensoRow } from "../src/lib/lookahead.js";

const day = (date, snow, projected = false) => ({ date, snow, projected });
const R = (name, snows) => ({ name, days: snows.map((s, i) => day(`2026-11-${17 + i}`, s)) });

test("forecast row: typical total, the day that carries it, the leader", () => {
  const r = forecastRow([R("A", [0, 20, 5, 0, 0, 0]), R("B", [0, 30, 10, 0, 0, 0]), R("C", [0, 60, 20, 0, 0, 0])], true);
  const t = r.segs.map((s) => s.t).join("");
  assert.match(t, /About 40cm at a typical resort here over the next 6 days, most of it/);
  assert.match(t, /C leads with 80cm/);
  assert.equal(r.conf, "likely");
  assert.match(forecastRow([R("A", [0, 0, 0, 0, 0, 0])], true).segs[0].t, /Little or no snow/);
});

test("ensemble row: members added up per member, models weighted equally", () => {
  const pm = (rows) => ({ projMembers: { dates: ["2026-11-23", "2026-11-24"], models: { ecmwf: rows, gefs: [[0, 0], [0, 0]] } } });
  // ECMWF: 2 of 4 members >= 30 cm; GEFS: none. Equal model weight -> 25%.
  const r = ensembleRow([pm([[20, 20], [15, 20], [0, 0], [1, 1]])], true);
  assert.equal(r.beta, true);
  assert.match(r.segs[0].t, /^3 in 10$/);
  assert.equal(r.conf, "lean");
});

test("NOAA row reads the region's majority category; equal chances say so", () => {
  const season = { outlook: { a: { d8_14: { precip: { category: "above", prob: 40, start: "2026-11-25", end: "2026-12-01" }, temp: { category: "near", prob: 33 } } },
                              b: { d8_14: { precip: { category: "above", prob: 50 }, temp: { category: "near", prob: 33 } } } } };
  const t = noaaRow(["a", "b"], season).segs.map((s) => s.t).join("");
  assert.match(t, /wetter than normal \(45% chance\), with near-normal temperatures/);
  const eq = noaaRow(["a"], { outlook: { a: { d8_14: { precip: { category: "equal" }, temp: { category: "equal" } } } } });
  assert.match(eq.segs[0].t, /equal chances/);
});

test("ENSO row", () => {
  assert.equal(ensoRow({ enso: { status: "El Niño Advisory", synopsis: "Strong." } }).segs[0].t, "El Niño Advisory.");
  assert.equal(ensoRow({}), null);
});
