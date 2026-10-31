import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addResort, addPlace, removePlace, removeResort, holdsPlace, isDirect,
  toWatchlist, withDates, tripWindow, WATCH_LABEL,
} from "../src/lib/trips.js";

const R = (name) => ({ name, total: 10 });
const CASCADES = ["Mt. Baker", "Mt. Bachelor", "Crystal Mountain", "Stevens Pass"].map(R);
const names = (l) => l.map((e) => e.name);

test("removing a place keeps the resorts that were added on their own", () => {
  // Brian, 2026-10-31: a trip with Alta and Crystal, then the Cascades, then
  // the Cascades back out — Alta and Crystal stay.
  let t = addResort(addResort([], R("Alta")), R("Crystal Mountain"));
  t = addPlace(t, CASCADES, "the Cascades");
  assert.deepEqual(names(t), ["Alta", "Crystal Mountain", "Mt. Baker", "Mt. Bachelor", "Stevens Pass"]);
  t = removePlace(t, "the Cascades");
  assert.deepEqual(names(t), ["Alta", "Crystal Mountain"]);
});

test("adding a resort directly after its place protects it too", () => {
  let t = addPlace([], CASCADES, "the Cascades");
  t = addResort(t, R("Mt. Baker"));
  t = removePlace(t, "the Cascades");
  assert.deepEqual(names(t), ["Mt. Baker"]);
});

test("overlapping places each hold their own share", () => {
  const colorado = ["Vail", "Telluride"].map(R);
  const central = ["Vail", "Breckenridge"].map(R);
  let t = addPlace([], colorado, "Colorado");
  t = addPlace(t, central, "the central Rockies");
  t = removePlace(t, "Colorado");
  assert.deepEqual(names(t), ["Vail", "Breckenridge"]);
  t = removePlace(t, "the central Rockies");
  assert.deepEqual(names(t), []);
});

test("trips saved before this read as added directly", () => {
  const legacy = [{ name: "Crystal Mountain", total: 5 }];
  assert.equal(isDirect(legacy[0]), true);
  const t = removePlace(addPlace(legacy, CASCADES, "the Cascades"), "the Cascades");
  assert.deepEqual(names(t), ["Crystal Mountain"]);
});

test("removing from a resort's own sheet still removes it outright", () => {
  const t = addPlace(addResort([], R("Crystal Mountain")), CASCADES, "the Cascades");
  assert.deepEqual(names(removeResort(t, "Crystal Mountain")), ["Mt. Baker", "Mt. Bachelor", "Stevens Pass"]);
});

test("the place sheet's X shows only when the trip holds the place as a place", () => {
  const all = CASCADES.map((r) => r.name);
  const direct = CASCADES.reduce(addResort, []);
  assert.equal(holdsPlace(direct, all, "the Cascades"), false);
  assert.equal(holdsPlace(addPlace(direct, CASCADES, "the Cascades"), all, "the Cascades"), true);
});

test("adding the same place twice changes nothing", () => {
  const once = addPlace([], CASCADES, "the Cascades");
  assert.deepEqual(addPlace(once, CASCADES, "the Cascades"), once);
});

/* ---- Watchlists ---------------------------------------------------- */

const DATES = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];

test("a watchlist is scored over every day there is data for", () => {
  const w = toWatchlist({ id: "t", name: "W", start: "2027-01-21", end: "2027-01-24", label: "Jan 21–Jan 24", resorts: [] });
  assert.equal(w.watch, true);
  assert.equal(w.start, null);
  assert.equal(w.end, null);
  assert.equal(w.label, WATCH_LABEL);
  assert.deepEqual(tripWindow(w, DATES), { ta: 0, tb: 5, beyond: false });
});

test("a watchlist follows the horizon when the feed is shorter or longer", () => {
  const w = toWatchlist({ id: "t", resorts: [] });
  assert.deepEqual(tripWindow(w, DATES.slice(0, 3)), { ta: 0, tb: 2, beyond: false });
  assert.deepEqual(tripWindow(w, [...DATES, "2026-11-07"]), { ta: 0, tb: 6, beyond: false });
});

test("giving a watchlist dates makes it a dated trip again", () => {
  const t = withDates(toWatchlist({ id: "t", resorts: [] }), "2026-11-02", "2026-11-04", "Nov 2–Nov 4");
  assert.equal(t.watch, false);
  assert.deepEqual(tripWindow(t, DATES), { ta: 1, tb: 3, beyond: false });
});

test("dated trips keep their old windows", () => {
  assert.deepEqual(tripWindow({ start: "2027-01-21", end: "2027-01-24" }, DATES).beyond, true);
  assert.deepEqual(tripWindow({}, DATES), { ta: 0, tb: 3, beyond: false });
});
