# Data

> **Superseded.** This app no longer uses Open-Meteo. The live data contract is
> in [`SCRAPING.md`](SCRAPING.md). This file is kept for the reasoning, because
> the decision was reversed and the reversal is worth understanding.

## What happened

The original spreadsheet scraped **Snow-Forecast.com** and broke. The first
rebuild moved to **Open-Meteo** — free, no key, CORS-friendly, so a browser app
could call it directly. That solved a real problem: Snow-Forecast blocks
cross-origin requests, so no client-side app can reach it.

The trade was stated plainly at the time: *you lose human forecaster
commentary, you gain something that doesn't break on a site redesign.*

**Brian rejected that trade.** Open-Meteo is raw model output; Snow-Forecast is
a forecaster reading those same models and applying judgement. For deciding
where to spend a week's holiday, the judgement is the product.

## How the CORS problem got solved instead

By moving the fetch off the browser entirely. A scheduled GitHub Action scrapes
Snow-Forecast server-side and commits `public/forecast.json`; the app reads a
static file and makes no third-party request at runtime.

That was always available — it just wasn't considered, because the first
rebuild took "must run in the browser" as a fixed constraint rather than a
choice.

## What carried over

- **Metric storage.** Snow-Forecast serves cm, °C, km/h. The app now stores
  those and converts outward for display — inverted from this file's original
  design, which stored imperial.
- **The derived metrics.** `-3 days`, `snow`, `↑ temp`, `↑ wind` are unchanged
  in meaning. Only their source moved.
- **The honesty rule.** Open-Meteo offered 16 days and the footer had to
  disclaim most of them. Snow-Forecast's free tier gives 6, all of which the
  app can stand behind. Fewer days, no disclaimer.
