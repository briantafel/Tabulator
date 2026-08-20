# Open items

Carried over from the handoff, with the current state of each after the
single-file build was split into a project.

---

### 1. Real typeface
Inter Tight 600–800 is standing in for whatever the prototype actually
specifies (it reads as Helvetica Now / SF Pro). The font is now loaded via a
`<link>` in `index.html` rather than injected from JavaScript at runtime, so
swapping it is a one-line change in two places: that link, and the
`font-family` on `.app` in `src/styles.css`.

**Status:** unchanged, but cheaper to act on.

---

### 2. Editable resort list
Add / remove / reorder, persisted.

`src/data/resorts.json` is now a real data file rather than a constant, and
each resort carries a stable `id` slug intended for exactly this. The list is
still read once at module load and never mutated.

**Status:** groundwork laid, feature not built.

---

### 3. Persistence
Saved trips and the resort list are in-memory and die with the tab.

**Status:** unchanged.

---

### 4. The warning-dot encoding
In the prototype these three conditions used two colours with no key, so a red
dot meant "too windy" in one column and "too warm" in another. The current
build keeps that encoding but adds a one-line key, reserving amber strictly for
cold — so red reads as *bad in a warm way* and amber as *bad in a cold way*.

It is the only place in the design that needs explaining, which is a smell.
An alternative worth weighing: let each column warn in its own terms and drop
the shared colour vocabulary entirely, removing the need for a key.

**Status:** explicitly deferred, not ruled on. Behaviour unchanged in the split.

---

### 5. Verify coordinates and elevations
Every entry in `resorts.json` carries `"verified": false`.

**Reconciled against the source sheet on 2026-08-20.** The result splits in two:

- **Membership is now confirmed.** All 23 resorts match "Tafel's Ski Tabulator
  2025+" exactly — same names, same order, same ten regions. Nothing added,
  nothing missing. The only difference is that the sheet writes `BigSky` as one
  word; `Big Sky` is kept here as the resort's actual name.
- **Geography still isn't.** The sheet contains no coordinates and no
  elevations — it scraped by resort *name*, not by lat/lon. So it cannot verify
  these values, and no amount of access to it ever will. This needs a different
  source: resort websites, OpenStreetMap, or a lift-served terrain dataset.

Elevation materially changes the snowfall figure Open-Meteo returns, so this is
not cosmetic.

**Status:** half-closed. Membership done; the 23 lat/lon/elev triples remain
unverified and now have no obvious source.

---

### 6. Europe
The Figma prototype shows Park City, Ski Arlberg, and Mount Baker, none of
which are in the list. Ski Arlberg implies Europe, which the sheet doesn't
cover. If it's in, the region model needs a continent level above region.

**Status:** unchanged.

---

### 7. Freezing level
Rain-vs-snow is currently inferred from max temperature. Open-Meteo exposes
`freezing_level_height` hourly, which would be more honest, but adds payload
across 23 locations.

**Status:** unchanged.

---

## Found during the split

Not acted on — the brief for this pass was structure, with behaviour held
constant. Recorded so they aren't lost.

- **The inch mark is hard-coded in metric mode.** `snowTxt()` converts the
  value to centimetres correctly, but several call sites append a literal `"`
  regardless of the unit setting — so metric users see `12.7"` where they
  should see `12.7cm`. Affects `Table.jsx`, `Detail.jsx`, `Trips.jsx`, and the
  `title` attribute in `Radar.jsx`.
- **`Detail` assumes a non-empty window.** `r.win[0].date` will throw if the
  window ever scores to zero days. Not currently reachable through the UI, but
  it is one off-by-one away from being so.
- **`iso()` formats via `toISOString()`, which is UTC.** Dates are anchored at
  midday to compensate, which holds for offsets within ±12h. It's a compensation
  rather than a fix.
- **The days-mode window silently clamps** at the end of the forecast horizon.
  Asking for 14 days when 12 remain returns 12 days without saying so.
