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
import { readoutFacts, factsForWriter, templateReadout, validateReadout, onlyAheadProblems, carryForward, regionBasis, REUSE_HOURS } from "../src/lib/readout.js";
import { callClaude, parseReply, HAIKU, SONNET } from "./readout-api.js";
import { gatherAhead } from "./discussions.js";
import { buoyNow } from "./buoy-now.js";
import { applySnowfall, blendFresh } from "../src/lib/ours.js";

/* Two read-outs (Brian, 2026-11-18: the Snowfall switch should "rewrite the
   editorial"): editorial.json from Snow-Forecast's numbers, and
   editorial-ours.json from our blend's (`variant: "ours"`), each written from
   exactly the numbers the radar shows under that setting. The app picks the
   one that matches the switch and reloads when it is flipped. */
export const VARIANTS = {
  sf: { file: "editorial.json", totals: "Snow-Forecast (totals)", debug: "" },
  ours: { file: "editorial-ours.json", totals: "Tabulator model (totals)", debug: "ours-" },
};
/** The blend stamp a read-out was written from; the app shows it only if
 *  the blend it has loaded carries the same stamp. */
export const blendStamp = (blend) => blend?.generatedAt ?? blend?.fetchedAt ?? null;

export const MAX_ATTEMPTS = 2;
export const DAILY_CAP = 10; // was 6; raised 2026-11-18 (Brian) for the two read-outs and manual runs
/**
 * How many of the day's calls may be spent by `now` (UTC day, resets 7 PM ET).
 * The blend now builds hourly and each rewrite can use 2 calls, so an
 * unpaced cap was gone by 04:22Z (11:22 PM ET) and every run until 7 PM ET
 * the next evening shipped the template (2026-11-26). Overnight (00:00–10:59Z,
 * 7 PM–6 AM ET) gets at most 30 % of the cap; the rest unlocks through the
 * ET daytime. Same total spend, spread to when the screen is read.
 */
export const NIGHT_END_UTC_H = 11;
export const NIGHT_SHARE = 0.3;
export function callsAllowedBy(now, cap = DAILY_CAP) {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  const share = h < NIGHT_END_UTC_H
    ? NIGHT_SHARE * (Math.floor(h) + 1) / NIGHT_END_UTC_H
    : NIGHT_SHARE + (1 - NIGHT_SHARE) * Math.min(1, (Math.floor(h) - NIGHT_END_UTC_H + 1) / (24 - NIGHT_END_UTC_H));
  return Math.min(cap, Math.ceil(cap * share));
}
export const MAX_INPUT_CHARS = 60000; // the forecasters' discussions roughly double the fact sheet
export const MAX_TOKENS = 2000;
export const TIMEOUT_MS = 45000;

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
};

/** Shrink the fact sheet to fit the input cap, or say it cannot. */
export function fitForWriter(facts) {
  const f = {
    ...factsForWriter(facts),
    ahead: [...(facts.ahead ?? [])],
    regions: facts.regions.map((g) => ({ ...g, ...(g.pattern ? { pattern: [...g.pattern] } : {}) })),
  };
  let s = JSON.stringify(f);
  // The look-ahead goes first, then the forecasters' reasoning from the
  // last region backwards, one discussion at a time.
  while (s.length > MAX_INPUT_CHARS && f.ahead.length) { f.ahead.pop(); s = JSON.stringify(f); }
  for (let i = f.regions.length - 1; i >= 0 && s.length > MAX_INPUT_CHARS; i--) {
    while (s.length > MAX_INPUT_CHARS && f.regions[i].pattern?.length) {
      f.regions[i].pattern.pop();
      if (!f.regions[i].pattern.length) delete f.regions[i].pattern;
      s = JSON.stringify(f);
    }
  }
  return s.length > MAX_INPUT_CHARS ? null : { facts: f, text: s };
}

