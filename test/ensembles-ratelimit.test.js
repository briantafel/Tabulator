import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "../scripts/archive/ensembles.js";

/* 2026-11-11: a run hit Open-Meteo's rate limit, waited minutes per request
   and was cancelled at 60 min with nothing uploaded. The collector must stop
   at the first 429, fail loudly, and skip archiveOnly resorts. */
test("ensembles stop at the first 429 and skip archiveOnly resorts", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response("slow down", { status: 429 }); };
  try {
    const rows = [];
    const resorts = [
      { id: "a", latlon: [40, -111] }, { id: "b", latlon: [41, -111] },
      { id: "intl", latlon: [46, 7], archiveOnly: true },
    ];
    const logs = [];
    const res = await collect({ resorts, elevations: {}, sink: { write: (r) => rows.push(r) },
      rawDir: mkdtempSync(join(tmpdir(), "ens-")), fetchedAt: "2026-11-11T00:00:00Z", runId: "t", log: (s) => logs.push(s) });
    assert.equal(calls.length, 1, "one request, then stop");
    assert.equal(res.ok, false);
    assert.equal(res.rateLimited, true);
    assert.ok(res.failures.some((f) => f.startsWith("RATE LIMITED")));
    assert.ok(!calls.some((u) => u.includes("latitude=46")), "archiveOnly resort was requested");
    assert.ok(logs.some((l) => l.includes("skipping 1 archiveOnly")));
  } finally { globalThis.fetch = realFetch; }
});
