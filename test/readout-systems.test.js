/* The read-out explains the weather instead of restating the chart.
 * Brian, 2026-11-15: "can we add commentary about weather systems rather
 * than just restating what the chart already shows?" */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readoutFacts, templateReadout, validateReadout, factsForWriter, MAX_INCH_FIGURES } from "../src/lib/readout.js";
import { afdNow, afdAhead, scrubAmounts } from "../scripts/discussions.js";
import { fitForWriter, run, MAX_INPUT_CHARS } from "../scripts/write-readout.js";
import resortData from "../src/data/resorts.json" with { type: "json" };

const NOW = new Date("2026-11-15T22:30:00Z");
const DATES = ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
const feed = (snowIn) => resortData.resorts.map((r) => ({
  id: r.id, name: r.name,
  days: DATES.map((date, i) => ({ date, snow: ((snowIn[r.id] ?? [])[i] ?? 0) * 2.54 })),
}));
const WEEK = { kirkwood: [0, 4, 6, 15, 8, 0], "sugar-bowl": [0, 3, 5, 9, 4, 0], alta: [0, 2, 8, 3, 1, 0], snowbird: [0, 2, 7, 3, 1, 0] };
const WX = { kirkwood: { office: "REV", periods: [] }, "sugar-bowl": { office: "STO", periods: [] }, alta: { office: "SLC", periods: [] }, snowbird: { office: "SLC", periods: [] } };

// What an AFD looks like: dotted section headers, "&&" closers.
const AFD_REV = [
  ".SYNOPSIS...",
  "An atmospheric river aimed at the central Sierra brings heavy snow above 7000 ft Monday through Thursday. Snow levels fall to 5000 feet behind the cold front Thursday.",
  "&&",
  ".SHORT TERM /Tonight through Wednesday/...",
  "Totals of 2 to 4 feet along the crest, 12-18 inches at lake level and up to 6\" in Reno. Liquid 3.5 to 5.0 inches. Southwest gusts 60 to 80 mph over ridges. The GFS is 6 hours faster than the ECMWF.",
  "&&",
  ".LONG TERM /Thursday through Sunday/...",
  "Ridge builds Friday; another trough possible late next weekend.",
  "&&",
  ".AVIATION...",
  "IFR in snow.",
  "&&",
].join("\n");

const disc = (office, text) => ({
  source: `NWS ${office} Area Forecast Discussion`, office, issuedAt: NOW.toISOString(), url: "u",
  excerpt: scrubAmounts(afdAhead(text)), now: scrubAmounts(afdNow(text)),
});
const facts = (ahead = [disc("REV", AFD_REV)]) => readoutFacts({ resorts: feed(WEEK), weather: WX, now: NOW, ahead });

test("an AFD's synopsis and short term are kept, aviation and long range are not", () => {
  const now = afdNow(AFD_REV);
  assert.match(now, /atmospheric river/);
  assert.match(now, /GFS is 6 hours faster/);
  assert.doesNotMatch(now, /IFR|Ridge builds Friday/);
});

