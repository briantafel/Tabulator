import resortData from "../data/resorts.json" with { type: "json" };

/* Reads the static forecast.json that the scheduled scrape commits. No live
 * API call from the browser — Snow-Forecast blocks cross-origin requests,
 * which is exactly why the original spreadsheet approach could never have been
 * ported to a web app. See docs/SCRAPING.md. */

export const RESORT_META = resortData.resorts;

const base = () => (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";

async function getJson(path, fallback) {
  try {
    const res = await fetch(`${base()}${path}`, { cache: "no-cache" });
    if (!res.ok) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${path} — HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** A page can embed its data instead of fetching it — used to publish a
 *  self-contained snapshot that runs with no network at all. Falls through to
 *  the normal fetch when absent, so the deployed app is unaffected. */
const embedded = (key) =>
  typeof globalThis !== "undefined" ? globalThis[key] : undefined;

/** history.json is genuinely optional: for the first three days after
 *  deployment it does not exist yet, and "-3 days" correctly reads as unknown
 *  rather than zero. Absent history must never look like no snow. */
export async function loadForecast() {
  const preset = embedded("__TABULATOR_FORECAST__");
  const [forecast, history] = preset
    ? [preset, embedded("__TABULATOR_HISTORY__") ?? { days: {} }]
    : await Promise.all([getJson("forecast.json"), getJson("history.json", { days: {} })]);

  /* Skier reports are genuinely optional — a resort with none, or a scrape
     that has not run yet, must degrade to "no reports", never to an error. */
  const reports =
    embedded("__TABULATOR_REPORTS__") ??
    (preset ? { resorts: {} } : await getJson("reports.json", { resorts: {} }));

  /* Same contract as reports: optional everywhere. NWS is US-only, so most
     resorts will never have an entry here, and the sheet must render exactly
     as before for those rather than showing an empty strip. */
  const weather =
    embedded("__TABULATOR_WEATHER__") ??
    (preset ? { resorts: {} } : await getJson("weather.json", { resorts: {} }));

  if (!forecast?.resorts?.length) throw new Error("forecast.json has no resorts");

  return {
    generatedAt: forecast.generatedAt,
    stale: isStale(forecast.generatedAt),
    synthetic: !!forecast.synthetic,
    horizonDays: forecast.horizonDays ?? 6,
    dates: forecast.resorts[0].days.map((d) => d.date),
    resorts: forecast.resorts,
    history: history?.days ?? {},
    reports,
    weather,
  };
}

/** A scrape older than a day means the Action is failing. Say so in the UI
 *  rather than presenting stale numbers as current — the silent-rot failure
 *  mode is what killed the spreadsheet. */
export function isStale(generatedAt, now = new Date()) {
  if (!generatedAt) return true;
  const age = now - new Date(generatedAt);
  return !Number.isFinite(age) || age > 26 * 60 * 60 * 1000;
}
