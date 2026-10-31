/* The weather strip in the maximized resort sheet.
 *
 * Source is the US National Weather Service, api.weather.gov. Brian:
 * "we'll need to build a URL list of that data, which is pulling from
 * weather.gov. We will need to get the ski resort data, not the town data."
 *
 * We do, and it is worth saying how, because it is the whole reason this
 * works: NWS is not a place-name API. You hand it a COORDINATE —
 * /points/{lat},{lon} — and it answers for the ~2.5km grid cell that
 * coordinate falls in. Give it the mountain and you get the mountain.
 * Snowbird's base coordinate comes back labelled "Snowbird UT, elevation
 * 9,298 ft" rather than Salt Lake City, four thousand feet below it.
 *
 * Two limits, both real:
 *   - NWS is UNITED STATES ONLY. The four Canadian resorts (Revelstoke,
 *     Whistler, Lake Louise, Kicking Horse) come from Environment Canada
 *     instead (scripts/eccc.js, 2026-10-31): the forecast for the nearest
 *     town, mapped into this same shape, so this file treats both alike.
 *   - 2.5km is a grid cell, not a summit. It is the mountain's neighbourhood
 *     at roughly the right elevation, which is the useful answer, but it is
 *     not a point forecast for the top of the tram.
 */

import { WX_ICONS } from "./wx-icons.js";

/** NWS writes prose, not codes. Its `shortForecast` is a human phrase —
 *  "Heavy Snow", "Chance Rain Showers then Slight Chance Snow Showers" — so
 *  the mapping is ordered and first-match-wins, worst-and-most-specific
 *  first. Snow beats rain in a mixed phrase because snow is the thing this
 *  app exists to find; "blizzard" beats plain "snow" because it is worse.
 *
 *  Anything unmatched falls to `cloudy` rather than to nothing: a missing
 *  icon in a six-column row reads as a broken build, and "we are not sure"
 *  is closer to cloudy than to sunshine. */
const ICON_RULES = [
  [/blizzard/i, "snow--blizzard"],
  [/heavy snow|snow at times heavy/i, "snow--heavy"],
  [/wintry|freezing rain|ice pellet/i, "wintry-mix"],
  [/sleet/i, "sleet"],
  // Rain and snow together: Carbon's sleet glyph is a snowflake beside rain
  // streaks. Must sit above the plain snow rules, which would claim it.
  [/rain\s+(and|&)\s+snow|snow\s+(and|&)\s+rain/i, "sleet"],
  [/blowing snow|snow.*wind|wind.*snow/i, "windy--snow"],
  // Environment Canada: "Chance of rain showers or wet flurries".
  [/rain.*(or|and).*flurr|flurr.*(or|and).*rain|wet flurr/i, "sleet"],
  [/scattered.*snow|snow shower|isolated.*snow|chance.*(snow|flurr)|periods of snow/i, "snow--scattered"],
  [/snow|flurr/i, "snow"],
  [/heavy rain|t-storm|thunderstorm/i, "rain--heavy"],
  [/drizzle/i, "rain--drizzle"],
  [/scattered.*(rain|shower)|isolated.*(rain|shower)|chance.*(rain|shower)|rain shower/i, "rain--scattered"],
  [/rain|showers/i, "rain"],
  [/wind|breezy|blustery/i, "windy--strong"],
  // Environment Canada writes "a mix of sun and cloud", "a few clouds",
  // "mainly sunny", "cloudy periods" where the NWS writes "partly cloudy".
  [/mostly sunny|partly cloudy|mix of sun and cloud|a few clouds|mainly sunny/i, "partly-cloudy"],
  [/mostly cloudy|partly sunny|cloudy periods|mainly cloudy|increasing cloudiness/i, "mostly-cloudy"],
  [/sunny|clear|fair/i, "sun"],
  [/cloud|overcast|fog|haze/i, "cloudy"],
];

export function iconFor(shortForecast) {
  /* The FIRST clause only, matching shortLabel(). "Sunny then Isolated
     T-storms" was drawing a heavy-rain cloud over the word "Sunny" — the
     icon and the label have to describe the same half of the day or the
     column contradicts itself. */
  const t = firstClause(shortForecast);
  for (const [re, name] of ICON_RULES) if (re.test(t)) return name;
  return "cloudy";
}

const firstClause = (s) => String(s ?? "").split(/\s+then\s+/i)[0].trim();

export const iconPaths = (name) => WX_ICONS[name] ?? WX_ICONS.cloudy;

/** NWS phrases run long — "Slight Chance Rain Showers then Mostly Cloudy" is
 *  fifty characters into a column sixty-seven wide. The design gives each
 *  column two lines, so the label has to be short enough to land in them.
 *
 *  Cutting at "then" rather than truncating: a compound phrase describes a
 *  change through the day, and the FIRST half is the one the icon is drawn
 *  from, so keeping them in step matters more than completeness. The rest of
 *  the phrase survives as the cell's title attribute. */