test("every amount is scrubbed; snow levels, wind and model timing stay", () => {
  const now = scrubAmounts(afdNow(AFD_REV));
  assert.doesNotMatch(now, /2 to 4 feet|12-18|6"|3\.5|5\.0 inches/);
  assert.match(now, /above 7000 ft/);
  assert.match(now, /5000 feet/);
  assert.match(now, /60 to 80 mph/);
  assert.match(now, /6 hours faster/);
});

test("a region gets the reasoning of the offices covering its resorts, and only those", () => {
  const f = facts([disc("REV", AFD_REV), disc("SLC", ".SYNOPSIS...\nNorthwest flow favors the Cottonwoods Tuesday.\n&&")]);
  const tahoe = f.regions.find((g) => g.key === "Tahoe");
  const wasatch = f.regions.find((g) => g.key === "the Wasatch");
  assert.equal(tahoe.pattern.length, 1, "STO has no discussion here, so only REV");
  assert.match(tahoe.pattern[0].text, /atmospheric river/);
  assert.match(wasatch.pattern[0].text, /Cottonwoods/);
  assert.doesNotMatch(JSON.stringify(wasatch), /atmospheric river/);
  // The long-range part still feeds "Looking ahead", without the reasoning.
  assert.equal(f.ahead.length, 1, "SLC has no long-range section here");
  assert.equal(f.ahead[0].now, undefined);
});

test("scrubbed amounts can't be smuggled back: the check rejects them", () => {
  const f = facts();
  const good = templateReadout(f);
  const t = (text) => ({ ...good, regions: good.regions.map((r, i) => (i ? r : { ...r, text })) });
  // The discussion said 12-18 inches; those numbers are not in the fact sheet any more.
  assert.match(validateReadout(t("An atmospheric river brings 12 to 18 inches to the lake."), f).join(), /number 12 is not|number 18 is not/);
  // Reasoning with the discussion's own non-amount numbers is fine.
  assert.deepEqual(validateReadout(t("An atmospheric river aims at the central Sierra Monday through Thursday, heavy above 7000 ft. Kirkwood's big day is Wednesday at 15\"."), f), []);
});

test(`at most ${MAX_INCH_FIGURES} inch figures per region — the chart has the rest`, () => {
  const f = facts();
  const good = templateReadout(f);
  const listy = { ...good, regions: good.regions.map((r, i) => (i ? r : { ...r, text: 'Kirkwood 33", Sugar Bowl 21", Alta 15".' })) };
  assert.match(validateReadout(listy, f).join(), /3 inch figures/);
  for (const r of good.regions) assert.ok((r.text.match(/\d+"/g) ?? []).length <= MAX_INCH_FIGURES, `template: ${r.text}`);
});

test("the overview needs a discussion, and carries no inch figures", () => {
  const f = facts();
  const good = templateReadout(f);
  assert.deepEqual(validateReadout({ ...good, overview: "An atmospheric river reaches the Sierra Monday and the Wasatch by Tuesday." }, f), []);
  assert.match(validateReadout({ ...good, overview: "Kirkwood gets 33\" this week." }, f).join(), /overview: no inch figures/);
  const bare = readoutFacts({ resorts: feed(WEEK), weather: WX, now: NOW });
  assert.match(validateReadout({ ...templateReadout(bare), overview: "A storm." }, bare).join(), /no forecaster discussion/);
});

test("the writer sees the reasoning but never the checker's list", () => {
  const f = facts();
  const text = JSON.stringify(factsForWriter(f));
  assert.match(text, /atmospheric river/);
  assert.doesNotMatch(text, /offLimits/);
});

test("an oversized sheet drops the look-ahead, then the reasoning, before giving up", () => {
  const big = (o) => ({ ...disc(o, AFD_REV), now: "x".repeat(MAX_INPUT_CHARS / 2), excerpt: "y".repeat(MAX_INPUT_CHARS / 2) });
  const f = readoutFacts({ resorts: feed(WEEK), weather: WX, now: NOW, ahead: [big("REV"), big("SLC")] });
  const fitted = fitForWriter(f);
  assert.ok(fitted, "fits after trimming");
  assert.ok(fitted.text.length <= MAX_INPUT_CHARS);
  assert.equal(fitted.facts.ahead.length, 0);
  assert.ok(f.regions.some((g) => g.pattern), "the original fact sheet is untouched");
});

test("the run writes the overview and credits the discussions it drew on", async () => {
  const root = (await mkdtemp(`${tmpdir()}/readout-sys-`)) + "/";
  await mkdir(`${root}public`);
  await writeFile(`${root}public/forecast.json`, JSON.stringify({ generatedAt: "2026-11-15T22:16:00Z", resorts: feed(WEEK) }));
  await writeFile(`${root}public/weather.json`, JSON.stringify({ generatedAt: "2026-11-15T22:20:00Z", resorts: WX }));
  const f = facts();
  const reply = {
    overview: "An atmospheric river reaches the central Sierra Monday and spreads inland by Tuesday.",
    regions: templateReadout(f).regions,
    ahead: null,
  };
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(reply) }] }), { status: 200 });
  };
  const { editorial } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl, gather: async () => [disc("REV", AFD_REV)], log: () => {} });
  assert.equal(editorial.writer, "claude");
  assert.equal(editorial.overview, reply.overview);
  assert.ok(editorial.sources.some((s) => s.name === "NWS REV Area Forecast Discussion"));
  assert.match(sent.messages[0].content, /atmospheric river/);
  assert.doesNotMatch(sent.messages[0].content, /12-18|2 to 4 feet/, "amounts never reach the writer");
});
