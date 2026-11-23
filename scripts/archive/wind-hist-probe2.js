/* Wind W2 probe, follow-up: (1) NWAC's station page code mentions csv, find the endpoint; (2) NCEI ISD for stations whose
 * history ended in 2025 or later (the first probe filtered on 2026 and found nothing). Read-only, run summary only. */
import { appendFileSync } from "node:fs";
import { UA, sleep } from "./common.js";
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
let failed = 0;
const get = async (url, timeout = 60000) => {
  try { const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) }); return { status: r.status, text: await r.text() }; }
  catch (e) { return { status: 0, text: "", err: e.message }; }
};
const head = (s, n = 300) => String(s).replace(/\s+/g, " ").slice(0, n);

say("## NWAC chunk scan\n");
const sp = await get("https://nwac.us/weather/stations/mt-baker-ski-area?range=graphs");
const chunks = [...new Set([...sp.text.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9_\-/.]+\.js/g)].map((m) => m[0]))];
const apiHits = new Set();
for (const c of chunks) {
  const r = await get("https://nwac.us" + c);
  for (const m of r.text.matchAll(/.{0,160}csv.{0,200}/gi)) say(`- ${c.split("/").pop()}: ${head(m[0], 360)}`);
  for (const m of r.text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/.]+|https?:\/\/[A-Za-z0-9.-]*(?:nwac|synoptic|mesowest)[A-Za-z0-9./_?=&-]*)["'`]/gi)) apiHits.add(m[1]);
  await sleep(150);
}
say("\nendpoint-like strings in chunks: " + ([...apiHits].slice(0, 40).join(" ; ") || "none"));
// the page's embedded data (Next flight payload) may carry the station id / data URL
const pay = sp.text.match(/.{0,120}(stationId|station_id|dataUrl|timeseries|measurements|"observations").{0,200}/gi) ?? [];
say("payload hints: " + head(pay.slice(0, 5).join(" || "), 1200));
for (const u of ["https://nwac.us/api/stations?limit=2", "https://nwac.us/api/weather-stations?limit=2", "https://nwac.us/api/measurements?limit=2", "https://nwac.us/api/observations?limit=2", "https://nwac.us/api/stations/mt-baker-ski-area"]) {
  const r = await get(u); say(`- ${u}: HTTP ${r.status} ${head(r.text, 200)}`);
}

say("\n## NCEI ISD (global-hourly) for stations in ISD with history ending 2025 or later\n");
const h = await get("https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv", 120000);
if (h.status !== 200) { say(`**FAILED** isd-history HTTP ${h.status}`); failed++; }
else {
  const rows = h.text.split("\n").map((l) => l.replace(/^"|"$/g, "").split('","'));
  say("| ICAO | id | name | ISD end | Jan-2025 week rows | rows with wind speed | rows with gust (OC1) |\n|---|---|---|---|---:|---:|---:|");
  for (const w of ["KTRK", "KTVL", "KCPW", "KCCU", "KBLU", "KASE", "KJAC", "KSUN", "KEKS", "KHCR", "KGUC", "KSLC"]) {
    const s = rows.filter((c) => c[5] === w && c[10] >= "20250101").sort((a, b) => (b[10] > a[10] ? 1 : -1))[0];
    if (!s) { say(`| ${w} | not in ISD with 2025+ end | | | | | |`); continue; }
    const d = await get(`https://www.ncei.noaa.gov/access/services/data/v1?dataset=global-hourly&stations=${s[0]}${s[1]}&startDate=2025-01-10T00:00:00Z&endDate=2025-01-17T00:00:00Z&dataTypes=WND,OC1&format=csv`);
    if (d.status !== 200) { say(`| ${w} | ${s[0]}-${s[1]} | ${s[2]} | ${s[10]} | HTTP ${d.status} ${head(d.text, 80)} | | |`); failed++; continue; }
    const L = d.text.trim().split("\n"); const H = L.shift().replace(/"/g, "").split(",");
    const rr = L.map((l) => l.replace(/^"|"$/g, "").split('","'));
    const iw = H.indexOf("WND"), ig = H.indexOf("OC1");
    // WND = dir,qual,type,speed,qual ; speed 9999 = missing. OC1 = gust speed, 9999 missing.
    const sp2 = rr.filter((c) => c[iw] && c[iw].split(",")[3] !== "9999").length, gu = rr.filter((c) => c[ig] && c[ig].split(",")[0] !== "9999").length;
    say(`| ${w} | ${s[0]}-${s[1]} | ${s[2]} | ${s[10]} | ${rr.length} | ${sp2} | ${gu} |`);
    if (w === "KTRK") say("  sample: " + head(d.text.split("\n").slice(0, 3).join(" // "), 300));
    await sleep(500);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
if (failed) process.exit(1);
