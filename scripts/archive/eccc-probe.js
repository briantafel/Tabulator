/* One-off diagnostic (Actions only): for every station in a 0.5° box around each Canadian resort, its daily date
 * range from the station layer and how many 2024-25 records actually hold snowfall, precipitation or depth. */
import { readFileSync } from "node:fs";
import { coordsOf } from "./common.js";
import { fetchDaily, fetchStations } from "./eccc-daily.js";
const resorts = JSON.parse(readFileSync("src/data/resorts.json", "utf8")).resorts.filter((r) => r.region === "Canada");
const km = ([a, b], [c, d]) => { const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2); return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); };
const all = await fetchStations(resorts);
const cache = new Map();
for (const r of resorts) {
  const c = coordsOf(r); if (!c) continue;
  const near = all.map((s) => ({ s, d: km(c, [s.lat, s.lon]) })).filter((x) => x.d <= 45).sort((a, b) => a.d - b.d);
  console.log(`RESORT ${r.id} ${near.length} stations within 45 km`);
  for (const { s, d } of near) {
    if (!cache.has(s.id)) {
      try { const { records } = await fetchDaily(s.id, "2024-11-01", "2025-04-30");
        const nn = (f) => records.filter((x) => x[f] !== null && x[f] !== undefined).length;
        cache.set(s.id, `rec=${records.length} snow=${nn("TOTAL_SNOW")} prec=${nn("TOTAL_PRECIPITATION")} depth=${nn("SNOW_ON_GROUND")}`);
      } catch (e) { cache.set(s.id, "ERR " + e.message.slice(0, 50)); }
    }
    console.log(`   ${s.id} ${s.name} ${d.toFixed(1)}km elev=${s.elevation_m} dly=${s.first}..${s.last} ${cache.get(s.id)}`);
  }
}
