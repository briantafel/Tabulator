import { test } from "node:test";
import assert from "node:assert/strict";
import { inGeometry, zoneFor, parseAvorgProduct, parseAvcanProduct, maxBand, withHistory } from "../scripts/season/avalanche.js";

const square = { type: "Polygon", coordinates: [[[-112, 40], [-111, 40], [-111, 41], [-112, 41], [-112, 40]]] };

test("point in polygon", () => {
  assert.equal(inGeometry([-111.6, 40.6], square), true);
  assert.equal(inGeometry([-110.6, 40.6], square), false);
  assert.equal(inGeometry([-111.6, 40.6], { type: "MultiPolygon", coordinates: [square.coordinates] }), true);
});

test("a resort finds its avalanche.org zone; no rating is null, not low", () => {
  const layer = { features: [{ id: 1738, geometry: square, properties: { name: "Salt Lake", center_id: "UAC", center: "Utah Avalanche Center", danger_level: -1, off_season: false, link: "u" } }] };
  const z = zoneFor([40.6, -111.6], layer);
  assert.deepEqual([z.zoneId, z.centerId, z.mapLevel], [1738, "UAC", null]);
  assert.equal(zoneFor([30, -100], layer), null);
});

test("avalanche.org product: bands, problems by rank, persistent flag", () => {
  const p = parseAvorgProduct({
    published_time: "2026-12-01T13:00:00Z",
    danger: [{ valid_day: "tomorrow", upper: 4, middle: 3, lower: 2 }, { valid_day: "current", upper: 3, middle: 2, lower: 1 }],
    forecast_avalanche_problems: [{ name: "Wind Slab", rank: 2 }, { name: "Persistent Slab", rank: 1 }],
  });
  assert.deepEqual(p.bands, { upper: 3, middle: 2, lower: 1 });
  assert.deepEqual(p.problems, ["Persistent Slab", "Wind Slab"]);
  assert.equal(p.persistent, true);
  assert.equal(parseAvorgProduct({ danger: [], forecast_avalanche_problems: [] }).bands, null);
});

test("Avalanche Canada product", () => {
  const p = parseAvcanProduct({ area: { name: "Glacier" }, report: { dateIssued: "x", dangerRatings: [{ ratings: { alp: { rating: { value: "considerable" } }, tln: { rating: { value: "moderate" } }, btl: { rating: { value: "norating" } } } }], problems: [{ type: { display: "Deep Persistent Slabs" } }] } });
  assert.deepEqual(p.bands, { upper: 3, middle: 2, lower: null });
  assert.equal(maxBand(p.bands), 3);
  assert.equal(p.persistent, true);
});

test("history keeps 14 days, one per day", () => {
  let h = null;
  for (let i = 1; i <= 16; i++) h = withHistory({ history: h }, `2026-12-${String(i).padStart(2, "0")}`, i % 5);
  assert.equal(h.length, 14);
  assert.equal(withHistory({ history: h }, "2026-12-16", 3).length, 14, "same day replaces");
});
