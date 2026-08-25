import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reportsFor, reportDate, ageMs, REPORT_DAYS } from "../src/lib/reports.js";

const feed = (resorts, synthetic = false) => ({ synthetic, resorts });

test("a real feed keeps only the last five days", () => {
  const now = new Date("2026-04-26T00:00:00Z");
  const out = reportsFor(
    feed({ snowbird: [{ at: "2026-04-24" }, { at: "2026-04-14" }, { at: "2026-04-21" }] }),
    "snowbird",
    now,
  );
  assert.deepEqual(out.map((r) => r.at), ["2026-04-24", "2026-04-21"]);
});

test("the window is exactly REPORT_DAYS wide", () => {
  const now = new Date("2026-04-26T12:00:00Z");
  const edge = new Date(now.getTime() - REPORT_DAYS * 864e5).toISOString().slice(0, 10);
  assert.equal(reportsFor(feed({ a: [{ at: edge }] }), "a", now).length, 1);
});

test("sample data is exempt — an empty section would read as a broken feature", () => {
  const now = new Date("2026-08-25T00:00:00Z");
  const long = feed({ snowbird: [{ at: "2026-04-24" }] }, true);
  assert.equal(reportsFor(long, "snowbird", now).length, 1);
  assert.equal(reportsFor({ ...long, synthetic: false }, "snowbird", now).length, 0);
});

test("newest first, and unknown resorts are empty not undefined", () => {
  const f = feed({ snowbird: [{ at: "2026-04-14" }, { at: "2026-04-24" }] }, true);
  assert.deepEqual(reportsFor(f, "snowbird").map((r) => r.at), ["2026-04-24", "2026-04-14"]);
  assert.deepEqual(reportsFor(f, "alta"), []);
  assert.deepEqual(reportsFor(undefined, "alta"), []);
});

test("dates read the way the card shows them", () => {
  assert.equal(reportDate("2026-04-24"), "Apr 24");
  assert.equal(reportDate("nonsense"), "");
});

test("relative ages parse; anything else is null, never a guess", () => {
  assert.equal(ageMs("2 days ago"), 2 * 864e5);
  assert.equal(ageMs("an hour ago"), 36e5);
  assert.equal(ageMs("4 weeks ago"), 4 * 6048e5);
  assert.equal(ageMs("1 month ago"), 2592e6);
  for (const junk of ["", "yesterday", "soon", "4 fortnights ago", undefined, null]) {
    assert.equal(ageMs(junk), null, `"${junk}" should not parse`);
  }
});

test("a report with only a relative age still lands in the window", () => {
  // OnTheSnow prints "2 days ago", not a date — the window has to work on it.
  const now = new Date("2026-08-25T00:00:00Z");
  const feed = { resorts: { x: [
    { id: "a", age: "2 days ago" },
    { id: "b", age: "4 months ago" },
    { id: "c", at: "2026-08-24" },
    { id: "d" },                       // no date and no age: no place in time
  ] } };
  assert.deepEqual(reportsFor(feed, "x", now).map((r) => r.id), ["c", "a"]);
});

test("the date falls back to the age rather than inventing a day", () => {
  assert.equal(reportDate("2026-04-24"), "Apr 24");
  assert.equal(reportDate(undefined, "4 months ago"), "4 months ago");
  assert.equal(reportDate(undefined, undefined), "");
});

test("real data is only unfiltered when it says why", () => {
  const now = new Date("2026-08-25T00:00:00Z");
  const old = { resorts: { x: [{ id: "a", at: "2026-04-24" }] } };
  assert.equal(reportsFor(old, "x", now).length, 0, "an April report is not in a five-day window");
  assert.equal(reportsFor({ ...old, demo: true }, "x", now).length, 1, "demo must bypass the window");
  assert.equal(reportsFor({ ...old, synthetic: true }, "x", now).length, 1, "synthetic must too");
});

test("the shipped fixture is well formed and declares what it is", async () => {
  const j = JSON.parse(await readFile(new URL("../public/reports.json", import.meta.url), "utf8"));
  // Either it is invented (synthetic) or it is real but out of season (demo).
  // Silence would mean a section that empties itself without explanation.
  assert.ok(j.synthetic || j.demo,
    "the fixture must say why its reports survive the five-day window");
  assert.ok(j.note, "and it must say in words where the data came from");
  const ids = Object.keys(j.resorts);
  assert.ok(ids.length >= 20, `only ${ids.length} resorts have reports`);
  for (const id of ids) {
    assert.match(j.sourceUrls?.[id] ?? "", /^https:\/\/www\.onthesnow\.com\/.+\/ski-report-reviews$/,
      `${id} has no source URL — scraped text must say where it came from`);
  }
  const all = Object.values(j.resorts).flat();
  assert.ok(all.length > 0);
  for (const r of all) {
    assert.ok(r.text, "every report needs its text");
    // author and photo are optional: OnTheSnow does not expose either to the
    // scrape. A position in time is NOT optional — without one a report cannot
    // be windowed, and a five-day section that silently shows April is a lie.
    assert.ok(r.at || ageMs(r.age) != null, `report ${r.id} has no date and no parseable age`);
    if (r.photo) {
      // Inlined (from Brian's export) or an OnTheSnow CDN URL — both are real
      // shapes. What is NOT allowed is a relative or unknown-host src.
      assert.match(r.photo.src, /^(data:image\/|https:\/\/s3\.onthesnow\.com\/)/,
        `report ${r.id} has an unexpected photo src`);
      if (r.photo.w != null) assert.ok(r.photo.w > 0 && r.photo.h > 0, "bad photo size");
    }
  }
});
