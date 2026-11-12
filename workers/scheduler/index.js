/* Tabulator scheduler (Cloudflare Worker cron). Every hour it starts the
   GitHub workflows that are due, via workflow_dispatch. The GitHub cron lines
   stay as a backup; every workflow has a concurrency group and done markers,
   so a duplicate start costs a minute and re-archives nothing.

   Secret: GITHUB_TOKEN, a fine-grained token for briantafel/Tabulator with
   "Actions: Read and write" only. Entered by Brian in Cloudflare, never in chat.

   Failures are loud: a dispatch that GitHub refuses makes the cron invocation
   throw, which shows as an error in the Worker's Cron Events log, and the
   watchdog workflow (hourly, started from here too) checks the archive. */

// workflow file → every N hours (hour of day % N === offset)
export const SCHEDULE = [
  { file: "watchdog.yml", every: 1, offset: 0 },
  { file: "dynamical-history.yml", every: 1, offset: 0 },
  { file: "regional-eps.yml", every: 3, offset: 1 },   // 01, 04, … UTC: after DWD/MeteoSwiss publish
  { file: "dynamical-ens.yml", every: 3, offset: 2 },
  { file: "nbm.yml", every: 3, offset: 2 },
  { file: "upper-air.yml", every: 3, offset: 0 },
  // Daily (2026-11-11): one paced Open-Meteo ensemble pass (~90 min) after
  // ECMWF's 00z is on Open-Meteo, then the dynamical.org shadow build, which
  // compares itself against that pass.
  { file: "ensembles-om.yml", every: 24, offset: 8 },
  { file: "projections-dyn.yml", every: 24, offset: 10 },
];

export function due(hour, schedule = SCHEDULE) {
  return schedule.filter((s) => hour % s.every === s.offset % s.every).map((s) => s.file);
}

async function dispatch(env, file) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${file}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tabulator-scheduler",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 = started. 422 = workflow disabled (e.g. history finished): not an error.
  if (r.status === 204 || r.status === 422) return `${file}: ${r.status === 204 ? "started" : "disabled, skipped"}`;
  throw new Error(`${file}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

export default {
  async scheduled(event, env) {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set");
    const hour = new Date(event.scheduledTime).getUTCHours();
    const results = await Promise.allSettled(due(hour).map((f) => dispatch(env, f)));
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    console.log(results.filter((r) => r.status === "fulfilled").map((r) => r.value).join("; "));
    if (failed.length) throw new Error("dispatch failed: " + failed.join("; "));
  },
  // GET https://tabulator-scheduler.<you>.workers.dev/ shows what the next hours start (no token needed).
  async fetch() {
    const h = new Date().getUTCHours();
    const lines = [0, 1, 2, 3].map((d) => `${String((h + d) % 24).padStart(2, "0")}:07 UTC  ${due((h + d) % 24).join(", ")}`);
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/plain" } });
  },
};
