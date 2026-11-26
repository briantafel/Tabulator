import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { readoutFacts, templateReadout, validateReadout, readoutMatches, accumulation, CUTOFF_IN, carryForward, regionBasis } from "../src/lib/readout.js";
import { outlook } from "../src/lib/outlook.js";
import { issuedAt, isFresh, afdAhead, cpcAhead } from "../scripts/discussions.js";
import { parseReply } from "../scripts/readout-api.js";
import { run, DAILY_CAP, MAX_ATTEMPTS, MAX_INPUT_CHARS, callsAllowedBy } from "../scripts/write-readout.js";
import resortData from "../src/data/resorts.json" with { type: "json" };

const NOW = new Date("2026-10-30T22:30:00Z");
const DATES = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
const IN = 2.54;
const feed = (snowIn) => resortData.resorts.map((r) => ({
  id: r.id, name: r.name,
  days: DATES.map((date, i) => ({ date, snow: ((snowIn[r.id] ?? [])[i] ?? 0) * IN })),
}));

// A week shaped like 2026-10-30's real one.
const WEEK = {
  telluride: [2, 0, 10, 4, 0, 0], "crested-butte": [0, 0, 5, 2, 0, 0],
  alta: [1, 0, 6, 1, 0, 0], snowbird: [1, 0, 6, 1, 0, 0],
  mammoth: [1, 7, 1, 0, 0, 0], kirkwood: [1, 4, 1, 0, 0, 0],
  stowe: [0, 0, 1, 0, 0, 0],
};
const WX = {
  alta: { office: "SLC", periods: [
    { name: "Sunday", shortForecast: "Heavy Snow", detailedForecast: "Snow. Snow level 6000 feet. New snow accumulation of 4 to 8 inches possible.", temperature: 36, startTime: "2026-11-01T06:00:00-06:00" },
    { name: "Sunday Night", shortForecast: "Heavy Snow", temperature: 28, startTime: "2026-11-01T18:00:00-06:00" },
  ] },
  telluride: { office: "GJT", periods: [
    { name: "Sunday", shortForecast: "Rain And Snow Showers", temperature: 41, startTime: "2026-11-01T06:00:00-07:00" },
  ], alerts: [{ event: "Winter Storm Watch", onset: "2026-11-01T06:00:00-07:00", ends: "2026-11-02T18:00:00-07:00" }] },
  mammoth: { office: "REV", periods: [
    { name: "Tonight", shortForecast: "Chance Light Snow", detailedForecast: "A chance of snow. New snow accumulation of 1 to 2 inches possible.", temperature: 27, startTime: "2026-10-30T18:00:00-07:00" },
    { name: "Saturday", shortForecast: "Heavy Snow", detailedForecast: "Snow. Wind chill values as low as 14. New snow accumulation of 4 to 8 inches possible.", temperature: 30, startTime: "2026-10-31T06:00:00-07:00" },
    { name: "Saturday Night", shortForecast: "Heavy Snow", detailedForecast: "Snow. New snow accumulation of 8 to 12 inches possible.", temperature: 24, startTime: "2026-10-31T18:00:00-07:00" },
  ] },
};
const facts0 = () => readoutFacts({ resorts: feed(WEEK), weather: WX, generatedAt: "2026-10-30T22:16:00Z", now: NOW });

// --- the fact sheet -----------------------------------------------------

test("regions lead with the paragraph's best bet and skip the minimal ones", () => {
  const facts = facts0();
  const keys = facts.regions.map((g) => g.key);
  assert.equal(keys[0], "the central Rockies");
  assert.match(outlook(feed(WEEK), { now: NOW }).map((s) => s.t).join(""), /best bet for snow is the central Rockies/);
  assert.ok(keys.includes("the Wasatch") && keys.includes("the Eastern Sierra"));
  assert.ok(!keys.includes("the Northeast"), "1\" at Stowe is minimal");
  assert.ok(!keys.includes("Tahoe"), `Kirkwood at 6" sits on the ${CUTOFF_IN}" line, not over it`);
});

