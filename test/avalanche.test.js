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

test("UAC danger rose → elevation bands; pockets of X count as X (2026-11-18)", async () => {
  const { parseUacForecast, uacSlug } = await import("../scripts/season/avalanche.js");
  // high ring: Considerable on N–E (6), pockets of considerable elsewhere (5)
  // mid ring: Moderate (4); low ring: pockets of moderate (3) and low (2)
  const rose = [6, 6, 6, 5, 5, 5, 5, 6, 4, 4, 4, 4, 4, 4, 4, 4, 3, 2, 2, 2, 2, 2, 2, 3];
  const json = { advisories: [{ advisory: { date_issued: "Wednesday, November 18, 2026 - 5:41am", overall_danger_rose: rose.join(",") } }] };
  assert.deepEqual(parseUacForecast(json).bands, { upper: 3, middle: 2, lower: 2 });
  assert.equal(parseUacForecast({ advisories: [{ advisory: { overall_danger_rose: "0,0" } }] }), null);
  assert.equal(parseUacForecast({ advisories: [{ advisory: { overall_danger_rose: Array(24).fill(0).join(",") } }] }), null);
  assert.equal(uacSlug("https://utahavalanchecenter.org/forecast/salt-lake"), "salt-lake");
  assert.equal(uacSlug("https://www.sierraavalanchecenter.org/forecasts/x"), null);
});
