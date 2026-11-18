/* The Snowfall switch rewrites the read-out (Brian, 2026-11-18): a second
 * read-out, editorial-ours.json, written from our blend's numbers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { run, blendStamp } from "../scripts/write-readout.js";
import { oursReadoutMatches, readoutMatches } from "../src/lib/readout.js";

const NOW = new Date("2026-11-18T17:00:00Z");
const DATES = ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"];
const sf = { alta: [0, 2, 3, 1, 0, 0], kirkwood: [0, 1, 1, 0, 0, 0] };   // inches, Snow-Forecast
const ours = { alta: [0, 8, 12, 5, 0, 0], kirkwood: [0, 1, 1, 0, 0, 0] }; // inches, blend
const cm = (x) => x * 2.54;

async function setup({ blendAt = "2026-11-18T07:30:00Z" } = {}) {
  const root = (await mkdtemp(`${tmpdir()}/readout-ours-`)) + "/";
  await mkdir(`${root}public`);
  const resorts = Object.entries(sf).map(([id, s]) => ({ id, name: id === "alta" ? "Alta" : "Kirkwood", days: DATES.map((date, i) => ({ date, snow: cm(s[i]) })) }));
  await writeFile(`${root}public/forecast.json`, JSON.stringify({ generatedAt: "2026-11-18T15:07:00Z", resorts }));
  await writeFile(`${root}public/weather.json`, JSON.stringify({ resorts: {} }));
  const blend = { generatedAt: blendAt, resorts: Object.fromEntries(Object.entries(ours).map(([id, s]) => [id, { days: DATES.map((date, i) => ({ date, snow: cm(s[i]) })) }])) };
  await writeFile(`${root}public/blend-forecast.json`, JSON.stringify(blend));
  return { root, blend };
}

test("the Tabulator read-out is written from the blend's numbers and stamped with it", async () => {
  const { root, blend } = await setup();
  const { editorial } = await run({ root, env: {}, now: NOW, gather: async () => [], log: () => {}, variant: "ours" });
  const saved = JSON.parse(await readFile(`${root}public/editorial-ours.json`, "utf8"));
  assert.deepEqual(saved, editorial);
  assert.equal(editorial.snowfall, "tabulator");
  assert.equal(editorial.blendGeneratedAt, blendStamp(blend));
  assert.equal(editorial.sources[0].name, "Tabulator model (totals)");
  const text = editorial.regions.map((r) => r.text).join(" ");
  assert.match(text, /Alta is forecast for about 25"/, "our 25\", not Snow-Forecast's 6\"");
  assert.ok(readoutMatches(editorial, "2026-11-18T15:07:00Z"));
  assert.ok(oursReadoutMatches(editorial, blend));
  assert.ok(!oursReadoutMatches(editorial, { ...blend, generatedAt: "2026-11-19T07:30:00Z" }), "a newer blend hides it");
});

test("the Snow-Forecast read-out is untouched by the Tabulator one", async () => {
  const { root } = await setup();
  await run({ root, env: {}, now: NOW, gather: async () => [], log: () => {}, variant: "ours" });
  const { editorial } = await run({ root, env: {}, now: NOW, gather: async () => [], log: () => {} });
  assert.match(editorial.regions.map((r) => r.text).join(" "), /Alta is forecast for about 6"/);
  assert.equal(editorial.snowfall, undefined);
  assert.ok(!oursReadoutMatches(editorial, { generatedAt: "2026-11-18T07:30:00Z" }));
});

test("no fresh blend: nothing written", async () => {
  const { root } = await setup({ blendAt: "2026-11-16T07:30:00Z" });
  const { editorial } = await run({ root, env: {}, now: NOW, gather: async () => [], log: () => {}, variant: "ours" });
  assert.equal(editorial, null);
  await assert.rejects(readFile(`${root}public/editorial-ours.json`, "utf8"));
});
