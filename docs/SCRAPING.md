# Scraping Snow-Forecast

Replaces the Open-Meteo integration described in `DATA.md`, which is now stale.

## Why this exists

The original spreadsheet scraped Snow-Forecast with
`=IMPORTHTML(url, "table", 3)` and broke when the page was reorganised —
ordinal table position is not a contract. As of Aug 2026 index 3 returns the
Bluebird-days table, and nothing in the sheet pointed at the forecast grid at
all.

**This parser never counts tables.** It targets `table.forecast-table__table`
by class and each row by its `data-row` attribute. Those names are stable
across the layout changes that killed the formulas.

## Running it

```bash
npm run scrape     # writes public/forecast.json + public/history.json
```

Requests are paced at one per 1.5s with a descriptive User-Agent. Don't tighten
that — the tool plans ski trips, it doesn't need sub-minute freshness.

## Failure is loud, by design

The spreadsheet rotted for months because a broken scrape and a quiet week
looked identical. So:

- Fewer than 80% of resorts parsing → **exit non-zero, write nothing.** A
  partial file never replaces a good one.
- A missing required row (`days`, `time`) → **throw**, naming the selector.
- Optional rows (`freezing-level`, `phrases`) degrade to `null` and carry on.
- The Action opens a GitHub issue on failure, because a red run on a schedule
  is easy to never notice.

## The em-dash

Snow-Forecast renders "no snow" as `—`, not `0`. Parsed as null it would
poison every sum in the app. `parseSnow()` handles em-dash, en-dash, hyphen and
empty string, all to `0`. There is a test pinning this.

## Where "-3 days" comes from now

Open-Meteo's `past_days=3` used to feed the **before** column — the base you're
landing on. Snow-Forecast's 6-day page is forecast-only, so there is no
backward-looking field to scrape.

Instead the scraper appends each run's **day-0 snowfall** to
`public/history.json`, keeping 14 days. After three days of runs, `before` is
the sum of the last three days from our own archive — Snow-Forecast's own
nowcast, accumulated over time, rather than a second provider.

**Cold start:** the column reads `—` for the first three days after deployment.
That is correct rather than convenient; it should not be faked.

## Multi-slug resorts

Palisades is one entry backed by `Squaw-Valley` and `Alpine-Meadows` — the site
still files the mountain under its former name and lists the merged faces
separately. `combine.rule` in `resorts.json` is `max`: if one face got 30cm and
the other 10, you ski the side that got it. Temp and wind also take the max
because the warning thresholds are worst-case by design.

## Output shape

```jsonc
{
  "generatedAt": "…", "source": "snow-forecast.com", "tier": "mid",
  "units": { "snow": "cm", "temp": "C", "wind": "km/h", "elevation": "m" },
  "horizonDays": 6,
  "failures": [],           // non-fatal slug problems, worth watching
  "resorts": [{
    "id": "telluride", "name": "Telluride", "region": "Colorado",
    "slugs": ["Telluride"],
    "elevation": { "top": 3831, "mid": 3245, "bot": 2659 },  // scraped, not maintained
    "summary": { "next3": "…", "days46": "…" },              // the forecaster's prose
    "days": [{
      "date": "2026-08-20", "snow": 0,
      "tempMax": 21, "tempMin": 8, "windMax": 15,
      "freezeMin": 5250, "freezeMax": 5700,
      "periods": [{ "name": "am", "snow": 0, "phrase": "some clouds", … }]
    }]
  }]
}
```

**Units are metric** — that is what the page serves. The app converts for
display; the file stays in the source's own units so nothing is lossy.

## When it breaks

It will. In likely order:

1. **A slug changed.** Fix `src/data/resorts.json`. Never guess a slug — fetch
   it and check for a 200 plus a `.forecast-table__table`.
2. **`data-row` attributes changed.** Update `scripts/parse.js` and the
   fixture in `test/sf-fixture.js` together.
3. **Blocked from GitHub's IPs.** Run `npm run scrape` locally and compare. If
   local works and CI doesn't, move the schedule to your own machine.

## A caveat on the tests

`test/sf-fixture.js` is a *reconstruction* of the page built from a live
structure survey, not a saved copy of the served HTML — the build sandbox
cannot reach snow-forecast.com. The tests pin the contract we observed. **The
first real Action run is the true test**, which is why the scraper validates
its own output rather than trusting it.
