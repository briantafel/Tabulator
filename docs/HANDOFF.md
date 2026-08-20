# Tabulator — project handoff

Read this first, then `Tabulator.jsx` and `resorts.json`. Ask me questions before writing code.

---

## What this is

A ski trip decision tool. The question it answers is **"I can take these days off — where should I go?"** Not "what's the weather at Alta." The comparison across resorts, scoped to a specific date window, is the whole product.

Owner: Brian Tafel. Personal project.

---

## Where it came from

Three artifacts exist, in this order:

1. **`Tafel's Ski Tabulator 2025+`** — a Google Sheet, the working original. 23 resorts grouped by region, with columns for snowfall at 1 / 3 / 6 days out, high temp, low temp, max wind. Currently broken: every temp cell reads `#NUM!` and several wind cells read `#VALUE!` because the scraping formulas in the `DataIngest` tab have failed. Other tabs: `AllResorts`, `2020TripSnowfallChart`, `GraphData`, `OLD RawData`.  
     
2. **A Figma Make prototype** — "Ski Snow Forecast App." Mobile-first, iPhone 16 Pro frames, Vite \+ React \+ Tailwind on shadcn/ui. This is the source of truth for **visual direction and information architecture**.  
     
3. **`Tabulator.jsx`** — the current build, in this folder. Single-file React component. Live data, prototype's visual language.

---

## Design direction (from the Figma prototype — follow this)

- **Light.** White background, near-black ink. Not dark mode.  
- **One accent:** coral red, roughly `#EF4A38`. Used for the leading resort, the active tab, the selected date, and warning dots. Nothing else gets color.  
- **One typeface,** heavy grotesque, tight tracking. The prototype reads as Helvetica Now / SF Pro; the build uses Inter Tight 600–800 as a stand-in. **Substituting the real face is an open item.**  
- **Minimal chrome.** No cards, no borders, no dividers except hairline table rules. Generous whitespace.  
- **Pill toggles**, black active / light gray inactive. Arrow `→` advances.  
- **Photography is explicitly out of scope.** Don't add imagery.

### Information architecture

Bottom tab bar, three tabs: **trips / mountains / radar**. Mountains is the default and the core.

**Mountains** — pick a window, then see results.

- Two picking modes, toggled by the pill:  
  - *Days:* a horizontal number wheel. "Find me snow in **4** days." Selected numeral centered and black, neighbors ghosted and bleeding off both edges. This is the signature interaction — keep it.  
  - *Calendar:* a month grid, no weekday headers. Tap a start date, tap an end date. Dates outside the forecast horizon are ghosted and disabled.  
- Results appear below as two swipeable pages with dot pagination: a **table** and a **cumulative curves chart**.

**Radar** — a heat grid, 12 resorts × 16 days, coral opacity scaled to daily snowfall. Shows where and when storms land before you've committed to dates. Tapping a column starts a trip on that date. *This was my addition, not in the prototype — it replaced an earlier "storm strip" concept. Feel free to challenge it.*

**Trips** — saved windows. Currently in-memory only.

---

## Data

**Source: Open-Meteo.** Free, no API key, CORS-friendly, returns JSON. One request covers all 23 resorts via comma-separated coordinates.

This was a deliberate departure from the original spec. Brian wanted to scrape specific sites (OpenSnow, Snow-Forecast.com, resort pages). Those have no open APIs and block cross-origin requests, so a browser-based app can't reach them — which is exactly why the spreadsheet broke. Open-Meteo serves the same underlying model output those sites repackage.

**The trade-off, stated plainly:** you lose human forecaster commentary. You gain something that doesn't break on a site redesign.

Request shape:

https://api.open-meteo.com/v1/forecast

  ?latitude=\<23 comma-separated\>

  \&longitude=\<23 comma-separated\>

  \&elevation=\<23 comma-separated\>   // mid-mountain, in metres

  \&daily=snowfall\_sum,precipitation\_sum,temperature\_2m\_max,temperature\_2m\_min,wind\_speed\_10m\_max

  \&past\_days=3\&forecast\_days=16

  \&timezone=auto

  \&temperature\_unit=fahrenheit\&wind\_speed\_unit=mph\&precipitation\_unit=inch

`past_days=3` is load-bearing — it feeds the "before" column. Today sits at index 3 in the combined series.

### Derived metrics

| Metric | How it's computed | Why it matters |
| :---- | :---- | :---- |
| **before** | Snowfall in the 3 days *prior* to window start | The base you're landing on. 20" on rock ≠ 20" on 20". From the prototype. |
| **snow** | Sum of `snowfall_sum` across the window | The headline number. |
| **temp** | Max of `temperature_2m_max` across window | Warm days mean unreliable precipitation. |
| **wind** | Max of `wind_speed_10m_max` across window | Lift holds. |

### Warning thresholds

- Red dot — max temp ≥ 34°F, **or** max wind ≥ 35 mph  
- Amber dot — min temp ≤ 0°F

**Open design question.** In the prototype these three conditions used two colors with no key, so a red dot meant "too windy" in one column and "too warm" in another. The current build keeps that encoding but adds a one-line key and reserves amber strictly for cold — so red reads as *bad in a warm way* and amber as *bad in a cold way*. Brian hasn't ruled on this. It's the only place in the design that needs explaining, which is a smell.

---

## Resort list

`resorts.json` holds the 23 from the spreadsheet, grouped by region: California, Colorado, Utah, Wyoming, Idaho, Montana, New Mexico, Canada, New York, Vermont.

**Note the discrepancy:** the Figma prototype shows Park City, Ski Arlberg, and Mount Baker, which aren't in the sheet. So the resort set is meant to be user-editable, and the current build's hard-coded list is a placeholder. Ski Arlberg also implies Europe, which the sheet doesn't cover.

Coordinates and elevations are mid-mountain approximations. **They have not been verified against resort data** — worth checking, since elevation materially changes the snowfall figure Open-Meteo returns.

---

## Open items

1. **Real typeface.** Inter Tight is standing in for whatever the prototype actually specifies.  
2. **Editable resort list.** Add / remove / reorder, persisted.  
3. **Persistence.** Saved trips and the resort list are in-memory. Needs real storage.  
4. **The warning-dot encoding** — see above.  
5. **Verify coordinates and elevations** against resort sources.  
6. **Europe.** If Ski Arlberg is in, the region model needs a continent level.  
7. **Freezing level.** Currently inferred from max temp. Open-Meteo exposes `freezing_level_height` hourly, which would be more honest about rain-vs-snow but adds payload across 23 locations.

## Not doing

- Photography or resort imagery.  
- Scraping OpenSnow / Snow-Forecast.com — see Data above.  
- Anything past a \~7-day horizon presented as reliable. The app fetches 16 days; the footer says plainly that the far end is a shape, not a promise. Keep that honesty.

---

## Suggested first move in Cowork

Read the directory, then set up a real project scaffold — Vite \+ React, `resorts.json` as a data file rather than a constant, and the component split into `DaysWheel`, `MonthGrid`, `Table`, `Chart`, `Radar`, `Detail`. `Tabulator.jsx` is currently one file because it was built as a chat artifact; that constraint is gone now.  
