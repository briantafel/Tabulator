import { test } from "node:test";
import assert from "node:assert/strict";
import { applySnowfall } from "../src/lib/ours.js";
import { bandAround } from "../src/lib/projections.js";

const NOW = Date.parse("2026-11-18T18:00:00Z");
const spread = { p10: 2, p25: 4, p50: 6, p75: 9, p90: 13 };

test("our number gets a band centred on it, not on Snow-Forecast's (Snowbird Thu 11-19)", () => {
  const sf = 6.1, ours = 23.4; // cm: SF 2.4", ours 9.2"
  const feed = { resorts: [{ id: "snowbird", days: [
    { date: "2026-11-19", snow: sf, range: bandAround(sf, spread), spread },
  ] }] };
  const blend = { fetchedAt: "2026-11-18T16:21:21Z", resorts: { snowbird: { days: [{ date: "2026-11-19", snow: ours }] } } };
  const d = applySnowfall(feed, blend, NOW).resorts[0].days[0];
  assert.equal(d.snow, ours);
  assert.equal(d.sfSnow, sf);
  assert.ok(d.range.p25 <= ours && ours <= d.range.p75, JSON.stringify(d.range));
  assert.deepEqual(d.range, bandAround(ours, spread));
});

test("a day with no spread keeps no band rather than Snow-Forecast's", () => {
  const feed = { resorts: [{ id: "x", days: [{ date: "2026-11-19", snow: 1, range: { p10: 0, p25: 0, p75: 2, p90: 3 } }] }] };
  const blend = { fetchedAt: "2026-11-18T16:21:21Z", resorts: { x: { days: [{ date: "2026-11-19", snow: 20 }] } } };
  assert.equal(applySnowfall(feed, blend, NOW).resorts[0].days[0].range, undefined);
});