test("the best bet is always included, even under the cutoff", () => {
  const facts = readoutFacts({ resorts: feed({ stowe: [0, 2, 1, 0, 0, 0] }), now: NOW });
  assert.deepEqual(facts.regions.map((g) => g.key), ["the Northeast"]);
});

test("a quiet week has no regions", () => {
  const facts = readoutFacts({ resorts: feed({}), now: NOW });
  assert.equal(facts.quiet, true);
  assert.deepEqual(templateReadout(facts), { regions: [], overview: null, ahead: null });
});

test("totals are our inches and the NWS lines come from weather.json", () => {
  const t = facts0().regions[0].resorts[0];
  assert.equal(t.name, "Telluride");
  assert.equal(t.totalIn, 16);
  assert.deepEqual(t.peak, { dow: "Sunday", in: 10 });
  assert.equal(t.nws[0].short, "Rain And Snow Showers");
  assert.deepEqual(t.alerts, [{ event: "Winter Storm Watch", from: "Sunday", to: "Monday night" }]);
});

// --- the template -------------------------------------------------------

test("the template passes its own check and quotes the NWS", () => {
  const facts = facts0();
  const t = templateReadout(facts);
  assert.deepEqual(validateReadout(t, facts), []);
  const by = Object.fromEntries(t.regions.map((r) => [r.key, r.text]));
  assert.match(by["the central Rockies"], /^Telluride is forecast for about 16", 10" of it Sunday\./);
  assert.match(by["the central Rockies"], /rain mixed in at Telluride Sunday/);
  assert.match(by["the central Rockies"], /Winter Storm Watch at Telluride from Sunday to Monday night/);
  assert.match(by["the Eastern Sierra"], /The NWS is calling for more at Mammoth: 13 to 22 inches Friday night through Saturday night\./);
  assert.match(by["the Wasatch"], /heavy snow at Alta Sunday and Sunday night/);
  assert.equal(t.ahead, null);
});

test("NWS amounts reach the writer only through nwsHigher", () => {
  const m = facts0().regions.find((g) => g.key === "the Eastern Sierra").resorts[0];
  assert.equal(m.totalIn, 9);
  assert.deepEqual(m.nwsHigher, { by: "NWS", fromIn: 13, toIn: 22, over: "Friday night through Saturday night" });
  assert.equal(m.nws[0].name, "Friday Night", "'Tonight' goes stale; the read-out is read the next day");
  for (const p of m.nws) assert.doesNotMatch(p.detail ?? "", /inch|accumulation/i);
  // Alta's NWS 4-8" Sunday is not clearly above our 8": no line.
  const alta = facts0().regions.find((g) => g.key === "the Wasatch").resorts.find((r) => r.name === "Alta");
  assert.equal(alta?.nwsHigher, undefined);
});

test("NWS accumulation wording parses", () => {
  assert.deepEqual(accumulation("New snow accumulation of 8 to 12 inches possible."), [8, 12]);
  assert.deepEqual(accumulation("New snow accumulation of around 2 inches possible."), [2, 2]);
  assert.deepEqual(accumulation("New snow accumulation of less than one inch possible."), [0, 1]);
  assert.deepEqual(accumulation("New snow accumulation of less than half an inch possible."), [0, 0.5]);
  assert.equal(accumulation("Mostly sunny."), null);
});

// --- the check ----------------------------------------------------------

test("the check rejects an invented number, a stray place and the wrong order", () => {
  const facts = facts0();
  const good = templateReadout(facts);
  const bump = (fn) => ({ ...good, regions: good.regions.map((r, i) => (i ? r : { ...r, text: fn(r.text) })) });
  assert.match(validateReadout(bump((t) => `${t} Up to 57" up high.`), facts).join(), /number 57/);
  assert.match(validateReadout(bump((t) => `${t} Stowe stays dry.`), facts).join(), /names Stowe/);
  assert.match(validateReadout(bump((t) => t.repeat(8)), facts).join(), /chars, limit/);
  assert.match(validateReadout({ ...good, regions: [...good.regions].reverse() }, facts).join(), /in that order/);
  assert.match(validateReadout({ ...good, ahead: "More next week." }, facts).join(), /no fresh discussion/);
  // Numbers the NWS gave are fair game, commas and all.
  assert.deepEqual(validateReadout(bump((t) => `${t} Snow levels drop to 6,000 feet.`), facts), []);
  // The first live read-out opened its look-ahead by explaining its inputs.
  assert.match(validateReadout(bump((t) => `${t} The fact sheet has nothing more.`), facts).join(), /talks about its own inputs/);
});

