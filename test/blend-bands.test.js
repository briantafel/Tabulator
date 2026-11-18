import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bandFor } from "../scripts/blend/lib.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/bands-parity.json", import.meta.url), "utf8"));

test("bandFor (JS) matches bands.py band_for (Python) on every fixture case", () => {
  for (const c of fx.cases) {
    const b = bandFor(fx.bands, c.lead, c.f);
    for (const k of ["p10", "p25", "p75", "p90"]) assert.ok(Math.abs(b[k] - c.band[k]) < 1e-4, `${c.lead}/${c.f} ${k}: ${b[k]} vs ${c.band[k]}`);
  }
});

test("a band always contains the forecast and is ordered", () => {
  for (const c of fx.cases) {
    const b = bandFor(fx.bands, c.lead, c.f);
    assert.ok(b.p10 <= b.p25 && b.p25 <= c.f + 1e-9 && c.f <= b.p75 + 1e-9 && b.p75 <= b.p90, JSON.stringify(c));
  }
});

test("no bands file -> no band on the day", () => {
  assert.equal(bandFor(null, 1, 5), null);
});
