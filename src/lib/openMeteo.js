import { PAST, HORIZON } from "./constants.js";
import resortData from "../data/resorts.json" with { type: "json" };

/* Open-Meteo: free, no key, CORS-friendly. One request covers every resort
 * via comma-separated coordinates. See docs/DATA.md for why this replaced
 * the original scraping approach. */

export const RESORTS = resortData.resorts;

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

export function buildUrl(resorts = RESORTS) {
  const p = new URLSearchParams({
    latitude: resorts.map((r) => r.lat).join(","),
    longitude: resorts.map((r) => r.lon).join(","),
    elevation: resorts.map((r) => r.elev).join(","),
    daily:
      "snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min,wind_speed_10m_max",
    timezone: "auto",
    past_days: String(PAST),
    forecast_days: String(HORIZON),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
  });
  return `${ENDPOINT}?${p}`;
}

export const shapeDays = (raw) => {
  const d = raw.daily;
  return d.time.map((t, i) => ({
    date: t,
    snow: d.snowfall_sum[i] ?? 0,
    precip: d.precipitation_sum[i] ?? 0,
    hi: d.temperature_2m_max[i],
    lo: d.temperature_2m_min[i],
    wind: d.wind_speed_10m_max[i],
  }));
};

/** Fetches every resort in one request. Open-Meteo returns a bare object for
 *  a single location and an array for many, so both shapes are normalised. */
export async function fetchForecast(resorts = RESORTS) {
  const res = await fetch(buildUrl(resorts));
  if (!res.ok) throw new Error(String(res.status));
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  return arr.map((x, i) => ({ ...resorts[i], all: shapeDays(x) }));
}
