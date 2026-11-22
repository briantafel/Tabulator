/* One-off probe of Environment Canada's open API (api.weather.gc.ca): prints the real field names, then
 * for each Canadian resort the stations inside a 0.4° box and how much snow data each has for 2024-25.
 * Run from Actions only (the dev sandbox can't reach the host). Not part of the archive run. */
import { readFileSync } from "node:fs";
import { UA, coordsOf } from "./common.js";
const B = "https://api.weather.gc.ca/collections";
const get = async (u) => { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const out = (s) => console.log(s);
const resorts = JSON.parse(readFileSync("src/data/resorts.json", "utf8")).filter((r) => r.region === "Canada");

const st = await get(`${B}/climate-stations/items?limit=1&f=json`);
out("STATION SAMPLE " + JSON.stringify(st.features?.[0]?.properties));
const dl = await get(`${B}/climate-daily/items?limit=1&f=json&CLIMATE_IDENTIFIER=1108447`);
out("DAILY SAMPLE " + JSON.stringify(dl.features?.[0]?.properties));
out("DAILY sample count " + dl.numberMatched);

for (const r of resorts) {
  const c = coordsOf(r); if (!c) continue;
  const [lat, lon] = c, d = 0.4;
  const j = await get(`${B}/climate-stations/items?f=json&limit=200&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`);
  const rows = [];
  for (const f of j.features ?? []) {
    const p = f.properties, id = p.CLIMATE_IDENTIFIER;
    let n = 0, snow = 0, last = "";
    try {
      const q = await get(`${B}/climate-daily/items?f=json&limit=1&CLIMATE_IDENTIFIER=${id}&datetime=2024-11-01/2025-04-30&sortby=-LOCAL_DATE`);
      n = q.numberMatched ?? 0; last = q.features?.[0]?.properties?.LOCAL_DATE ?? "";
      if (n) { const s = await get(`${B}/climate-daily/items?f=json&limit=1&CLIMATE_IDENTIFIER=${id}&datetime=2024-11-01/2025-04-30&TOTAL_SNOW=0.1/&sortby=-LOCAL_DATE`).catch(() => null); snow = s?.numberMatched ?? -1; }
    } catch (e) { last = "ERR " + e.message.slice(0, 40); }
    rows.push(`${id} ${p.STATION_NAME} elev=${p.ELEVATION} days=${n} snowdays=${snow} last=${last}`);
  }
  out(`RESORT ${r.id} (${lat},${lon}) stations in box: ${rows.length}`); rows.forEach((x) => out("   " + x));
}
