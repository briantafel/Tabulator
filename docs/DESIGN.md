# Design direction

From the Figma Make prototype ("Ski Snow Forecast App", mobile-first, iPhone 16
Pro frames). The prototype is the source of truth for visual direction and
information architecture.

## Rules

- **Light.** White background, near-black ink. Not dark mode.
- **One accent:** coral red, `#EF4A38`. It marks the leading resort, the active
  tab, the selected date, and warning dots. Nothing else gets colour.
- **One typeface,** heavy grotesque, tight tracking. The prototype reads as
  Helvetica Now / SF Pro; this build uses **Inter Tight 600–800 as a stand-in**.
  Substituting the real face is open item #1.
- **Minimal chrome.** No cards, no borders, no dividers except hairline table
  rules. Generous whitespace.
- **Pill toggles**, black active / light grey inactive. Arrow `→` advances.
- **Photography is explicitly out of scope.** Don't add imagery.

The chart series palette (`SERIES` in `lib/constants.js`) is the one sanctioned
exception to the single-accent rule, and it lives strictly inside the chart —
never in app chrome.

## Information architecture

Bottom tab bar, three tabs: **trips / mountains / radar**. Mountains is the
default and the core.

### Mountains

Pick a window, then see results.

Two picking modes, toggled by the pill:

- **Days** — a horizontal number wheel. "Find me snow in **4** days." The
  selected numeral is centred and black; neighbours are ghosted and bleed off
  both edges, so the range is felt rather than read. *This is the signature
  interaction — keep it.*
- **Calendar** — a month grid, no weekday headers. Tap a start date, tap an end
  date. Dates outside the forecast horizon are ghosted and disabled.

Results appear below as two pages with dot pagination: a **table** and a
**cumulative curves chart**.

### Radar

A heat grid, 12 resorts × 16 days, coral opacity scaled to daily snowfall.
Shows where and when storms land before you've committed to dates. Tapping a
column starts a trip on that date.

*Not from the prototype — this replaced an earlier "storm strip" concept. It is
explicitly open to being challenged.*

### Trips

Saved windows. In-memory only — open item #3.
