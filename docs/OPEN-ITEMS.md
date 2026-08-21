# Open items

Status as of the Snow-Forecast wiring pass, 2026-08-21.

---

## 1. Real typeface — OPEN

Inter Tight 600–800 stands in for whatever the prototype specifies (it reads as
Helvetica Now / SF Pro). The Figma design file contains a **numeral specimen
`123456789` in the real face** — mine that rather than guessing.

The font moved from runtime JS injection to a `<link>` in `index.html`, so
swapping it is a two-line change.

## 2. Editable resort list — OPEN

Add / remove / reorder, persisted. `src/data/resorts.json` is now keyed by
Snow-Forecast slug, which makes this *harder* than it was under Open-Meteo:
adding a resort means finding its slug, and slugs follow no pattern. Any UI for
this needs slug validation — fetch the page, check for a `.forecast-table__table`
— or users will silently add resorts that never return data.

## 3. Persistence — OPEN

Saved trips are in-memory. Unit preference is too, and resets on reload.

## 4. Warning-dot encoding — PARTLY ADDRESSED, not ruled on

Brian deferred this. The Figma turned out to have most of an answer: the header
reads `-3 days | snow | ↑ temp | ↑ wind`, and those **↑ arrows carry the
"this is a maximum" meaning** the old build spelled out in the key. Those labels
are now implemented.

Still unresolved: red means "too warm" in one column and "too windy" in another,
which is the bit that needs a key. Now partly mitigated by
`rainRisk()` — freezing level against the mid station gives a *specific*
statement ("expect rain, not snow") in the detail sheet, rather than a red dot
that needs decoding.

## 5. Verify coordinates and elevations — CLOSED

Dissolved rather than solved. Snow-Forecast addresses resorts by slug and
elevation *tier* (top/mid/bot), and **publishes the tier elevations on the
page**, so the parser reads them. Coordinates and elevations are gone from
`resorts.json` entirely — there is nothing left to verify.

For the record, the old guesses were off by up to ~290m against the real mid
stations, which materially affects a model's snowfall figure.

## 6. Europe — OPEN

The Figma shows Ski Arlberg, which implies a continent level in the region
model. Snow-Forecast covers Europe, so the data side is free; it is a UI and
data-model question, not a sourcing one.

## 7. Freezing level — CLOSED

Snow-Forecast publishes `freezing-level` per period. The parser captures it,
`score()` reduces it to a window minimum, and `rainRisk()` compares it against
the resort's mid-station elevation. Rain-vs-snow is now read rather than
inferred from max temperature.

---

## Recently closed

- **Inch mark in metric mode** — `snowTxt()` converted correctly but four call
  sites appended a literal `"` regardless of unit. Fixed by `snowWithUnit()`,
  which owns the unit. Pinned by a unit test and a browser check.
- **Silent staleness** — a forecast older than 26 hours now shows a banner, and
  synthetic sample data is labelled. The spreadsheet rotted for months because
  broken and quiet looked identical; the app should not repeat that.
- **`-3 days` had no source** after Open-Meteo was dropped. Now accumulated
  from our own scrape archive (`public/history.json`) rather than a second
  provider. Reads `—` for the first three days after deployment, and `before()`
  returns null rather than 0 when the archive is short — a missing base and a
  bare mountain are the same number and opposite decisions.

## Still undecided

**Does radar earn its tab at six days?** It was built to spot a storm before
committing to dates, which needed the 16-day horizon. At six it shows the shape
of this week. Brian flagged it as challengeable before this came up.
