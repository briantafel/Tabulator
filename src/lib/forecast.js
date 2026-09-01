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
/** Roll SAMPLE data so its window starts today.
 *
 *  Brian: "I'm not able to select today's date in the new calendar." The
 *  calendar disables every day the forecast has no numbers for, and the
 *  sample forecast in the repo is dated whenever it was last shaped — six
 *  days ago by the time he tried it. So today drew its red circle, correctly,
 *  and refused the tap, also correctly. Nothing was wrong with the calendar.
 *
 *  Re-dating the file would have fixed it until midnight. Sample data has no
 *  business being anchored to a date at all, so it is rolled at load time
 *  instead: every date, the history keys, the derived weather strip and the
 *  generated-at stamp all move by the same whole number of days, and the
 *  window opens on today for as long as the demo exists.
 *
 *  GATED ON `synthetic`. A real forecast is never touched — moving real dates
 *  would be inventing a forecast, and it would also silence the staleness
 *  banner, which is the one thing standing between a broken scrape and a
 *  spreadsheet that quietly rots. */
const DAY = 86400000;
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function rollSample(forecast, history, weather, now = new Date()) {
  if (!forecast?.synthetic) return { forecast, history, weather };
  const first = forecast.resorts?.[0]?.days?.[0]?.date;
  if (!first) return { forecast, history, weather };

  /* Both ends at midday LOCAL, so the difference is a whole number of days
     whatever the timezone and whatever the clock says. */
  const from = new Date(`${first}T12:00:00`);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const shift = Math.round((to - from) / DAY);
  if (!shift) return { forecast, history, weather };

  const move = (isoDate) => {
    const d = new Date(`${isoDate}T12:00:00`);
    d.setDate(d.getDate() + shift);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const rolled = {
    ...forecast,
    resorts: forecast.resorts.map((r) => ({
      ...r,
      days: r.days.map((d) => {
        const date = move(d.date);
        const at = new Date(`${date}T12:00:00`);
        // The scrape writes "Wednesday26"; a moved day needs its own name back.
        return { ...d, date, ...(d.label ? { label: `${WEEKDAY[at.getDay()]}${at.getDate()}` } : {}) };
      }),
    })),
  };
  if (forecast.generatedAt) {
    const g = new Date(forecast.generatedAt);
    if (!Number.isNaN(+g)) {
      g.setDate(g.getDate() + shift);
      rolled.generatedAt = g.toISOString();
    }
  }

  const days = {};
  for (const [k, v] of Object.entries(history?.days ?? {})) days[move(k)] = v;
  const rolledHistory = { ...history, days };

  /* The strip is derived from these very numbers, so it has to travel with
     them or a Tuesday column ends up over a Saturday bar. */
  const resorts = {};
  for (const [id, w] of Object.entries(weather?.resorts ?? {})) {
    resorts[id] = {
      ...w,
      periods: (w.periods ?? []).map((pd) => {
        const out = { ...pd };
        if (typeof pd.startTime === "string") {
          const t = new Date(pd.startTime);
          if (!Number.isNaN(+t)) { t.setDate(t.getDate() + shift); out.startTime = t.toISOString(); }
        }
        // `name` is the date for the sample feed and prose for the real one.
        if (typeof pd.name === "string") {
          const m = pd.name.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
          if (m) out.name = move(m[1]) + m[2];
        }
        return out;
      }),
    };
  }
  return { forecast: rolled, history: rolledHistory, weather: { ...weather, resorts } };
}

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

  const rolled = rollSample(forecast, history, weather);

  return {
    generatedAt: rolled.forecast.generatedAt,
    stale: isStale(rolled.forecast.generatedAt),
    synthetic: !!rolled.forecast.synthetic,
    horizonDays: rolled.forecast.horizonDays ?? 6,
    dates: rolled.forecast.resorts[0].days.map((d) => d.date),
    resorts: rolled.forecast.resorts,
    history: rolled.history?.days ?? {},
    reports,
    weather: rolled.weather,
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
