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

test("a 0 base and top beside fresh snowfall is the vendor's gap, not a bare mountain", () => {
  // Kirkwood 2026-11-19: Bottom 0 cm, Top 0 cm, Fresh snowfall 81 cm.
  const p = snowpack(resort({
    "Bottom snow depth": "0 cm", "Top snow depth": "0 cm",
    "Fresh snowfall depth": "81 cm", "Last snowfall": "18 Nov 2026",
  }));
  assert.equal(p.base, null);
  assert.equal(p.top, null);
  assert.equal(p.fresh, 81);
});

test("0 depth with no fresh snow is still a real 0, and real depths are untouched", () => {
  const bare = snowpack(resort({ "Bottom snow depth": "0 cm", "Top snow depth": "0 cm" }));
  assert.equal(bare.base, 0);
  assert.equal(bare.top, 0);
  const deep = snowpack(resort({
    "Bottom snow depth": "0 cm", "Top snow depth": "35 cm", "Fresh snowfall depth": "10 cm",
  }));
  assert.equal(deep.base, null, "the 0 contradicts the fresh snow");
  assert.equal(deep.top, 35);
});
