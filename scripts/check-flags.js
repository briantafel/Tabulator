/* Checks the live public/flags.json against the switch table in src/lib/flags.js (switches plan, 2026-11-23).
 *
 *   node scripts/check-flags.js [path]
 *
 * Prints every problem and exits 1 if there is any: an unknown or retired key, a value that is not off/preview/on,
 * "preview" on a switch with no Settings row, a child on while its parent is off, or an old and a new name that
 * disagree. Run by .github/workflows/flags-check.yml only. It is deliberately NOT part of `npm test` or pages.yml:
 * an emergency "off" in flags.json must always be able to deploy, even when it leaves a child on under it. */
import { readFileSync } from "node:fs";
import { flagProblems } from "../src/lib/flags.js";

const path = process.argv[2] ?? new URL("../public/flags.json", import.meta.url).pathname;
let raw;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`flags check: cannot read ${path}: ${e.message}`);
  console.error("The app reads a missing or broken flags.json as every switch off.");
  process.exit(1);
}
const problems = flagProblems(raw);
if (problems.length) {
  console.error(`flags check: ${problems.length} problem(s) in ${path}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`flags check: ${path} is clean (${Object.keys(raw).length} keys).`);
