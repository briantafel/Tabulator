/* Tabulator scheduler (Cloudflare Worker cron). Every hour it starts the
   GitHub workflows that are due, via workflow_dispatch. This is the clock
   for almost every job: the GitHub cron lines were removed 2026-11-23. The
   exceptions that keep a GitHub cron are the watchdog (an independent backstop,
   so one clock failing cannot silence it), the monthly/yearly jobs and
   backfill. Every workflow has a concurrency group and done markers, so a
   duplicate start costs a minute and re-archives nothing.

   Secret: GITHUB_TOKEN, a fine-grained token for briantafel/Tabulator with
   "Actions: Read and write" only. Entered by Brian in Cloudflare, never in chat.

   Failures are loud: a dispatch that GitHub refuses makes the cron invocation
   throw, which shows as an error in the Worker's Cron Events log, and the
   watchdog workflow (hourly, started from here too) checks the archive. */

// workflow file → every N hours (hour of day % N === offset)
export const SCHEDULE = [
  { file: "watchdog.yml", every: 1, offset: 0 },
  { file: "dynamical-history.yml", every: 1, offset: 0 },
  // 2026-11-23: wind observations (ECCC keeps ~28 days; every missed hour is permanent). Each run re-takes the last 6 h.
  { file: "wind-obs.yml", every: 1, offset: 0 },
  { file: "regional-eps.yml", every: 3, offset: 1 },   // 01, 04, … UTC: after DWD/MeteoSwiss publish
  { file: "dynamical-ens.yml", every: 3, offset: 2 },
  { file: "nbm.yml", every: 3, offset: 2 },
  { file: "upper-air.yml", every: 3, offset: 0 },
  // 2026-11-18: HRRR precipitation, Canada's HRDPS (Datamart keeps ~1 day), NOAA AIGEFS.
  { file: "extra-models.yml", every: 1, offset: 0 },
  // hrrr-backfill.yml removed 2026-11-23: BACKFILL COMPLETE on 2026-11-19 and the workflow is disabled.
  // Daily (2026-11-11): one paced Open-Meteo ensemble pass (~90 min) after
  // ECMWF's 00z is on Open-Meteo, then the dynamical.org shadow build, which
  // compares itself against that pass.
  { file: "ensembles-om.yml", every: 24, offset: 8 },
  { file: "projections-dyn.yml", every: 24, offset: 10 },
  // 2026-11-16: the scoring job and the temperature build were on GitHub's
  // cron only, and GitHub skipped them (no verify run on 11-16 until Brian
  // asked). verify after the 02:30 archive run and the 08:13 ensemble pass;
  // temps after each main model cycle, as temps.yml's own cron says.
  // 2026-11-16: our live forecast (blend), an hour before the ensemble pass.
  // Our forecast twice a day, on Snow-Forecast's rhythm (Brian, 2026-11-18:
  // "Same times as snow-forecast... Their schedule is perfect for skiers").
  // 07 UTC rather than SF's 06: ECMWF's 00z isn't on Open-Meteo until ~07.
  // 21 UTC = 4:07 PM ET, all three 12z runs are out.
  // Snow-Forecast scrape (2026-11-19): GitHub's cron skipped the 06:15 run, so
  // the app opened on the 19th still starting at the 18th. Same two slots.
  { file: "forecast.yml", every: 24, offset: 6 },
  { file: "forecast.yml", every: 24, offset: 21 },
  // 2026-11-22 (Brian): our forecast about every 3 h, timed to model updates. This only WAKES blend.yml; its `check` job
  // builds when a model has a run the last blend did not use (GFS and GEM every 6-12 h, ECMWF 12 h), so most wakes end there.
  { file: "blend.yml", every: 3, offset: 1 },
  { file: "verify.yml", every: 24, offset: 9 },
  { file: "temps.yml", every: 6, offset: 5 },
  // 2026-11-23 (ops review): these were on GitHub's cron only, the clock the Worker exists to replace. Their GitHub
  // cron lines stay as a backup until the Worker is seen starting them; then remove the lines.
  // archive: 30 min after the app's own scrape (forecast.yml, 06:07 / 21:07), so minute 45 (2nd cron trigger).
  { file: "archive.yml", every: 24, offset: 6, minute: 45 },
  { file: "archive.yml", every: 24, offset: 21, minute: 45 },
  { file: "season.yml", every: 24, offset: 14 },    // SNOTEL's daily values are in by mid-morning Mountain
  { file: "nohrsc.yml", every: 24, offset: 15 },    // after the 12 UTC analysis
  // longrange was 10:27, "after projections-dyn.yml (10:07)". 11:07 keeps that order without a third cron trigger.
  { file: "longrange.yml", every: 24, offset: 11 },
];

// An entry without `minute` starts at :07 (the hourly trigger). `minute: 45` needs its own cron trigger in
// wrangler.toml; test/scheduler.test.js fails if an entry names a minute no trigger fires at.
export const DEFAULT_MINUTE = 7;
export function due(hour, schedule = SCHEDULE, minute = DEFAULT_MINUTE) {
  return [...new Set(schedule
    .filter((s) => (s.minute ?? DEFAULT_MINUTE) === minute && hour % s.every === s.offset % s.every)
    .map((s) => s.file))];
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
    const t = new Date(event.scheduledTime);
    const files = due(t.getUTCHours(), SCHEDULE, t.getUTCMinutes());
    const results = await Promise.allSettled(files.map((f) => dispatch(env, f)));
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    console.log(results.filter((r) => r.status === "fulfilled").map((r) => r.value).join("; "));
    if (failed.length) throw new Error("dispatch failed: " + failed.join("; "));
  },
  // GET https://tabulator-scheduler.<you>.workers.dev/ shows what the next hours start (no token needed).
  async fetch() {
    const h = new Date().getUTCHours();
    const lines = [0, 1, 2, 3].flatMap((d) => {
      const x = (h + d) % 24, hh = String(x).padStart(2, "0");
      return [[7, due(x)], [45, due(x, SCHEDULE, 45)]].filter(([, f]) => f.length).map(([m, f]) => `${hh}:${String(m).padStart(2, "0")} UTC  ${f.join(", ")}`);
    });
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/plain" } });
  },
};