test("the look-ahead must name a date after the window", () => {
  const facts = readoutFacts({ resorts: feed(WEEK), weather: WX, now: NOW,
    ahead: [{ source: "WPC", issuedAt: NOW.toISOString(), url: "u", excerpt: "Pacific trough reaches the West Coast Nov 6 to 7." }] });
  assert.equal(facts.window.toLabel, "Wednesday Nov 4");
  assert.equal(facts.afterWindow[0].label, "Thursday Nov 5");
  const base = templateReadout(facts);
  const ahead = (text) => validateReadout({ ...base, ahead: text }, facts);
  assert.deepEqual(ahead("The Weather Prediction Center sees a Pacific trough reaching the West Coast around Friday Nov 6."), []);
  assert.match(ahead("Snow likely early next week, says the Weather Prediction Center.").join(), /inside the radar's window/);
  assert.match(ahead("The Weather Prediction Center sees more snow later on.").join(), /names no date/);
  assert.match(ahead("The Weather Prediction Center sees snow on Nov 3.").join(), /inside the radar's window/);
  assert.match(ahead("The Climate Prediction Center is not in the discussions provided.").join(), /own inputs/);
});

test("a stale read-out is never shown", () => {
  const ed = { forecastGeneratedAt: "A", regions: [{ key: "x", text: "y" }] };
  assert.equal(readoutMatches(ed, "A"), true);
  assert.equal(readoutMatches(ed, "B"), false);
  assert.equal(readoutMatches({ ...ed, quiet: true }, "A"), false);
  assert.equal(readoutMatches(null, "A"), false);
});

// --- discussions --------------------------------------------------------

test("NWS issuance lines parse to UTC", () => {
  assert.equal(issuedAt("x\n1055 PM MDT Wed Oct 28 2026\n"), "2026-10-29T04:55:00.000Z");
  assert.equal(issuedAt("300 PM EST Thu January 08 2026"), "2026-01-08T20:00:00.000Z");
  assert.equal(issuedAt("1200 PM EDT Fri Oct 30 2026"), "2026-10-30T16:00:00.000Z");
  assert.equal(issuedAt("1200 AM EDT Fri Oct 30 2026"), "2026-10-30T04:00:00.000Z");
  // CPC's page, verbatim from the 2026-10-30 run that skipped it.
  assert.equal(issuedAt("Prognostic Discussion for 6 to 10 and 8 to 14 Day Outlooks \nNWS Climate Prediction Center College Park MD \n3:00 PM EDT Fri October 30 2026 \n \n6-10 Day Outlook f"),
    "2026-10-30T19:00:00.000Z");
  assert.equal(issuedAt("no header here"), null);
  assert.equal(isFresh("2026-10-30T16:00:00Z", NOW), true);
  assert.equal(isFresh("2026-10-28T16:00:00Z", NOW), false);
  assert.equal(isFresh(null, NOW), false);
});

test("an AFD keeps its forward-looking sections only", () => {
  const afd = [".KEY MESSAGES...", "- Heavy snow Sunday night.", "&&", ".SHORT TERM...", "Showers today.", "&&",
    ".LONG TERM /Tuesday through Friday/...", "Another trough late week.", "&&", ".AVIATION...", "VFR.", "&&"].join("\n");
  const out = afdAhead(afd);
  assert.match(out, /Heavy snow Sunday night/);
  assert.match(out, /Another trough late week/);
  assert.doesNotMatch(out, /Showers today|VFR/);
});

test("CPC's page yields its issuance and stops at the forecaster line", () => {
  const html = "<html><pre>Prognostic Discussion\n300 PM EDT Fri Oct 30 2026\n\n6-10 DAY OUTLOOK. Trough west.\nFORECASTER: Someone\nNOTES</pre></html>";
  const c = cpcAhead(html);
  assert.equal(c.issuedAt, "2026-10-30T19:00:00.000Z");
  assert.match(c.excerpt, /Trough west/);
  assert.doesNotMatch(c.excerpt, /Someone/);
});

test("CPC's date line stands in when the issuance line cannot be read", () => {
  const c = cpcAhead("<html><body><div>Issued: Oct 30, 2026</div><p>Prognostic Discussion for 6 to 10 and 8 to 14 day outlooks. Trough west.</p></body></html>");
  assert.equal(c.issuedAt, "2026-10-30T20:00:00.000Z");
  assert.match(c.excerpt, /^Prognostic Discussion/);
});

test("all thinking and no text is an error, not an empty read-out", async () => {
  const root = await sandbox();
  const fetchImpl = async () => new Response(JSON.stringify({ content: [], stop_reason: "max_tokens", usage: { output_tokens_details: { thinking_tokens: 2000 } } }), { status: 200 });
  const { editorial, debug } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.writer, "template");
  assert.match(debug.attempts[0].error, /without writing anything/);
});

test("a fenced JSON reply still parses", () => {
  assert.deepEqual(parseReply('```json\n{"regions":[],"ahead":null}\n```'), { regions: [], ahead: null });
  assert.throws(() => parseReply("Sorry, I can't."));
});

// --- the run, and its cost guards ---------------------------------------

async function sandbox({ prev } = {}) {
  const root = (await mkdtemp(`${tmpdir()}/readout-`)) + "/";
  await mkdir(`${root}public`);
  await writeFile(`${root}public/forecast.json`, JSON.stringify({ generatedAt: "2026-10-30T22:16:00Z", resorts: feed(WEEK) }));
  await writeFile(`${root}public/weather.json`, JSON.stringify({ generatedAt: "2026-10-30T22:20:00Z", resorts: WX }));
  if (prev) await writeFile(`${root}public/editorial.json`, JSON.stringify(prev));
  return root;
}
const noAhead = async () => [];
const quiet = () => {};

/** A fake API: answers with whatever `reply(n)` returns for call n. */
function fakeApi(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const r = await reply(calls.length, body);
    if (r.status) return new Response(JSON.stringify({ error: { message: r.message ?? "nope" } }), { status: r.status });
    return new Response(JSON.stringify({ content: [{ type: "text", text: r.text }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  return { calls, fetchImpl };
}
const goodText = () => JSON.stringify(templateReadout(facts0()));

test("no key: the template, and no request at all", async () => {
  const root = await sandbox();
  const api = fakeApi(() => assert.fail("must not call the API"));
  const { editorial } = await run({ root, env: {}, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.writer, "template");
  assert.equal(api.calls.length, 0);
  assert.equal(editorial.forecastGeneratedAt, "2026-10-30T22:16:00Z");
  const disk = JSON.parse(await readFile(`${root}public/editorial.json`, "utf8"));
  assert.equal(disk.regions[0].title, "Central Rockies");
});

test("with a key: one call, capped, and its text ships", async () => {
  const root = await sandbox();
  const api = fakeApi(() => ({ text: goodText() }));
  const { editorial } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.writer, "claude");
  assert.equal(editorial.model, "claude-haiku-5-5");
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].body.max_tokens, 2000);
  assert.deepEqual(api.calls[0].body.thinking, { type: "disabled" }, "thinking ate the whole budget on the first live run");
  assert.equal(api.calls[0].body.tools, undefined, "no tools, so no agent loop");
  assert.equal(api.calls[0].headers["x-api-key"], "k");
  assert.doesNotMatch(api.calls[0].body.messages[0].content, /offLimits/, "the model never sees the checker's list");
  assert.deepEqual(editorial.api, { day: "2026-10-30", calls: 1 });
  assert.doesNotMatch(await readFile(`${root}readout-debug/attempts.json`, "utf8"), /"k"/, "the key is never written down");
});

test(`bad text: exactly ${MAX_ATTEMPTS} calls, then the template`, async () => {
  const root = await sandbox();
  const api = fakeApi(() => ({ text: '{"regions":[{"key":"the central Rockies","text":"About 40\\" at Telluride."}],"ahead":null}' }));
  const { editorial, status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, MAX_ATTEMPTS);
  assert.match(api.calls[1].body.messages[0].content, /previous reply was rejected/);
  assert.equal(editorial.writer, "template");
  assert.match(status.warnings.join(), /did not pass the check/);
  assert.equal(status.fatal, null);
});

test("a rejected key stops after one call and turns the run red", async () => {
  const root = await sandbox();
  const api = fakeApi(() => ({ status: 401, message: "invalid x-api-key" }));
  const { editorial, status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 1);
  assert.equal(editorial.writer, "template");
  assert.match(status.fatal, /expired or been deleted/);
});

test("a used-up spend limit stops after one call", async () => {
  const root = await sandbox();
  const api = fakeApi(() => ({ status: 400, message: "You have reached your specified API usage limits." }));
  const { status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 1);
  assert.match(status.fatal, /spend limit/);
});

test(`the daily cap holds across runs: ${DAILY_CAP} calls, then none`, async () => {
  const root = await sandbox({ prev: { api: { day: "2026-10-30", calls: DAILY_CAP } } });
  const api = fakeApi(() => assert.fail("over the daily cap"));
  const { editorial, status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 0);
  assert.equal(editorial.writer, "template");
  assert.match(status.warnings.join(), /daily cap/);

  // Pressing Run workflow over and over: the counter carries in the file.
  const root2 = await sandbox();
  const api2 = fakeApi(() => ({ text: "not json" }));
  for (let i = 0; i < 10; i++) {
    await run({ root: root2, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api2.fetchImpl, gather: noAhead, log: quiet });
  }
  assert.equal(api2.calls.length, DAILY_CAP);

  // A new UTC day starts the count again.
  await run({ root: root2, env: { ANTHROPIC_API_KEY: "k" }, now: new Date("2026-10-31T06:20:00Z"), fetchImpl: api2.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api2.calls.length, DAILY_CAP + MAX_ATTEMPTS);
});

test("the Sonnet comparison is one extra call, saved but never shown", async () => {
  const root = await sandbox();
  const api = fakeApi(() => ({ text: goodText() }));
  const { editorial, debug } = await run({ root, env: { ANTHROPIC_API_KEY: "k", READOUT_COMPARE_UNTIL: "2026-11-08" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].body.model, "claude-sonnet-5-5");
  assert.deepEqual(api.calls[1].body.thinking, { type: "between_tools" }, "Sonnet 5.5 has no 'disabled'");
  assert.equal(editorial.model, "claude-haiku-5-5");
  assert.deepEqual(debug.compare.problems, []);
  // And it stops on its date.
  const api2 = fakeApi(() => ({ text: goodText() }));
  await run({ root: await sandbox(), env: { ANTHROPIC_API_KEY: "k", READOUT_COMPARE_UNTIL: "2026-10-29" }, now: NOW, fetchImpl: api2.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api2.calls.length, 1);
});

test("an oversized fact sheet drops the look-ahead first, then skips the API", async () => {
  const huge = [{ source: "X", issuedAt: NOW.toISOString(), url: "u", excerpt: "y".repeat(MAX_INPUT_CHARS) }];
  const api = fakeApi(() => ({ text: goodText() }));
  const { editorial } = await run({ root: await sandbox(), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: async () => huge, log: quiet });
  assert.equal(api.calls.length, 1);
  assert.doesNotMatch(api.calls[0].body.messages[0].content, /yyyy/);
  assert.equal(editorial.writer, "claude");
});

// --- the workflow -------------------------------------------------------

test("the workflow runs the read-out after the weather, with its key and a timeout, and commits it", () => {
  const raw = readFileSync(new URL("../.github/workflows/forecast.yml", import.meta.url), "utf8");
  const steps = parse(raw).jobs.fetch.steps;
  const at = (n) => steps.findIndex((s) => s.name === n);
  const ro = steps[at("Write the radar read-out")];
  assert.ok(ro, "read-out step missing");
  assert.ok(at("Fetch NWS weather") < at("Write the radar read-out") && at("Write the radar read-out") < at("Commit if changed"));
  assert.equal(ro["continue-on-error"], true, "a read-out failure must not cost the forecast its commit");
  assert.ok(ro["timeout-minutes"] <= 10);
  assert.equal(ro.env.ANTHROPIC_API_KEY, "${{ secrets.ANTHROPIC_API_KEY }}");
  assert.match(steps[at("Commit if changed")].run, /public\/editorial\.json/);
});

test("drafts that fail only on the look-ahead ship without it, not as the template", async () => {
  const root = await sandbox();
  // No discussions were gathered, so any "ahead" fails ("no fresh discussion").
  const draft = { ...JSON.parse(goodText()), ahead: "A storm arrives early next week." };
  const api = fakeApi(() => ({ text: JSON.stringify(draft) }));
  const { editorial, status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, MAX_ATTEMPTS, "it still retries for a clean draft first");
  assert.equal(editorial.writer, "claude");
  assert.equal(editorial.ahead, null);
  assert.match(status.warnings.join(), /shipped without it/);
});

test("a draft with a region problem still falls back to the template", async () => {
  const root = await sandbox();
  const bad = JSON.parse(goodText());
  bad.regions[0].text += ' Somewhere gets 999".';
  const api = fakeApi(() => ({ text: JSON.stringify(bad) }));
  const { editorial } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.writer, "template");
});

// --- carrying the last Claude read-out forward -------------------------

/** An earlier Claude read-out of the same facts, with prose of its own. */
function earlierClaude({ at = "2026-10-30T07:00:00Z", extra = " A trough digs in from the west." } = {}) {
  const t = templateReadout(facts0());
  const basis = new Map(facts0().regions.map((g) => [g.key, regionBasis(g)]));
  return {
    generatedAt: at, writer: "claude", model: "claude-haiku-5-5",
    overview: "A trough from the Pacific drives the week.",
    regions: t.regions.map((r) => ({ key: r.key, title: r.key, text: r.text + extra, basis: basis.get(r.key) })),
    ahead: null, api: { day: "2026-10-30", calls: DAILY_CAP },
  };
}

test("cap reached: the earlier Claude read-out is kept, not swapped for the template", async () => {
  const prev = earlierClaude();
  const api = fakeApi(() => assert.fail("over the daily cap"));
  const { editorial, status } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 0);
  assert.equal(editorial.writer, "claude");
  assert.equal(editorial.overview, null, "no forecaster discussion today, so the old overview fails the same check a new one would");
  assert.deepEqual(editorial.regions.map((r) => r.text), prev.regions.map((r) => r.text));
  assert.equal(editorial.writtenAt, "2026-10-30T07:00:00.000Z", "age runs from when it was written, not when it was carried");
  assert.match(status.warnings.join(), /kept \d+ of \d+ regions/);
});

test("a carried region whose number no longer holds gets the template sentence", async () => {
  const prev = earlierClaude();
  prev.regions[0].text = "Something like 987\" is coming.";
  const { editorial } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: fakeApi(() => assert.fail()).fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.regions[0].text, templateReadout(facts0()).regions[0].text);
  if (prev.regions.length > 1) assert.equal(editorial.regions[1].text, prev.regions[1].text);
});

test("a region whose numbers moved is not carried, even if its numbers happen to appear elsewhere", async () => {
  // 2026-11-21 replay: "Mt. Baker's total at 15\"" passed the validator
  // with Mt. Baker at 47\", because 15 was someone else's number.
  const prev = earlierClaude();
  prev.regions[0].basis = "stale";
  const { editorial } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: fakeApi(() => assert.fail()).fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.regions[0].text, templateReadout(facts0()).regions[0].text);
  assert.equal(editorial.regions[0].basis, undefined, "a template sentence gets no basis, so it is never carried as Claude's");
});

test("old read-outs without a basis are never carried", () => {
  const prev = earlierClaude();
  for (const r of prev.regions) delete r.basis;
  assert.equal(carryForward(prev, facts0(), NOW), null);
});

test("nothing moved since a recent read-out: reused with no API call", async () => {
  const prev = { ...earlierClaude({ at: "2026-10-30T20:00:00Z" }), overview: null, api: { day: "2026-10-30", calls: 0 } };
  const api = fakeApi(() => assert.fail("nothing changed — no call"));
  const { editorial } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 0);
  assert.equal(editorial.writer, "claude");
  assert.deepEqual(editorial.api, { day: "2026-10-30", calls: 0 });
});

test("nothing older than a day is carried", async () => {
  const prev = earlierClaude({ at: "2026-10-29T12:00:00Z" });
  const { editorial } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: fakeApi(() => assert.fail()).fetchImpl, gather: noAhead, log: quiet });
  assert.equal(editorial.writer, "template");
});

