# Tabulator scheduler (Cloudflare Worker)

GitHub starts this repo's scheduled workflows 3–8 hours late and has skipped
the hourly / 3-hourly ones entirely (2026-11-11). This Worker starts them on
time from Cloudflare's cron instead. GitHub's own cron lines stay as a backup.

## One-time setup (Brian)
1. **GitHub token.** github.com → Settings → Developer settings → Fine-grained
   tokens → Generate. Repository access: only `briantafel/Tabulator`.
   Permissions: **Actions: Read and write** (nothing else). Expiry: up to you
   (a year is fine; put a reminder in your calendar).
2. **Deploy** (from a computer with Node):
   ```
   cd workers/scheduler
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN     # paste the token here, not in chat
   npx wrangler deploy
   ```
   Or in the Cloudflare dashboard: Workers & Pages → Create → Worker, paste
   `index.js`, add the variable `REPO = briantafel/Tabulator`, add the secret
   `GITHUB_TOKEN`, and add the cron trigger `7 * * * *`.
3. **Auto-deploy (from 2026-11-19).** Create a Cloudflare API token from the
   "Edit Cloudflare Workers" template and save it as the GitHub repo secret
   `CLOUDFLARE_API_TOKEN`. After that, `.github/workflows/deploy-scheduler.yml`
   deploys this Worker on every change to this folder on main; no more manual
   `wrangler deploy`. The Worker's `GITHUB_TOKEN` secret stays as set above.
4. **Check:** open the Worker's URL; it lists what starts in the next hours.
   After the next :07, the GitHub Actions tab shows the runs as "workflow_dispatch".

## What it starts (UTC)
- every hour: watchdog, dynamical-history (until it is disabled)
- every 3 h: regional-eps (01, 04, …), dynamical-ens and nbm (02, 05, …), upper-air (00, 03, …)
- twice daily: forecast (06:07 and 21:07, the Snow-Forecast scrape), blend (woken every 3 h from 01:07 UTC; it builds only when a model has a new run)
- daily: ensembles-om (08:07), verify (09:07, the scoring job + daily digest), projections-dyn (10:07)
- every 6 h: temps (05, 11, 17, 23 :07)
- added 2026-11-23: archive (06:45 and 21:45, the second cron trigger `45 6,21 * * *`, 30 min after the app's scrape), season (14:07), nohrsc (15:07), longrange (11:07, was 10:27; stays after projections-dyn at 10:07). Their GitHub cron lines stay as a backup until the Worker is seen starting them.
- removed 2026-11-23: hrrr-backfill (finished 2026-11-19, workflow disabled).

## Adding a job
Add a row to `SCHEDULE` in `index.js`. A row with a `minute` other than 7 needs a matching cron trigger in `wrangler.toml`
(free plan allows few triggers per account, so prefer :07); `test/scheduler.test.js` fails if a row has no trigger.