export function shortLabel(shortForecast) {
  if (!shortForecast) return "—";
  let t = firstClause(shortForecast);
  t = t.replace(/^(a )?(slight chance of|chance of|periods of)\s+/i, ""); // Environment Canada
  t = t.replace(/^(Slight Chance|Chance|Isolated|Scattered|Likely)\s+/i, "");
  t = t.replace(/^a (mix of sun and cloud)$/i, "$1").replace(/^a few clouds$/i, "few clouds");
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** NWS returns alternating day and night periods, and the design wants one
 *  column per DAY carrying both numbers. A period is a day when
 *  `isDaytime`, so the high comes from the day and the low from the night
 *  that follows it.
 *
 *  The first period is often a night — you open the app in the evening — and
 *  that night has no day of its own. It is dropped rather than rendered as a
 *  half-empty column: a column with a low and no high is a column that looks
 *  like a bug. */
export function toDays(periods, limit = 6) {
  const out = [];
  for (let i = 0; i < (periods?.length ?? 0); i++) {
    const p = periods[i];
    if (!p.isDaytime) continue;
    const night = periods[i + 1];
    out.push({
      date: (p.startTime ?? "").slice(0, 10),
      name: p.name,
      short: p.shortForecast,
      icon: iconFor(p.shortForecast),
      hi: typeof p.temperature === "number" ? p.temperature : null,
      lo: night && !night.isDaytime && typeof night.temperature === "number" ? night.temperature : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---- The same row, from Snow-Forecast instead ----------------------- *
 * Settings can switch the row's source. Snow-Forecast writes a sky per
 * period in its own shorthand — "mod. snow", "snow shwrs", "some clouds" —
 * so each phrase is translated into the NWS wording the icons and labels
 * already understand, rather than given a second set of rules. */
const SF_WORDS = [
  [/^clear/i, "Clear"],
  [/some clouds|part cloud/i, "Partly Cloudy"],
  [/^cloudy|overcast/i, "Cloudy"],
  [/heavy snow/i, "Heavy Snow"],
  [/mod\.? snow/i, "Snow"],
  [/light snow/i, "Light Snow"],
  [/snow shwrs|snow showers/i, "Snow Showers"],
  [/sleet/i, "Sleet"],
  [/freezing|wintry|mixed/i, "Wintry Mix"],
  [/thunder/i, "Thunderstorms"],
  [/heavy rain/i, "Heavy Rain"],
  [/mod\.? rain/i, "Rain"],
  [/light rain|drizzle/i, "Light Rain"],
  [/rain shwrs|rain showers/i, "Rain Showers"],
];

export function sfSky(phrase) {
  const t = String(phrase ?? "").trim();
  if (!t) return null;
  for (const [re, words] of SF_WORDS) if (re.test(t)) return words;
  // Unknown shorthand: spell it out as best we can and let the icon fall to cloudy.
  return t.replace(/shwrs/gi, "showers").replace(/\bmod\.\s*/gi, "").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* Which sky a DAY gets when its morning and afternoon differ: the worse one,
   because that is the half of the day that decides whether you go. */
const SEVERITY = [
  "snow--blizzard", "snow--heavy", "wintry-mix", "sleet", "windy--snow", "snow",
  "snow--scattered", "rain--heavy", "rain", "rain--scattered", "rain--drizzle",
  "windy--strong", "cloudy", "mostly-cloudy", "partly-cloudy", "sun",
];
const rankOf = (sky) => {
  const i = SEVERITY.indexOf(iconFor(sky));
  return i === -1 ? SEVERITY.length : i;
};

const toF = (c) => (typeof c === "number" ? Math.round((c * 9) / 5 + 32) : null);

/** Snow-Forecast days, in the same shape toDays() gives for NWS: one column
 *  per day, °F, so the sheet draws both sources with the same markup. The
 *  daytime periods choose the sky; the night only stands in when a day has
 *  no daytime left in the table (the evening of the first day). */
export function sfDays(days, limit = 6) {
  const out = [];
  for (const d of days ?? []) {
    if (!d?.date) continue;
    const ps = d.periods ?? [];
    const daytime = ps.filter((p) => p.name !== "night" && p.phrase);
    const pool = daytime.length ? daytime : ps.filter((p) => p.phrase);
    const skies = pool.map((p) => sfSky(p.phrase)).filter(Boolean);
    if (!skies.length) continue;
    const short = skies.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a));
    out.push({ date: d.date, name: d.date, short, icon: iconFor(short), hi: toF(d.tempMax), lo: toF(d.tempMin) });
    if (out.length >= limit) break;
  }
  return out;
}