test("past the reuse window, a fresh draft still wins over a carried one", async () => {
  const prev = { ...earlierClaude(), api: { day: "2026-10-30", calls: 0 } };
  const api = fakeApi(() => ({ text: goodText() }));
  const { editorial } = await run({ root: await sandbox({ prev }), env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 1);
  assert.deepEqual(editorial.regions.map((r) => r.text), templateReadout(facts0()).regions.map((r) => r.text));
  assert.equal(editorial.writtenAt, NOW.toISOString());
  assert.equal(carryForward(null, facts0(), NOW), null);
});

// --- pacing the day's calls, and what the fingerprint watches (2026-11-26) ---

test("the day's calls are paced: little overnight, all of them by the end of the UTC day", () => {
  const at = (hhmm) => callsAllowedBy(new Date(`2026-11-26T${hhmm}:00Z`));
  assert.equal(at("00:07"), 1);
  assert.ok(at("04:22") <= 2, "04:22Z (11:22 PM ET) was when the cap ran out on 11-26");
  assert.equal(at("10:59"), 3);   // 6 AM ET: the night's share is 30 %
  assert.equal(at("11:07"), 4);
  assert.ok(at("17:00") >= 6 && at("17:00") <= 8);
  assert.equal(at("23:30"), DAILY_CAP);
  let last = 0;
  for (let h = 0; h < 24; h++) { const n = at(`${String(h).padStart(2, "0")}:30`); assert.ok(n >= last); last = n; }
});

test("overnight, a run past the hour's allowance makes no call and keeps the earlier text", async () => {
  const root = await sandbox({ prev: { api: { day: "2026-10-30", calls: 3 } } });
  const api = fakeApi(() => assert.fail("over the pace"));
  const { status } = await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: new Date("2026-10-30T03:07:00Z"), fetchImpl: api.fetchImpl, gather: noAhead, log: quiet });
  assert.equal(api.calls.length, 0);
  assert.match(status.warnings.join(), /call budget for this hour/);
});

