#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Writes public/editorial.json — the radar read-out — from this run's
 * forecast.json and weather.json, so it lands in the same commit as the
 * numbers it describes.
 *
 * Writer: the Claude API when ANTHROPIC_API_KEY is set, the template in
 * src/lib/readout.js otherwise or whenever the API's text fails the check.
 *
 * COST GUARDS (Brian, 2026-10-30: "how do I protect against an AI loop or
 * error which ends up costing me a fortune?"). All enforced here and
 * covered by test/readout.test.js:
 *   - at most MAX_ATTEMPTS calls for the read-out per run (1 + 1 retry);
 *   - at most DAILY_CAP calls per UTC day across all runs, counted in
 *     editorial.json itself, so pressing "Run workflow" twenty times still
 *     stops at the cap;
 *   - an input-size cap: the look-ahead excerpts are dropped first, and if
 *     the fact sheet is still too big the API is not called at all;
 *   - max_tokens and a timeout on every call;
 *   - the fallback (template) never calls the API.
 * The account's own spend limits sit behind all of this.
 * ------------------------------------------------------------------ */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readoutFacts, factsForWriter, templateReadout, validateReadout } from "../src/lib/readout.js";
import { callClaude, parseReply, HAIKU, SONNET } from "./readout-api.js";
import { gatherAhead } from "./discussions.js";

export const MAX_ATTEMPTS = 2;
export const DAILY_CAP = 6;
export const MAX_INPUT_CHARS = 30000;
export const MAX_TOKENS = 1000;
export const TIMEOUT_MS = 45000;

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
};

/** Shrink the fact sheet to fit the input cap, or say it cannot. */
export function fitForWriter(facts) {
  const f = { ...factsForWriter(facts), ahead: [...(facts.ahead ?? [])] };
  let s = JSON.stringify(f);
  while (s.length > MAX_INPUT_CHARS && f.ahead.length) { f.ahead.pop(); s = JSON.stringify(f); }
  return s.length > MAX_INPUT_CHARS ? null : { facts: f, text: s };
}

