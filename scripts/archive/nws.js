/* ------------------------------------------------------------------ *
 * National Weather Service gridpoint forecasts for the US resorts.
 *
 * The app shows NWS's text forecast. The archive keeps the gridpoint data
 * behind it, which carries what the text leaves out: forecast snowfall
 * amounts, liquid precipitation and snow level, each with its own time
 * window — and a real issue time (`updateTime`), which Snow-Forecast and
 * Open-Meteo do not give.
 *
 * Same point as the app: each resort's `nws` coordinate, mid-slope.
 * ------------------------------------------------------------------ */

import { fetchText, saveRaw, sleep } from "./common.js";

export const PARSER_VERSION = "nws-grid-1";
const API = "https://api.weather.gov";
const DELAY_MS = 1000;
const MIN_OK_RATIO = 0.8;

/* gridpoint layer → archive variable, and the unit NWS must send it in. */
const LAYERS = {
  snowfallAmount: { variable: "snow", uom: "wmoUnit:mm", unit: "cm", scale: 0.1 },
  quantitativePrecipitation: { variable: "precip", uom: "wmoUnit:mm", unit: "mm", scale: 1 },
  snowLevel: { variable: "snow_level", uom: "wmoUnit:m", unit: "m", scale: 1 },
  temperature: { variable: "temp", uom: "wmoUnit:degC", unit: "C", scale: 1 },
  windSpeed: { variable: "wind_speed", uom: "wmoUnit:km_h-1", unit: "km/h", scale: 1 },
  windGust: { variable: "wind_gust", uom: "wmoUnit:km_h-1", unit: "km/h", scale: 1 },
  probabilityOfPrecipitation: { variable: "precip_probability", uom: "wmoUnit:percent", unit: "%", scale: 1 },
  skyCover: { variable: "sky_cover", uom: "wmoUnit:percent", unit: "%", scale: 1 },
};

/** "2026-10-29T18:00:00+00:00/PT6H" → [startIso, endIso]. ISO 8601 durations
 *  here are days and hours only (P1DT6H, PT12H). */
export function validRange(validTime) {
  const [start, dur] = validTime.split("/");
  const m = dur?.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) throw new Error(`unreadable validTime "${validTime}"`);
  const ms = ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 60e3;
  const s = Date.parse(start);
  return [new Date(s).toISOString(), new Date(s + ms).toISOString()];
}

export function gridToRows(json, { resort, lat, lon, fetchedAt, runId }) {
  const p = json?.properties;
  if (!p) throw new Error("no properties in gridpoint response");
  const issued = p.updateTime ? new Date(p.updateTime).toISOString() : null;
  const elevation = typeof p.elevation?.value === "number" ? Math.round(p.elevation.value) : null;
  const rows = [];
  for (const [layer, spec] of Object.entries(LAYERS)) {
    const l = p[layer];
    if (!l?.values) continue;
    if (l.uom && l.uom !== spec.uom) throw new Error(`${layer} came back in ${l.uom}, expected ${spec.uom}`);
    for (const v of l.values) {
      if (typeof v.value !== "number") continue;
      const [start, end] = validRange(v.validTime);
      rows.push({
        source: "nws", kind: "forecast", resort_id: resort.id, elevation_m: elevation, lat, lon,
        station_id: `${p.gridId}/${p.gridX},${p.gridY}`, issued_at: issued, fetched_at: fetchedAt,
        valid_start: start, valid_end: end, variable: spec.variable,
        value: Number((v.value * spec.scale).toFixed(3)), unit: spec.unit,
        run_id: runId, parser_version: PARSER_VERSION,
      });
    }
  }
  return rows;
}

export async function collect({ resorts, sink, rawDir, fetchedAt, runId, log }) {
  const wanted = resorts.filter((r) => Array.isArray(r.nws));
  let ok = 0;
  const failures = [];
  const headers = { Accept: "application/geo+json" };
  for (const resort of wanted) {
    const [lat, lon] = resort.nws;
    try {
      const pt = await fetchText(`${API}/points/${lat},${lon}`, { retries: 3, delayMs: DELAY_MS * 2, headers });
      if (pt.status !== 200) throw new Error(`points HTTP ${pt.status}`);
      const gridUrl = JSON.parse(pt.text)?.properties?.forecastGridData;
      if (!gridUrl) throw new Error("no forecastGridData URL for this point");
      await sleep(DELAY_MS);
      const g = await fetchText(gridUrl, { retries: 3, delayMs: DELAY_MS * 2, headers });
      if (g.status !== 200) throw new Error(`gridpoint HTTP ${g.status}`);
      await saveRaw(`${rawDir}/${resort.id}.json.gz`, g.text);
      const rows = gridToRows(JSON.parse(g.text), { resort, lat, lon, fetchedAt, runId });
      if (!rows.length) throw new Error("gridpoint parsed to zero rows");
      rows.forEach((r) => sink.write(r));
      ok++;
    } catch (e) {
      failures.push(`${resort.id}: ${e.message}`);
      log(`  ✗ nws ${resort.id} — ${e.message}`);
    }
    await sleep(DELAY_MS);
  }
  log(`nws: ${ok}/${wanted.length} resorts`);
  return { ok: ok / wanted.length >= MIN_OK_RATIO, resorts: ok, tried: wanted.length, failures };
}
