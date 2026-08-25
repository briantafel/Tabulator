import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

/* CI config is code, and it broke in a way nothing else would have caught:
 * a JS template literal inside `script: |` with continuation lines at column 0
 * silently invalidated the whole file. GitHub reported five failed runs that
 * had nothing to do with scraping, and the failure-reporting step — the very
 * thing meant to surface problems — was the thing that was broken.
 *
 * Parsing the workflows in the test suite makes that a caught error rather
 * than a red X in a tab nobody is watching. */

const DIR = new URL("../.github/workflows/", import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("there are workflow files to check", () => {
  assert.ok(files.length >= 2, `expected the scrape and pages workflows, found ${files}`);
});

for (const file of files) {
  test(`${file} is valid YAML with a runnable job`, () => {
    const raw = readFileSync(DIR + file, "utf8");
    let doc;
    try {
      doc = parse(raw);
    } catch (e) {
      assert.fail(`${file} does not parse: ${e.message}`);
    }

    assert.ok(doc.name, "workflow needs a name — GitHub falls back to the filename without one, " +
      "which is the visible symptom of an unparseable file");

    // `on:` is the YAML 1.1 boolean `true` once parsed. Accept either.
    const triggers = doc.on ?? doc[true];
    assert.ok(triggers && Object.keys(triggers).length, `${file} has no triggers`);

    assert.ok(doc.jobs && Object.keys(doc.jobs).length, `${file} has no jobs`);
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job["runs-on"], `job "${name}" has no runs-on`);
      const steps = job.steps ?? [];
      if (!steps.length && !job.uses) assert.fail(`job "${name}" has no steps`);
      for (const s of steps) {
        assert.ok(s.uses || s.run, `a step in "${name}" has neither uses nor run`);
      }
    }
  });
}

test("npm test does not rely on Node's own glob expansion", () => {
  /* `node --test 'test/*.test.js'` only works on Node >= 21 — earlier versions
     take the pattern as a literal filename and exit 1. CI was pinned to Node
     20, so the Pages build failed on its test step while the same command
     passed locally on 22. Leaving the glob UNQUOTED hands it to the shell,
     which every version expands the same way. */
  const pkg = JSON.parse(readFileSync(DIR + "../../package.json", "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /['"]test\/\*/,
    "quote the test glob and it stops working on older Node");

  // And the runners must not be older than what the code is developed against.
  for (const f of ["pages.yml", "forecast.yml", "probe-reports.yml"]) {
    const raw = readFileSync(DIR + f, "utf8");
    for (const [, v] of raw.matchAll(/node-version:\s*"(\d+)"/g)) {
      assert.ok(Number(v) >= 22, `${f} pins Node ${v}; the tests need >= 22`);
    }
  }
});

test("the scrape workflow can be triggered by hand", () => {
  const doc = parse(readFileSync(DIR + "forecast.yml", "utf8"));
  const triggers = doc.on ?? doc[true];
  assert.ok("workflow_dispatch" in triggers,
    "without workflow_dispatch there is no Run workflow button, and the only " +
    "way to test a scrape is to wait for the cron");
  /* The schedule is deliberately commented out while the app runs on the
     sample fixture (Brian, 2026-08-25: scraping pages nobody reads wastes
     bandwidth and risks getting the IP flagged). The cron lines must survive
     in the file so re-enabling is uncommenting, not rewriting from memory. */
  const raw = readFileSync(DIR + "forecast.yml", "utf8");
  const crons = raw.match(/^\s*#?\s*- cron: /gm) ?? [];
  assert.equal(crons.length, 2, "the two cron lines must stay in the file");
  if (!("schedule" in triggers)) {
    assert.match(raw, /PAUSED/,
      "a scrape with no schedule must say IN THE FILE that it is paused on " +
      "purpose, or the next person reads it as a bug and 'fixes' it");
  }
});
