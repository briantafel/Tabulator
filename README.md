# Tabulator

**I can take these days off — where should I go?**

A ski trip decision tool. Not a weather app: the comparison *across* resorts,
scoped to a specific date window, is the whole product. Live data from
Open-Meteo across 23 resorts, three days of history plus a 16-day forecast.

Owner: Brian Tafel. Personal project.

---

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production bundle into dist/
npm run lint
```

No API key, no `.env`, no backend. Open-Meteo is free and CORS-friendly, so
the browser talks to it directly.

---

## Layout

```
src/
  App.jsx                 window state, tab routing, data orchestration
  main.jsx                entry point
  styles.css              the whole visual language, one file
  components/
    DaysWheel.jsx         the signature interaction — horizontal number wheel
    MonthGrid.jsx         month grid date-range picker
    Table.jsx             results, sorted by snowfall
    Chart.jsx             cumulative curves, top five
    Radar.jsx             12 resorts x 16 days heat grid
    Detail.jsx            per-resort bottom sheet
    Trips.jsx             saved windows
    Dot.jsx               warning dot
  lib/
    constants.js          thresholds and horizons
    units.js              imperial <-> metric, display formatting
    dates.js              ISO date helpers, midday-anchored
    openMeteo.js          request building, response shaping, fetch
    scoring.js            window scoring and warning flags
  data/
    resorts.json          the resort list — PROVISIONAL, see below
docs/
  HANDOFF.md              the original project handoff
  DESIGN.md               visual direction and information architecture
  DATA.md                 data source, derived metrics, thresholds
  OPEN-ITEMS.md           what's unresolved, with current state of each
  archive/Tabulator.v3.jsx  the single-file build this was split from
```

---

## Data

One Open-Meteo request covers all 23 resorts via comma-separated coordinates.
`past_days=3` is load-bearing — it feeds the **before** column, the snow that
fell in the three days prior to the window. Today sits at index 3 in the
combined series. Full detail in [`docs/DATA.md`](docs/DATA.md).

---

## The resort list

`src/data/resorts.json` was extracted from the hard-coded constant in the
previous single-file build, then **reconciled against the source spreadsheet**
("Tafel's Ski Tabulator 2025+") on 2026-08-20.

- **Membership checks out.** All 23 resorts match the sheet exactly — same
  names, same order, same ten regions. The sheet writes `BigSky` as one word;
  `Big Sky` is kept here.
- **Coordinates and elevations do not.** Every entry still carries
  `"verified": false`. The sheet holds no geographic data at all — it scraped by
  resort name — so it can never verify them. That needs a different source.
  Open item #5.

## What this deliberately does not do

- **Photography or resort imagery.** Out of scope by design.
- **Scrape OpenSnow / Snow-Forecast.com.** No open APIs, and they block
  cross-origin requests — which is exactly why the original spreadsheet broke.
- **Present anything past ~7 days as reliable.** The app fetches 16 days and
  says plainly that the far end is a shape, not a promise. Keep that honesty.