export async function run({
  root = new URL("..", import.meta.url).pathname,
  env = process.env,
  now = new Date(),
  fetchImpl = fetch,
  gather = gatherAhead,
  buoy = null, // the CLI passes buoyNow; tests stay offline
  log = console.error,
  variant = "sf",
} = {}) {
  const V = VARIANTS[variant];
  if (!V) throw new Error(`unknown read-out variant "${variant}"`);
  let forecast = await readJson(`${root}public/forecast.json`, null);
  if (!forecast?.resorts?.length) throw new Error("public/forecast.json missing or empty — nothing to write about");
  let blend = null;
  if (variant === "ours") {
    blend = await readJson(`${root}public/blend-forecast.json`, null);
    if (!blendFresh(blend, now.getTime())) {
      // The app shows Snow-Forecast (and its read-out) when the blend is stale.
      log("readout (ours): no fresh blend-forecast.json — nothing written");
      return { editorial: null, status: { fatal: null, warnings: ["no fresh blend — Tabulator read-out not written"] }, debug: null };
    }
    forecast = applySnowfall(forecast, blend, now.getTime());
  }
  const weather = await readJson(`${root}public/weather.json`, { resorts: {} });
  const prev = await readJson(`${root}public/${V.file}`, {});

  const day = now.toISOString().slice(0, 10);
  const api = { day, calls: prev?.api?.day === day ? prev.api.calls ?? 0 : 0 };
  const allowedNow = callsAllowedBy(now);
  const status = { fatal: null, warnings: [] };
  const debug = { attempts: [], compare: null };

  // The fact sheet, first without the look-ahead to learn which offices matter.
  const base = { resorts: forecast.resorts, weather: weather.resorts ?? {}, generatedAt: forecast.generatedAt, now };
  let facts = readoutFacts(base);
  if (!facts.quiet) {
    const offices = [...new Set(facts.regions.flatMap((g) => g.resorts).map((r) => weather.resorts?.[r.id]?.office).filter(Boolean))];
    const ahead = await gather(offices, { now, log });
    facts = readoutFacts({ ...base, ahead });
  }

  let out = null, writer = "template", model = null;
  let noAhead = null; // a draft whose only problems were in "ahead", kept without it
  const key = env.ANTHROPIC_API_KEY;
  const fitted = facts.quiet ? null : fitForWriter(facts);

  /* Nothing has moved since the last Claude read-out (same numbers in every
     region, written under REUSE_HOURS ago): reuse it and save the calls.
     The Tabulator read-out is rewritten on every forecast run even when the
     blend it quotes hasn't changed. */
  const carried = facts.quiet ? null : carryForward(prev, facts, now);
  const fresh = carried?.complete && now.getTime() - Date.parse(carried.writtenAt) < REUSE_HOURS * 3600e3;
  let writtenAt = null;

  if (facts.quiet) {
    out = { regions: [], overview: null, ahead: null };
  } else if (fresh) {
    out = carried; writer = "claude"; model = prev.model ?? null; writtenAt = carried.writtenAt;
    log("readout: nothing has changed since the last read-out — reused, no API call");
  } else if (!key) {
    log("readout: no ANTHROPIC_API_KEY — template");
  } else if (!fitted) {
    status.warnings.push(`fact sheet over ${MAX_INPUT_CHARS} chars even without the look-ahead — API not called`);
  } else {
    model = env.READOUT_MODEL || HAIKU;
    let user = `Fact sheet:\n${fitted.text}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !out && !status.fatal; attempt++) {
      if (api.calls >= DAILY_CAP) { status.warnings.push(`daily cap of ${DAILY_CAP} API calls reached`); break; }
      if (api.calls >= allowedNow) { status.warnings.push(`call budget for this hour used (${api.calls} of ${allowedNow} allowed by now, cap ${DAILY_CAP}/day)`); break; }
      api.calls++;
      const rec = { attempt, model };
      try {
        const res = await callClaude({ key, model, user, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, fetchImpl });
        Object.assign(rec, { raw: res.text, usage: res.usage, stop: res.stop });
        const parsed = parseReply(res.text);
        const problems = validateReadout(parsed, facts);
        rec.problems = problems;
        // In the run log too: the debug artifact can't be downloaded from CI.
        if (problems.length) log(`readout: attempt ${attempt} rejected — ${problems.slice(0, 4).join(" | ")}`);
        if (onlyAheadProblems(problems) && !noAhead) noAhead = { ...parsed, ahead: null };
        if (problems.length) {
          user = `Fact sheet:\n${fitted.text}\n\nYour previous reply was rejected:\n- ${problems.join("\n- ")}\nWrite it again, fixing those.`;
        } else {
          out = parsed; writer = "claude";
        }
      } catch (e) {
        rec.error = e.message;
        log(`readout: attempt ${attempt} failed — ${String(e.message).slice(0, 200)}`);
        if (e.fatal) status.fatal = e.message;
      }
      debug.attempts.push(rec);
    }
    /* The regions passed; only the look-ahead didn't. Ship them without it
       rather than fall back to the template (2026-11-18: 3 of 3 drafts failed
       only on "ahead"). */
    if (!out && noAhead && !validateReadout(noAhead, facts).length) {
      out = noAhead; writer = "claude";
      status.warnings.push("the look-ahead did not pass the check — read-out shipped without it");
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

  /* No new draft: keep what still holds of the last Claude read-out (same
     variant, under a day old, re-checked against today's facts) before
     falling back to the bare template. */
  if (!out && !facts.quiet) {
    if (carried) {
      out = carried; writer = "claude"; model = prev.model ?? null; writtenAt = carried.writtenAt;
      status.warnings.push(`no new read-out — kept ${carried.kept.length} of ${facts.regions.length} regions from the one written ${carried.writtenAt}`);
    }
  }
  if (writer === "claude" && !writtenAt) writtenAt = now.toISOString();
  // Only regions Claude actually wrote get a basis, so a template sentence
  // is never mistaken later for one worth carrying.
  const claudeKeys = new Set(writer !== "claude" ? [] : out === carried ? carried.kept : out.regions.map((r) => r.key));

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
    ...(variant === "ours" ? { snowfall: "tabulator", blendGeneratedAt: blendStamp(blend) } : {}),
    quiet: facts.quiet,
    writer,
    ...(writtenAt ? { writtenAt } : {}),
    ...(model ? { model } : {}),
    window: facts.window,
    overview: out.overview ?? null,
    regions: out.regions.map((r) => {
      const g = facts.regions.find((x) => x.key === r.key);
      return { key: r.key, title: titles[r.key] ?? r.key, text: r.text, ...(g && claudeKeys.has(r.key) ? { basis: regionBasis(g) } : {}) };
    }),
    ahead: out.ahead
      ? { text: out.ahead, sources: facts.ahead.map(({ source, issuedAt, url }) => ({ name: source, issuedAt, url })) }
      : null,
    sources: [
      { name: V.totals, issuedAt: variant === "ours" ? blendStamp(blend) : forecast.generatedAt },
      ...(weather.generatedAt ? [{ name: "National Weather Service point forecasts", issuedAt: weather.generatedAt }] : []),
      // The discussions each region drew on, when a model wrote it.
      ...(writer === "claude"
        ? [...new Map(facts.regions.flatMap((g) => g.pattern ?? []).map((p) => [p.source, { name: p.source, issuedAt: p.issuedAt }])).values()]
        : []),
    ],
    api,
  };
  // Powder Buoy line (experimental, template only; scripts/buoy-now.js).
  if (buoy) {
    const b = await buoy({ now });
    editorial.buoy = b.block;
    if (b.block) editorial.sources.push({ name: "NOAA buoys 51001 / 51101 (method: Powder Buoy, Mike Ruzek)", issuedAt: now.toISOString() });
    if (b.warning) status.warnings.push(b.warning);
  }
  await writeFile(`${root}public/${V.file}`, JSON.stringify(editorial, null, 1));

  await mkdir(`${root}readout-debug`, { recursive: true });
  await writeFile(`${root}readout-debug/${V.debug}facts.json`, JSON.stringify(facts, null, 1));
  await writeFile(`${root}readout-debug/${V.debug}attempts.json`, JSON.stringify(debug, null, 1));

  log(`readout${variant === "ours" ? " (ours)" : ""}: ${facts.quiet ? "quiet week" : `${editorial.regions.length} regions`} by ${writer}${model ? ` (${model})` : ""}; API calls today ${api.calls}/${DAILY_CAP}`);
  return { editorial, status, debug };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const variant = process.argv[2] === "ours" ? "ours" : "sf";
    const { status } = await run({ buoy: buoyNow, variant });
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
