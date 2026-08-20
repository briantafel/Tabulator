/* A synthetic Open-Meteo response, shaped exactly like the live one.
 * Lets the smoke test run without network access and makes the numbers
 * predictable enough to assert on. */

import resortData from "../src/data/resorts.json" with { type: "json" };

const PAST = 3;
const HORIZON = 16;
const TOTAL = PAST + HORIZON; // 19 days

export function makeFixture(now = new Date("2026-08-20T12:00:00Z")) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - PAST);

  const time = Array.from({ length: TOTAL }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });

  return resortData.resorts.map((r, ri) => ({
    latitude: r.lat,
    longitude: r.lon,
    elevation: r.elev,
    timezone: "America/Denver",
    daily: {
      time,
      // Deterministic but varied: resort index shifts the curve so the
      // leaderboard has a stable, checkable order.
      snowfall_sum: time.map((_, i) => Number(((ri % 7) * 0.9 + (i % 5) * 0.4).toFixed(2))),
      precipitation_sum: time.map((_, i) => Number(((i % 4) * 0.1).toFixed(2))),
      temperature_2m_max: time.map((_, i) => 20 + ((ri + i) % 20)),
      temperature_2m_min: time.map((_, i) => -5 + ((ri + i) % 15)),
      wind_speed_10m_max: time.map((_, i) => 5 + ((ri * 3 + i) % 40)),
    },
  }));
}

export const EXPECTED_DAYS = TOTAL;
export const TODAY_INDEX = PAST;
