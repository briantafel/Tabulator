# Data

## Source: Open-Meteo

Free, no API key, CORS-friendly, returns JSON. One request covers all 23
resorts via comma-separated coordinates.

This was a deliberate departure from the original spec. The ask was to scrape
specific sites (OpenSnow, Snow-Forecast.com, resort pages). Those have no open
APIs and block cross-origin requests, so a browser-based app cannot reach them
— which is exactly why the spreadsheet broke. Open-Meteo serves the same
underlying model output those sites repackage.

**The trade-off, stated plainly:** you lose human forecaster commentary. You
gain something that doesn't break on a site redesign.

## Request shape

```
https://api.open-meteo.com/v1/forecast
  ?latitude=<23 comma-separated>
  &longitude=<23 comma-separated>
  &elevation=<23 comma-separated>        // mid-mountain, in metres
  &daily=snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max
  &past_days=3&forecast_days=16
  &timezone=auto
  &temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch
```

Built in `src/lib/openMeteo.js`.

`past_days=3` is **load-bearing** — it feeds the "before" column. Today sits at
index 3 in the combined series (`TODAY_IDX` in `lib/constants.js`).

Imperial is the stored unit throughout; the API is asked for °F, mph and inches
and conversion to metric happens only at the point of display, in `lib/units.js`.

## Derived metrics

Computed in `src/lib/scoring.js`.

| Metric | How it's computed | Why it matters |
| :--- | :--- | :--- |
| **before** | Snowfall in the 3 days *prior* to window start | The base you're landing on. 20" on rock ≠ 20" on 20". From the prototype. |
| **snow** | Sum of `snowfall_sum` across the window | The headline number. |
| **temp** | Max of `temperature_2m_max` across window | Warm days mean unreliable precipitation. |
| **wind** | Max of `wind_speed_10m_max` across window | Lift holds. |

## Warning thresholds

- **Red dot** — max temp ≥ 34°F, **or** max wind ≥ 35 mph
- **Amber dot** — min temp ≤ 0°F

How these are colour-coded is unresolved. See open item #4.
