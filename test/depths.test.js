import { test } from "node:test";
import assert from "node:assert/strict";
import { snowpack } from "../src/lib/depths.js";

const resort = (depths) => ({ depths });

test("the last snowfall carries its amount when Snow-Forecast publishes one", () => {
  const p = snowpack(resort({ "Fresh snowfall depth": "14 cm", "Last snowfall": "29 Oct 2026" }));
  assert.equal(p.last, "2026-10-29");
  assert.equal(p.fresh, 14);
});

test("an old snowfall has a date but no amount", () => {
  const p = snowpack(resort({ "Fresh snowfall depth": "—", "Last snowfall": "22 Oct 2026" }));
  assert.equal(p.last, "2026-10-22");
  assert.equal(p.fresh, null);
});

test("zero fresh snow is not an amount", () => {
  assert.equal(snowpack(resort({ "Fresh snowfall depth": "0 cm" })).fresh, null);
});

test("no depths at all", () => {
  assert.deepEqual(snowpack({}), { base: null, top: null, last: null, fresh: null });
});
