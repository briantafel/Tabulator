/* Environment and Climate Change Canada — the four Canadian resorts'
 * forecast and alerts, in the same shape weather.json already uses for the
 * NWS, so the resort sheet, the storm word and the read-out need no
 * Canadian special case.
 *
 * Brian, 2026-10-30: "for Canada, don't they have an equivalent to NWS? If
 * so let's please query and use that … across the app, even in the
 * editorial." They do: the Meteorological Service of Canada's GeoMet API,
 * open data under the Open Government Licence – Canada.
 *
 *   forecast  api.weather.gc.ca/collections/citypageweather-realtime/items/{site}
 *   alerts    api.weather.gc.ca/collections/weather-alerts/items?bbox=…
 *
 * Unlike NWS, the forecast is for a named place, not a coordinate: the
 * town nearest each resort (resorts.json `eccc.site`). It describes the
 * valley, not the summit. The alerts ARE by coordinate — each alert is a
 * polygon, and a tiny box at the resort's own lat/lon finds the ones that
 * cover it.
 *
 * Shapes read from real responses saved on Brian's Mac, 2026-10-31 (the
 * sandbox cannot reach api.weather.gc.ca, and its robots.txt keeps fetchers
 * out): test/fixtures/eccc-*.json.
 */

export const ECCC = "https://api.weather.gc.ca";

const en = (v) => (v && typeof v === "object" && "en" in v ? v.en : v);
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "GMT-07:00" → -420 minutes, for an IANA zone at an instant. */
function offsetMinutes(tz, at) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}
const pad = (n) => String(n).padStart(2, "0");
const isoAt = (ymd, hour, offMin) => {
  const sign = offMin < 0 ? "-" : "+";
  const a = Math.abs(offMin);
  return `${ymd}T${pad(hour)}:00:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};
const localYmd = (at, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dowOf = (ymd) => DOW[new Date(`${ymd}T12:00:00Z`).getUTCDay()];

/**
 * One city-page feature → weather.json periods, NWS-shaped:
 *   { name, isDaytime, temperature (°F), shortForecast, detailedForecast, startTime }
 * ECCC gives each period a name ("Tonight", "Saturday", "Saturday night")
 * but no time, so the dates are walked forward from the issue time.
 */
export function ecccPeriods(feature, tz) {
  const p = feature?.properties ?? {};
  const fg = p.forecastGroup ?? {};
  const issued = new Date(en(fg.timestamp) ?? p.lastUpdated ?? Date.now());
  let ymd = localYmd(issued, tz);
  const out = [];
  for (const f of fg.forecasts ?? []) {
    const name = en(f.period?.textForecastName) ?? "";
    const night = /night/i.test(name);
    const dayName = DOW.find((d) => name.startsWith(d));
    if (dayName) {
      // Walk to the next date with that weekday name (today counts).
      for (let i = 0; i < 7 && dowOf(ymd) !== dayName; i++) ymd = addDays(ymd, 1);
    }
    const temp = (f.temperatures?.temperature ?? []).map((t) => en(t.value)).find((v) => typeof v === "number");
    const at = new Date(`${ymd}T12:00:00Z`);
    out.push({
      name: name.replace(/ night$/, " Night"),
      isDaytime: !night,
      temperature: typeof temp === "number" ? Math.round((temp * 9) / 5 + 32) : null,
      shortForecast: en(f.abbreviatedForecast?.textSummary) ?? "",
      detailedForecast: en(f.textSummary) ?? "",
      startTime: isoAt(ymd, night ? 18 : 6, offsetMinutes(tz, at)),
    });
  }
  return out;
}

/* Winter alerts only — an air-quality warning is not a snowstorm. Grey
   "special weather statements" are kept too: they are how ECCC flags a
   storm that does not yet meet warning level. */
const WINTER = /snow|winter|blizzard|freezing|squall|weather statement/i;
const title = (s) => String(s ?? "").replace(/\b\w/g, (c) => c.toUpperCase());

/** Alert features → weather.json alerts, NWS-shaped: { event, onset, ends, colour }. */
export function ecccAlerts(features) {
  return (features ?? [])
    .map((f) => f.properties ?? {})
    .filter((a) => WINTER.test(a.alert_name_en ?? "") && !/ended|cancel/i.test(a.status_en ?? ""))
    .map((a) => ({
      event: title(a.alert_name_en),          // "Snowfall Warning"
      colour: a.risk_colour_en ?? null,       // yellow | orange | red
      headline: (a.alert_text_en ?? "").split("\n")[0].slice(0, 200),
      onset: a.validity_datetime ?? a.publication_datetime ?? null,
      ends: a.event_end_datetime ?? a.expiration_datetime ?? null,
    }));
}

/** A box a few hundred metres across around the resort, for the alert query. */
export const pointBox = ([lat, lon], d = 0.005) => [lon - d, lat - d, lon + d, lat + d].map((n) => n.toFixed(4)).join(",");
