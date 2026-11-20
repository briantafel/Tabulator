/* Rebuilds public/history.json by replaying every committed forecast.json,
 * oldest first, through recordDay. One-off repair for the partial-day bug (see
 * history.js): the old archive kept only the last scrape's leftover periods.
 *
 *   git fetch --depth=400 origin main   # enough history to reach the first scrape
 *   node scripts/rebuild-history.js
 *
 * Days whose periods were never all seen stay out of the archive, so "-3 days"
 * reads "—" for them instead of a short total. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { openHistory, recordDay } from "./history.js";

const root = new URL("../", import.meta.url).pathname;
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

const commits = git("log", "--reverse", "--format=%H", "--", "public/forecast.json")
  .split("\n").filter(Boolean);

let history = openHistory(null);
let used = 0;
for (const c of commits) {
  let f;
  try { f = JSON.parse(git("show", `${c}:public/forecast.json`)); } catch { continue; }
  if (f.synthetic || !Array.isArray(f.resorts)) continue;
  history = recordDay(history, f.resorts, new Date(f.generatedAt));
  used++;
}

await writeFile(`${root}public/history.json`, JSON.stringify(history, null, 1));
const dates = Object.keys(history.parts);
console.error(`replayed ${used}/${commits.length} scrapes → ${dates.length} days (${dates[0]} … ${dates.at(-1)})`);
for (const d of dates) {
  const all = Object.keys(history.parts[d]).length;
  const full = Object.keys(history.days[d] ?? {}).length;
  console.error(`  ${d}: ${full}/${all} resorts with all three periods`);
}
