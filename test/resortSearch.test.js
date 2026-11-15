import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchResorts, fold } from "../src/lib/resortSearch.js";

const RESORTS = JSON.parse(readFileSync(new URL("../src/data/resorts.json", import.meta.url)));
const LIST = Array.isArray(RESORTS) ? RESORTS : RESORTS.resorts;
const META = JSON.parse(readFileSync(new URL("../src/data/resort-meta.json", import.meta.url)));
const ids = (q) => searchResorts(LIST, q).map((r) => r.id);

test("every resort has search metadata, and every entry is a resort", () => {
  assert.deepEqual(Object.keys(META).sort(), LIST.map((r) => r.id).sort());
  for (const [id, m] of Object.entries(META))
    for (const k of ["country", "area", "state", "range", "subrange", "aliases"]) assert.ok(Array.isArray(m[k]), `${id}.${k}`);
});

test("name contains still works first (Brian's Ja rule)", () => {
  assert.deepEqual(ids("Ja").slice(0, 2), ["jackson-hole", "jay-peak"]);
});

test("place searches", () => {
  assert.ok(ids("Colorado").includes("telluride"));
  assert.ok(ids("san juans").includes("telluride") && ids("san juans").includes("wolf-creek"));
  assert.ok(ids("CO").includes("vail"));
  assert.ok(!ids("co").includes("snowbird"), "2-letter codes match whole words only");
  assert.ok(ids("US").includes("alta") && !ids("US").includes("whistler"));
  assert.ok(ids("kootenays").includes("fernie"));
  assert.ok(ids("Wasatch").includes("alta") && !ids("Rockies").includes("alta"));
  assert.ok(ids("JHMR").includes("jackson-hole"));
  assert.ok(ids("val disere").includes("val-disere-tignes"));
  assert.ok(ids("little cottonwood").includes("snowbird"));
  assert.deepEqual(ids(""), []);
});

test("fold strips accents and punctuation", () => {
  assert.equal(fold("Val d'Isère–Tignes"), "val disere tignes");
});
