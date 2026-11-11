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
3. **Check:** open the Worker's URL; it lists what starts in the next hours.
   After the next :07, the GitHub Actions tab shows the runs as "workflow_dispatch".

## What it starts (UTC)
- every hour: watchdog, dynamical-history (until it is disabled)
- every 3 h: regional-eps (01, 04, …), dynamical-ens and nbm (02, 05, …), upper-air (00, 03, …)