export async function run({
  root = new URL("..", import.meta.url).pathname,
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
  gather = gatherAhead,
  log = console.error,
} = {}) {
  const forecast = await readJson(`${root}public/forecast.json`, null);
  if (!forecast?.resorts?.length) throw new Error("public/forecast.json missing or empty — nothing to write about");
  const weather = await readJson(`${root}public/weather.json`, { resorts: {} });
  const prev = await readJson(`${root}public/editorial.json`, {});

  const day = now.toISOString().slice(0, 10);
  const api = { day, calls: prev?.api?.day === day ? prev.api.calls ?? 0 : 0 };
  const status = { fatal: null, warnings: [] };
  const debug = { attempts: [], compare: null };

  // The fact sheet, first without the look-ahead to learn which offices matter.
  const base = { resorts: forecast.resorts, weather: weather.resorts ?? {}, generatedAt: forecast.generatedAt, now };
  let facts = readoutFacts(base);
  if (!facts.quiet) {
    const offices = [...new Set(facts.regions.flatMap((g) => g.resorts.slice(0, 2)).map((r) => weather.resorts?.[r.id]?.office).filter(Boolean))];
    const ahead = await gather(offices, { now, log });
    facts = readoutFacts({ ...base, ahead });
  }

  let out = null, writer = "template", model = null;
  const key = env.ANTHROPIC_API_KEY;
  const fitted = facts.quiet ? null : fitForWriter(facts);

  if (facts.quiet) {
    out = { regions: [], ahead: null };
  } else if (!key) {
    log("readout: no ANTHROPIC_API_KEY — template");
  } else if (!fitted) {
    status.warnings.push(`fact sheet over ${MAX_INPUT_CHARS} chars even without the look-ahead — API not called`);
  } else {
    model = env.READOUT_MODEL || HAIKU;
    let user = `Fact sheet:\n${fitted.text}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !out && !status.fatal; attempt++) {
      if (api.calls >= DAILY_CAP) { status.warnings.push(`daily cap of ${DAILY_CAP} API calls reached — template`); break; }
      api.calls++;
      const rec = { attempt, model };
      try {
        const res = await callClaude({ key, model, user, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, fetchImpl });
        Object.assign(rec, { raw: res.text, usage: res.usage, stop: res.stop });
        const parsed = parseReply(res.text);
        const problems = validateReadout(parsed, facts);
        rec.problems = problems;
        if (problems.length) {
          user = `Fact sheet:\n${fitted.text}\n\nYour previous reply was rejected:\n- ${problems.join("\n- ")}\nWrite it again, fixing those.`;
        } else {
          out = parsed; writer = "claude";
        }
      } catch (e) {
        rec.error = e.message;
        if (e.fatal) status.fatal = e.message;
      }
      debug.attempts.push(rec);
    }
    if (!out && !status.fatal) status.warnings.push("the API's read-out did not pass the check — template used (see the readout-debug artifact)");

    // A week of Sonnet alongside, for Brian to compare. Saved to the debug
    // artifact only; never shown, and it counts against the same daily cap.
    const until = env.READOUT_COMPARE_UNTIL;
    if (until && day <= until && !status.fatal && api.calls < DAILY_CAP) {
      api.calls++;
      try {
        const res = await callClaude({ key, model: SONNET, user: `Fact sheet:\n${fitted.text}`, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, fetchImpl });
        let problems;
        try { problems = validateReadout(parseReply(res.text), facts); } catch (e) { problems = [e.message]; }
        debug.compare = { model: SONNET, raw: res.text, usage: res.usage, problems };
      } catch (e) {
        debug.compare = { model: SONNET, error: e.message };
      }
    }
  }

  if (!out) {
    out = templateReadout(facts);
    writer = "template"; model = null;
    const problems = validateReadout(out, facts);
    if (problems.length) throw new Error(`the template failed its own check — a bug in readout.js:\n- ${problems.join("\n- ")}`);
  }

  const titles = Object.fromEntries(facts.regions.map((g) => [g.key, g.title]));
  const editorial = {
    generatedAt: now.toISOString(),
    forecastGeneratedAt: forecast.generatedAt,
    quiet: facts.quiet,
    writer,
    ...(model ? { model } : {}),
    window: facts.window,
    regions: out.regions.map((r) => ({ key: r.key, title: titles[r.key] ?? r.key, text: r.text })),
    ahead: out.ahead
      ? { text: out.ahead, sources: facts.ahead.map(({ source, issuedAt, url }) => ({ name: source, issuedAt, url })) }
      : null,
    sources: [
      { name: "Snow-Forecast (totals)", issuedAt: forecast.generatedAt },
      ...(weather.generatedAt ? [{ name: "National Weather Service point forecasts", issuedAt: weather.generatedAt }] : []),
    ],
    api,
  };
  await writeFile(`${root}public/editorial.json`, JSON.stringify(editorial, null, 1));

  await mkdir(`${root}readout-debug`, { recursive: true });
  await writeFile(`${root}readout-debug/facts.json`, JSON.stringify(facts, null, 1));
  await writeFile(`${root}readout-debug/attempts.json`, JSON.stringify(debug, null, 1));

  log(`readout: ${facts.quiet ? "quiet week" : `${editorial.regions.length} regions`} by ${writer}${model ? ` (${model})` : ""}; API calls today ${api.calls}/${DAILY_CAP}`);
  return { editorial, status, debug };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { status } = await run();
    for (const w of status.warnings) console.log(`::warning::Radar read-out: ${w}`);
    if (status.fatal) {
      console.log(`::error::Radar read-out fell back to the template: ${status.fatal}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.log(`::error::Radar read-out not written: ${e.message}`);
    process.exitCode = 1;
  }
}
