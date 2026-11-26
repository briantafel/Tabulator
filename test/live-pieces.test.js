import test from "node:test";
import assert from "node:assert/strict";
import { freshestFirst, runPool, liveShortfall, liveFetchEnd, cutToWindow, saturdayFixPieces } from "../scripts/archive/live-pieces.js";
import { fetchText } from "../scripts/archive/common.js";

const MODELS = ["ecmwf_ifs025", "gfs_seamless", "gem_seamless"];
const mk = (id, model, from) => ({ key: `om-live-${id}-${model}-${from}`, resort: { id }, model, winter: [from, "x"] });

test("freshestFirst: newest window first, then model order, then resort", () => {
  const ps = [];
  for (const m of [...MODELS]) for (const r of ["b", "a"]) for (const w of ["2026-11-15", "2026-11-22"]) ps.push(mk(r, m, w));
  const out = freshestFirst(ps, MODELS).map((p) => `${p.winter[0]} ${p.model} ${p.resort.id}`);
  assert.deepEqual(out.slice(0, 6), [
    "2026-11-22 ecmwf_ifs025 a", "2026-11-22 ecmwf_ifs025 b",
    "2026-11-22 gfs_seamless a", "2026-11-22 gfs_seamless b",
    "2026-11-22 gem_seamless a", "2026-11-22 gem_seamless b"]);
  assert.equal(out[6], "2026-11-15 ecmwf_ifs025 a");
  // a stop after any prefix leaves all three models for the newest window before any older re-fetch
  const firstOld = out.findIndex((s) => s.startsWith("2026-11-15"));
  assert.ok(out.slice(0, firstOld).some((s) => s.includes("gem_seamless")) && firstOld === 6);
  assert.equal(ps.length, 12); // input untouched
});

test("freshestFirst: an unknown model sorts after the known ones", () => {
  const out = freshestFirst([mk("a", "zzz", "2026-11-22"), mk("a", "gem_seamless", "2026-11-22")], MODELS);
  assert.deepEqual(out.map((p) => p.model), ["gem_seamless", "zzz"]);
});

test("runPool: never more than n at once, runs everything, a slow item does not block the others", async () => {
  let active = 0, peak = 0;
  const seen = [];
  const t0 = Date.now();
  await runPool([300, 10, 10, 10, 10, 10], 3, async (ms) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, ms));
    seen.push(ms); active--;
  });
  assert.equal(seen.length, 6);
  assert.equal(peak, 3);
  assert.ok(Date.now() - t0 < 450, "the five fast items must run while the slow one is still going");
  await runPool([], 4, async () => assert.fail("nothing to run"));
});

test("liveShortfall: whatever was queued and not fetched counts, whatever the reason", () => {
  assert.equal(liveShortfall(342, 342), 0);
  assert.equal(liveShortfall(342, 123), 219);   // the 11-23 07:51 run: time limit, 123 of 342
  assert.equal(liveShortfall(0, 0), 0);          // a manual run with a BACKFILL_ONLY filter queues no live pieces
  assert.equal(liveShortfall(5, 7), 0);
});

test("fetchText: timeoutMs cuts a stalled attempt short and the attempts still retry", async () => {
  const http = await import("node:http");
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits < 3) return;                         // never answers: the first two attempts stall
    res.end("ok");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const t0 = Date.now();
  const res = await fetchText(url, { retries: 3, delayMs: 10, timeoutMs: 150 });
  srv.closeAllConnections?.(); srv.close();
  assert.equal(res.text, "ok");
  assert.equal(hits, 3);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  // and when every attempt stalls it fails with the timeout named, not hangs
  const srv2 = http.createServer(() => {});
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  await assert.rejects(fetchText(`http://127.0.0.1:${srv2.address().port}/`, { retries: 1, delayMs: 5, timeoutMs: 80 }), /timeout|aborted/i);
  srv2.closeAllConnections?.(); srv2.close();
});

test("liveFetchEnd asks for the day after the piece, across a month end", () => {
  assert.equal(liveFetchEnd("2026-11-07"), "2026-11-08");
  assert.equal(liveFetchEnd("2026-11-30"), "2026-12-01");
});

test("cutToWindow keeps the piece's own days, drops the extra day", () => {
  const r = (t) => ({ valid_start: t });
  const rows = [r("2026-11-07T12:00:00.000Z"), r("2026-11-07T18:00:00.000Z"), r("2026-11-08T00:00:00.000Z"), r("2026-11-06T18:00:00.000Z")];
  assert.deepEqual(cutToWindow(rows, "2026-11-01", "2026-11-07").map((x) => x.valid_start),
    ["2026-11-07T12:00:00.000Z", "2026-11-07T18:00:00.000Z", "2026-11-06T18:00:00.000Z"]);
  // re-fetch piece: only the 18:00 block of the last day
  assert.deepEqual(cutToWindow(rows, "2026-11-07", "2026-11-07", 18).map((x) => x.valid_start), ["2026-11-07T18:00:00.000Z"]);
});

test("saturdayFixPieces: last day of each finished week that began before the fix", () => {
  const w = [["2026-11-01", "2026-11-07", true], ["2026-11-08", "2026-11-14", true], ["2026-11-15", "2026-11-21", true], ["2026-11-22", "2026-11-25", false]];
  assert.deepEqual(saturdayFixPieces(w), ["2026-11-07", "2026-11-14", "2026-11-21"]);
  assert.deepEqual(saturdayFixPieces([["2026-11-22", "2026-11-28", true]]), []); // fetched whole, nothing to repair
});