test("a rejected draft's problems go to the run log", async () => {
  const root = await sandbox();
  const lines = [];
  const api = fakeApi(() => ({ text: "not json" }));
  await run({ root, env: { ANTHROPIC_API_KEY: "k" }, now: NOW, fetchImpl: api.fetchImpl, gather: noAhead, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /attempt 1 (rejected|failed)/.test(l)));
});

test("the fingerprint ignores days the text may not quote, but not totals, the big day or alerts", () => {
  const g = facts0().regions[0];
  const base = regionBasis(g);
  const small = structuredClone(g);
  const r0 = small.resorts[0];
  const minor = r0.days.find((d) => d.in < (r0.peak?.in ?? 0));
  if (minor) minor.in += 1;
  assert.equal(regionBasis(small), base, "a smaller day moving is not a reason to rewrite");
  const total = structuredClone(g); total.resorts[0].totalIn += 1;
  assert.notEqual(regionBasis(total), base);
  const peak = structuredClone(g); peak.resorts[0].peak = { dow: peak.resorts[0].peak?.dow ?? "Sunday", in: (peak.resorts[0].peak?.in ?? 0) + 1 };
  assert.notEqual(regionBasis(peak), base);
  const alert = structuredClone(g); alert.resorts[0].alerts = [{ event: "Winter Storm Warning", from: "x", to: "y" }];
  assert.notEqual(regionBasis(alert), base);
});
