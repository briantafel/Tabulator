import { test } from "node:test";
import assert from "node:assert/strict";
import { cellSnowTxt } from "../src/lib/units.js";

test("radar cells print the amount the way Brian's variant does", () => {
  const inch = (n) => n * 2.54;
  assert.equal(cellSnowTxt(inch(0.4), false), ".4");
  assert.equal(cellSnowTxt(1, false), ".4", "1 cm is .4, not the noisy .39");
  assert.equal(cellSnowTxt(2, false), ".8");
  assert.equal(cellSnowTxt(inch(1.2), false), "1.2");
  assert.equal(cellSnowTxt(inch(3), false), "3");
  assert.equal(cellSnowTxt(inch(12.4), false), "12");
  assert.equal(cellSnowTxt(5.5, true), "5.5");
  assert.equal(cellSnowTxt(14, true), "14");
});

test("an empty day prints nothing rather than a zero", () => {
  for (const v of [null, undefined, 0, 0.04]) assert.equal(cellSnowTxt(v, false), null);
});
