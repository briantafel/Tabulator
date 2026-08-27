#!/usr/bin/env node
/* A weather.json for the DEMO snapshot only.
 *
 * The real one comes from api.weather.gov and covers whichever US resorts we
 * have coordinates for. That is right for the deployed app and wrong for the
 * demo twice over: NWS answers for today, so in August it reads 78F and
 * thunderstorms directly beneath sample snow bars showing a foot of powder,
 * and it covers one resort out of twenty-three.
 *
 * So the demo's strip is DERIVED FROM THE SAMPLE FORECAST rather than
 * invented beside it. Snow-Forecast's own numbers choose the icon and the
 * words, which means the strip and the bars above it always agree — a
 * "Heavy snow" column sits over a 12" bar because it was computed from it.
 * It is marked synthetic and rides inside a snapshot the app already labels
 * "Sample data, not a real forecast."
 *
 *   node scripts/make-demo-weather.js <forecast.json> <out.json>
 */
import { readFile, writeFile } from "node:fs/promises";

const inPath = process.argv[2] ?? new URL("../public/forecast.json", import.meta.url).pathname;
const outPath = process.argv[3] ?? "/tmp/demo-weather.json";
const IN = (cm) => cm / 2.54;
const F = (c) => (c * 9) / 5 + 32;

/* Snow-Forecast gives an amount and a wind; NWS gives a sky. This is the
   translation between them, in the direction we need for a demo. */
function sky(day) {
  const snow = IN(day.snow ?? 0);
  const wind = (day.windMax ?? 0) / 1.60934;
  if (snow >= 8 && wind >= 31) return "Blizzard Conditions";
  if (snow >= 8) return "Heavy Snow";
  if (snow >= 3) return "Snow Showers";
  if (snow >= 0.5) return "Light Snow";
  if (wind >= 25) return "Windy";
  if (snow > 0) return "Partly Cloudy";
  return "Mostly Cloudy";
}

const forecast = JSON.parse(await readFile(inPath, "utf8"));
const resorts = {};
for (const r of forecast.resorts) {
  const periods = [];
  for (const d of r.days.slice(0, 6)) {
    // The app reads day/night pairs, so the fixture has to be shaped like the
    // real feed rather than like the app's internal model.
    periods.push({
      name: d.date, isDaytime: true, startTime: `${d.date}T06:00:00-07:00`,
      temperature: Math.round(F(d.tempMax)), shortForecast: sky(d),
    });
    periods.push({
      name: `${d.date} night`, isDaytime: false, startTime: `${d.date}T18:00:00-07:00`,
      temperature: Math.round(F(d.tempMin)), shortForecast: sky(d),
    });
  }
  resorts[r.id] = { synthetic: true, periods };
}
await writeFile(outPath, JSON.stringify({
  generatedAt: forecast.generatedAt,
  synthetic: true,
  note: "Derived from the sample forecast so the strip agrees with the bars. NOT a real NWS forecast.",
  resorts,
}, null, 1));
console.error(`wrote ${outPath} — ${Object.keys(resorts).length} resorts`);
