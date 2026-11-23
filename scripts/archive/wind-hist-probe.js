/* Wind W2 probe: is there PUBLIC historical hourly (or finer) wind for past winters near the app's resorts?
 * Actions only, read-only, writes nothing to the archive (run summary only). Companion of wind-probe.js (W0).
 * Sections: A ECCC climate-hourly/-daily, B Iowa Environmental Mesonet, C NWS api.weather.gov history depth,
 * D NWAC public pages, E others (NCEI ISD, SNOTEL wind, BC Wildfire). Synoptic/MesoWest is PAID: named, never called.
 * Anything blocked, malformed or empty is printed with its reason and counted; the exit code is 1 if any probe step
 * failed outright (network error / 5xx), so a red run means "read the log", not "nothing found". */
import { readFileSync, appendFileSync } from "node:fs";
import { UA, sleep } from "./common.js";

const meta = JSON.parse(readFileSync("src/data/resorts.json", "utf8")).resorts;
const stationsJson = JSON.parse(readFileSync("src/data/wind-stations.json", "utf8")).nws;
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
let failed = 0;
const fail = (msg) => { failed++; say(`**FAILED**: ${msg}`); };
const rad = Math.PI / 180;
const km = ([a, b], [c, d]) => { const x = Math.sin(((c - a) * rad) / 2), y = Math.sin(((d - b) * rad) / 2); return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * rad) * Math.cos(c * rad) * y * y)); };
const pt = (r) => r.nws ?? r.latlon;
const canada = meta.filter((r) => r.region === "Canada" && pt(r));
const us = meta.filter((r) => r.region !== "Canada" && r.nws);
const WINTERS = [["2023-24", "2024-01-10", "2024-01-17"], ["2024-25", "2025-01-10", "2025-01-17"], ["2025-26", "2026-01-10", "2026-01-17"]];

/** GET that never throws: {status, text, ms, err}. 5xx/network errors are retried twice. */
async function get(url, { accept = "*/*", tries = 3, timeout = 60000 } = {}) {
  let last = { status: 0, text: "", err: "" };
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(timeout), redirect: "follow" });
      const text = await res.text();
      last = { status: res.status, text, ms: Date.now() - t0, err: "", type: res.headers.get("content-type") };
      if (res.status < 500 && res.status !== 429) return last;
    } catch (e) { last = { status: 0, text: "", err: e.message, ms: Date.now() - t0 }; }
    await sleep(2000 * (i + 1));
  }
  return last;
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
const head = (s, n = 300) => String(s).replace(/\s+/g, " ").slice(0, n);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const lic = (s) => say(`License/terms: ${s}`);

// ============================================================ A. ECCC climate (historical)
say("## A. ECCC api.weather.gc.ca historical climate\n");
try {
  const cols = json(await get("https://api.weather.gc.ca/collections?f=json", { accept: "application/json" }));
  const ids = (cols?.collections ?? []).map((c) => c.id);
  if (!ids.length) throw new Error("collections list empty");
  say(`${ids.length} collections. Relevant: ${ids.filter((i) => /climat|hourly|swob|wind|obs|station|hydromet|ltce|bulk/i.test(i)).join(", ")}`);
  const hasHourly = ids.includes("climate-hourly"), hasDaily = ids.includes("climate-daily");
  if (!hasHourly) fail("collection climate-hourly not listed");
  // stations near each Canadian resort
  const cand = [];   // {resort, id, name, d, elev, first, last}
  let keysShown = false;
  for (const r of canada) {
    const c = pt(r), d = 0.45;
    const bbox = [c[1] - d, c[0] - d, c[1] + d, c[0] + d].join(",");
    const j = json(await get(`https://api.weather.gc.ca/collections/climate-stations/items?f=json&limit=300&bbox=${bbox}`, { accept: "application/json" }));
    if (!j) { fail(`climate-stations ${r.id}: no JSON`); continue; }
    for (const f of j.features ?? []) {
      const p = f.properties ?? {}, g = f.geometry?.coordinates; if (!g) continue;
      if (!keysShown) { keysShown = true; say("\nclimate-stations property keys: " + Object.keys(p).join(", ") + "\n"); }
      cand.push({ resort: r.id, id: p.CLIMATE_IDENTIFIER, stn: p.STN_ID, name: p.STATION_NAME, d: km(c, [g[1], g[0]]), elev: p.ELEVATION, first: p.HLY_FIRST_DATE, last: p.HLY_LAST_DATE, dfirst: p.DLY_FIRST_DATE, dlast: p.DLY_LAST_DATE });
    }
    await sleep(200);
  }
  const hourly = cand.filter((s) => s.last && s.last >= "2024-01-01" && s.d <= 40);
  say(`${cand.length} climate stations within ~45 km box of Canadian resorts; ${hourly.length} within 40 km with hourly data ending 2024 or later.\n`);
  say("| resort | station | climate id | km | elev m | hourly first | hourly last |\n|---|---|---|---:|---:|---|---|");
  const sel = [];
  for (const r of canada) {
    const l = hourly.filter((s) => s.resort === r.id).sort((a, b) => a.d - b.d).slice(0, 3);
    if (!l.length) say(`| ${r.id} | none | | | | | |`);
    l.forEach((s, i) => { say(`| ${i ? "" : r.id} | ${s.name} | ${s.id} | ${s.d.toFixed(1)} | ${s.elev ?? "?"} | ${String(s.first).slice(0, 10)} | ${String(s.last).slice(0, 10)} |`); sel.push(s); });
  }
  say("\nWind check per station, one week each in Jan 2024 / Jan 2025 / Jan 2026 (obs count, non-null WIND_SPEED, WIND_DIRECTION, gust-like keys):\n");
  say("| station | resort | " + WINTERS.map((w) => w[0]).join(" | ") + " |\n|---|---|---|---|---|");
  let hkeys = false;
  for (const s of sel) {
    const cells = [];
    for (const [, a, b] of WINTERS) {
      const j = json(await get(`https://api.weather.gc.ca/collections/climate-hourly/items?f=json&limit=400&CLIMATE_IDENTIFIER=${s.id}&datetime=${a}T00:00:00Z/${b}T00:00:00Z`, { accept: "application/json" }));
      if (!j) { cells.push("ERR"); failed++; continue; }
      const fs = j.features ?? [];
      if (fs.length && !hkeys) { hkeys = true; say(`(climate-hourly keys: ${Object.keys(fs[0].properties).join(", ")})`); }
      const nn = (k) => fs.filter((f) => f.properties[k] != null && f.properties[k] !== "").length;
      const gk = fs.length ? Object.keys(fs[0].properties).filter((k) => /gust|max.*wind|wind.*max/i.test(k)) : [];
      cells.push(`${fs.length} obs, spd ${nn("WIND_SPEED")}, dir ${nn("WIND_DIRECTION")}${gk.length ? ", " + gk.map((k) => `${k} ${nn(k)}`).join("/") : ", no gust key"}`);
      await sleep(150);
    }
    say(`| ${s.name} (${s.id}, ${s.elev ?? "?"} m) | ${s.resort} | ${cells.join(" | ")} |`);
  }
  if (hasDaily && sel.length) {
    const s = sel[0];
    const j = json(await get(`https://api.weather.gc.ca/collections/climate-daily/items?f=json&limit=10&CLIMATE_IDENTIFIER=${s.id}&datetime=2025-01-10T00:00:00Z/2025-01-17T00:00:00Z`, { accept: "application/json" }));
    const p = j?.features?.[0]?.properties;
    say(`\nclimate-daily sample (${s.name}): ${p ? Object.keys(p).filter((k) => /gust|wind/i.test(k)).map((k) => `${k}=${p[k]}`).join(", ") || "no wind keys" : "no rows"}`);
  }
  // real-time retention for completeness
  lic("ECCC open data, Open Government Licence - Canada (free, attribution, no key). Bulk alternative: climate.weather.gc.ca bulk_data_e.html.");
} catch (e) { fail(`ECCC section: ${e.message}`); }

// ============================================================ B. Iowa Environmental Mesonet
say("\n## B. Iowa Environmental Mesonet (mesonet.agron.iastate.edu)\n");
try {
  const ids = [...new Set(Object.values(stationsJson).flat().map((s) => s.id))];
  const names = Object.fromEntries(Object.values(stationsJson).flat().map((s) => [s.id, s]));
  const net = {};
  let shown = 0;
  for (const id of ids) {
    const r = await get(`https://mesonet.agron.iastate.edu/api/1/station/${id}.json`, { accept: "application/json" });
    const j = json(r);
    if (shown < 2) { shown++; say(`station API sample ${id}: HTTP ${r.status} ${head(r.text, 400)}`); }
    const rows = j?.data ?? [];
    net[id] = rows.map((x) => ({ network: x.network, begin: x.archive_begin, end: x.archive_end, elev: x.elevation, online: x.online }));
    await sleep(120);
  }
  for (const id of ids.filter((i) => /^K[A-Z]{3}$/.test(i))) {   // IEM keys ASOS by the 3-letter FAA id
    const j = json(await get(`https://mesonet.agron.iastate.edu/api/1/station/${id.slice(1)}.json`, { accept: "application/json" }));
    for (const x of j?.data ?? []) net[id].push({ network: x.network, begin: x.archive_begin, end: x.archive_end, elev: x.elevation, online: x.online, via3: true });
    await sleep(120);
  }
  const found = Object.entries(net).filter(([, v]) => v.length);
  say(`\n${found.length} of ${ids.length} app wind stations exist in IEM's station table. Networks seen: ${[...new Set(found.flatMap(([, v]) => v.map((x) => x.network)))].join(", ") || "NONE"}`);
  say("\n| id | name | IEM network | archive begin | archive end |\n|---|---|---|---|---|");
  for (const [id, v] of found) for (const x of v) say(`| ${id} | ${names[id]?.name ?? ""} | ${x.network} | ${String(x.begin).slice(0, 10)} | ${String(x.end ?? "").slice(0, 10) || "(active)"} |`);
  say(`\nNot in IEM: ${ids.filter((i) => !net[i]?.length).join(", ") || "none"}`);

  // ASOS/AWOS data request
  const asos = found.filter(([, v]) => v.some((x) => /_(ASOS|AWOS)$/.test(x.network))).map(([id]) => id);
  say(`\nASOS/AWOS data check for ${asos.length} stations (rows, non-missing wind speed, gust, median gap minutes), one Jan week per winter:\n`);
  say("| station | " + WINTERS.map((w) => w[0]).join(" | ") + " |\n|---|---|---|---|");
  for (const id of asos) {
    const cells = [];
    for (const [, a, b] of WINTERS) {
      const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
      const q = new URLSearchParams({ station: id.replace(/^K(?=[A-Z]{3}$)/, ""), data: "all", year1: y1, month1: m1, day1: d1, year2: y2, month2: m2, day2: d2, tz: "Etc/UTC", format: "onlycomma", latlon: "no", missing: "M", trace: "T", direct: "no" });
      q.delete("data"); for (const d of ["sknt", "gust", "drct"]) q.append("data", d); for (const t of ["3", "4"]) q.append("report_type", t);
      const r = await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${q}`);
      if (r.status !== 200) { cells.push(`HTTP ${r.status}`); failed++; continue; }
      const lines = r.text.trim().split("\n"); const hdr = (lines.shift() ?? "").split(",");
      const iv = hdr.indexOf("valid"), is = hdr.indexOf("sknt"), ig = hdr.indexOf("gust");
      const t = [], rowsOk = lines.map((l) => l.split(","));
      let sp = 0, gu = 0;
      for (const c of rowsOk) { if (c[is] && c[is] !== "M") sp++; if (c[ig] && c[ig] !== "M") gu++; t.push(Date.parse(c[iv].replace(" ", "T") + "Z")); }
      const gaps = t.slice(1).map((x, i) => (x - t[i]) / 60000).filter((g) => g > 0);
      cells.push(`${rowsOk.length} rows, spd ${sp}, gust ${gu}, gap ${median(gaps) ?? "-"} min`);
      await sleep(600);
    }
    say(`| ${id} | ${cells.join(" | ")} |`);
  }
  // non-ASOS: RAWS / DCP
  const other = found.filter(([id]) => !asos.includes(id)).map(([id]) => id);
  say(`\nNon-ASOS stations in IEM (${other.length}): ${other.join(", ") || "none"}. Trying IEM's RAWS/other request services on the app's named stations:\n`);
  const dcp = found.filter(([, v]) => v.some((x) => /_DCP$/.test(x.network))).map(([id]) => id);
  say(`\nHADS archive (IEM hads.py) for ${dcp.length} DCP stations, one Jan week per winter. Cells: rows | non-empty speed (US*) / dir (UD*) / gust (UG*) / peak (UP*) | median gap min:\n`);
  say("| station | " + WINTERS.map((w) => w[0]).join(" | ") + " |\n|---|---|---|---|");
  for (const id of dcp) {
    const cells = [];
    for (const [, a, b] of WINTERS) {
      const r = await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/hads.py?stations=${id}&sts=${a}T00:00Z&ets=${b}T00:00Z&what=txt&delim=comma`);
      if (r.status !== 200 || /^Error/.test(r.text)) { cells.push(`${r.status} ${head(r.text, 40)}`); continue; }
      const L = r.text.trim().split("\n"); const H = L.shift().split(","); const rows = L.map((l) => l.split(","));
      const cnt = (pre) => { const ix = H.map((h, i) => (h.startsWith(pre) ? i : -1)).filter((i) => i >= 0); return rows.filter((c) => ix.some((i) => c[i] !== "" && c[i] !== undefined)).length; };
      const t = rows.map((c) => Date.parse(c[1].replace(" ", "T") + "Z"));
      const gaps = t.slice(1).map((x, i) => (x - t[i]) / 60000).filter((g) => g > 0);
      cells.push(`${rows.length} | ${cnt("US")} / ${cnt("UD")} / ${cnt("UG")} / ${cnt("UP")} | ${median(gaps) ?? "-"}`);
      await sleep(500);
    }
    say(`| ${id} | ${cells.join(" | ")} |`);
  }
  lic("IEM: free public access, no key; their pages ask for polite request rates and credit to IEM and the originating networks. Underlying data are NWS/FAA ASOS and RAWS/HADS (US government, public domain).");
} catch (e) { fail(`IEM section: ${e.message}`); }

// ============================================================ C. NWS api.weather.gov history depth
say("\n## C. NWS api.weather.gov observation history depth\n");
try {
  say("| station | window | obs | wind speed | gust |\n|---|---|---:|---:|---:|");
  for (const id of ["KTRK", "SLIDE", "KTVL", "KCPW"]) {
    for (const [a, b] of [["2026-11-20", "2026-11-23"], ["2026-11-10", "2026-11-12"], ["2026-10-01", "2026-10-03"], ["2026-01-10", "2026-01-12"], ["2025-01-10", "2025-01-12"], ["2024-01-10", "2024-01-12"]]) {
      const r = await get(`https://api.weather.gov/stations/${id}/observations?start=${a}T00:00:00Z&end=${b}T00:00:00Z&limit=500`, { accept: "application/geo+json" });
      const j = json(r);
      if (r.status !== 200 || !j) { say(`| ${id} | ${a}..${b} | HTTP ${r.status} ${head(r.text, 80)} | | |`); continue; }
      const f = j.features ?? [];
      say(`| ${id} | ${a}..${b} | ${f.length} | ${f.filter((x) => x.properties.windSpeed?.value != null).length} | ${f.filter((x) => x.properties.windGust?.value != null).length} |`);
      await sleep(250);
    }
  }
  lic("NWS API: US government public domain, no key, User-Agent required; rate limit unpublished (be gentle). Only ~7 days of history is served by design.");
} catch (e) { fail(`NWS section: ${e.message}`); }

// ============================================================ D. NWAC
say("\n## D. NWAC (nwac.us) public data\n");
try {
  const urls = new Set();
  for (const u of ["https://nwac.us/data-portal/", "https://nwac.us/robots.txt", "https://nwac.us/terms-of-use/", "https://nwac.us/about-us/data/"]) {
    const r = await get(u);
    say(`- ${u}: HTTP ${r.status}, ${r.text.length} bytes ${r.err}`);
    if (u.endsWith("robots.txt")) say("  robots: " + head(r.text, 400));
    if (r.status === 200 && !u.endsWith("robots.txt")) {
      for (const m of r.text.matchAll(/https?:\/\/[^"'\s<>)\\]+/g)) if (/api|csv|download|measure|station|data-portal|synoptic|mesowest|\.js/i.test(m[0]) && !/fonts|google|facebook|twitter|instagram/i.test(m[0])) urls.add(m[0]);
      const t = r.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ");
      const k = t.match(/.{0,160}(data from|provided by|license|terms|download|csv|api).{0,200}/gi);
      if (k) say("  text hits: " + head(k.slice(0, 4).join(" || "), 700));
    }
    await sleep(300);
  }
  const list = [...urls].slice(0, 40);
  say(`\n${urls.size} candidate URLs found in NWAC pages; first ${list.length}:\n` + list.map((u) => "- " + u).join("\n"));
  // follow up to 4 JS bundles and look for api endpoints
  let seen = 0;
  for (const u of list.filter((x) => /\.js(\?|$)/.test(x)).slice(0, 4)) {
    const r = await get(u); seen++;
    const eps = [...new Set([...r.text.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]*(?:api|synoptic|nwac)[^"'`\s]*)["'`]/gi)].map((m) => m[1]))].slice(0, 12);
    say(`- JS ${u.split("/").pop().slice(0, 40)}: HTTP ${r.status}, endpoints: ${eps.join(" ; ") || "none"}`);
  }
  if (!seen) say("- no JS bundle URLs found on the portal page (data likely loaded from an inline config; check the first page's text hits above)");
  // a station page: look for the data endpoint and any CSV/download control
  const sp = await get("https://nwac.us/weather/stations/mt-baker-ski-area?range=graphs");
  say(`\nStation page: HTTP ${sp.status}, ${sp.text.length} bytes`);
  const apis = [...new Set([...sp.text.matchAll(/["'(](\/api\/[A-Za-z0-9_\-/.?=&%]+)/g)].map((m) => m[1]))].slice(0, 30);
  say("API paths in page: " + (apis.join(" ; ") || "none"));
  const dl = sp.text.replace(/<script[\s\S]*?<\/script>/g, " ").match(/.{0,80}(csv|download|export).{0,80}/gi);
  say("download hints in visible HTML: " + (dl ? head(dl.slice(0, 5).join(" || "), 600) : "none"));
  const chunks = [...new Set([...sp.text.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9_\-/.]+\.js/g)].map((m) => m[0]))];
  say(`${chunks.length} JS chunks; scanning up to 25 for /api/ and csv:`);
  const found2 = new Set();
  for (const c of chunks.slice(0, 25)) {
    const r = await get("https://nwac.us" + c, { tries: 1 });
    for (const m of r.text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/.${}]+|https:\/\/[a-z0-9.-]*(?:synoptic|mesowest|nwac)[^"'`\s]*)["'`]/gi)) found2.add(m[1]);
    if (/csv/i.test(r.text)) found2.add("(chunk mentions csv: " + c.split("/").pop() + ")");
  }
  say([...found2].slice(0, 40).join("\n"));
  const tt = (await get("https://nwac.us/terms-of-use/")).text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ");
  say("Terms text mentioning data/weather/scrap: " + head((tt.match(/.{0,200}(scrap|automated|weather data|weather station|API).{0,250}/gi) ?? ["no match"]).slice(0, 3).join(" || "), 1200));
  // plausible API guesses, status only
  for (const u of ["https://api.nwac.us/", "https://nwac.us/api/v5/", "https://nwac.us/data-portal/csv/", "https://api.nwac.us/api/v6/stations/"]) {
    const r = await get(u, { tries: 1 }); say(`- guess ${u}: HTTP ${r.status} ${r.err} ${head(r.text, 120)}`);
  }
} catch (e) { fail(`NWAC section: ${e.message}`); }

// ============================================================ E. Others
say("\n## E. Other open sources\n");
// E1 NCEI ISD / global-hourly
try {
  const r = await get("https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv", { timeout: 120000 });
  if (r.status !== 200) throw new Error(`isd-history HTTP ${r.status}`);
  const wanted = ["KTRK", "KTVL", "KCPW", "KCCU", "KSLC", "KSUN", "KASE", "KJAC", "KBLU", "KEKS", "KHCR", "KGUC"];
  const rows = r.text.split("\n").map((l) => l.replace(/^"|"$/g, "").split('","'));   // USAF,WBAN,NAME,CTRY,ST,ICAO,LAT,LON,ELEV,BEGIN,END
  say(`NCEI ISD history list: ${rows.length} stations.`);
  say("\n| ICAO | USAF-WBAN | name | end | Jan-2025 week rows | wind obs | gust (OC1) |\n|---|---|---|---|---:|---:|---:|");
  for (const w of wanted) {
    const s = rows.find((c) => c[5] === w && c[10] >= "20260101");
    if (!s && w === "KTRK") say(`(ISD rows for ${w}: ${head(JSON.stringify(rows.filter((c) => c[5] === w)), 300)})`);
    if (!s) { say(`| ${w} | not in ISD or ended before 2026 | | | | | |`); continue; }
    const id = s[0] + s[1];
    const d = await get(`https://www.ncei.noaa.gov/access/services/data/v1?dataset=global-hourly&stations=${id}&startDate=2025-01-10T00:00:00Z&endDate=2025-01-17T00:00:00Z&dataTypes=WND,OC1&format=csv&units=metric`);
    if (d.status !== 200) { say(`| ${w} | ${s[0]}-${s[1]} | ${s[2]} | ${s[10]} | HTTP ${d.status} ${head(d.text, 80)} | | |`); failed++; continue; }
    const L = d.text.trim().split("\n").slice(1);
    const wnd = L.filter((l) => /,"?\d{3},\d,[A-Z0-9],\s*\d{4},\d"?/.test(l) && !/9999,\d/.test(l.split(",").slice(3, 8).join(","))).length;
    say(`| ${w} | ${s[0]}-${s[1]} | ${s[2]} | ${s[10]} | ${L.length} | ${wnd} | ${L.filter((l) => /,\s*\d{4},\d"?$/.test(l) || l.includes("OC1")).length} (rough) |`);
    if (w === "KTRK") say("  sample row: " + head(d.text.split("\n")[1] ?? "", 200));
    await sleep(500);
  }
  lic("NCEI ISD / global-hourly: US government open data, free, no key, public domain. Lags real time by days to weeks; best for backfill, not live.");
} catch (e) { fail(`NCEI section: ${e.message}`); }

// E2 SNOTEL wind
try {
  const r = await get("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?elements=WSPDV&networkCds=SNTL&activeOnly=true", { accept: "application/json", timeout: 120000 });
  const j = json(r);
  if (!Array.isArray(j)) throw new Error(`SNOTEL stations: HTTP ${r.status} ${head(r.text, 150)}`);
  say(`\nSNOTEL stations reporting average wind speed (WSPDV): ${j.length} network-wide.`);
  const near = [];
  for (const rs of us) {
    const c = pt(rs);
    const l = j.map((s) => ({ s, d: km(c, [s.latitude, s.longitude]) })).filter((x) => x.d <= 40).sort((a, b) => a.d - b.d);
    if (l.length) near.push({ rs, l });
  }
  say(`${near.length} US app resorts have at least one SNOTEL wind station within 40 km:\n` + near.map((n) => `${n.rs.id}(${n.l.slice(0, 2).map((x) => `${x.s.stationTriplet} ${x.d.toFixed(0)}km ${Math.round(x.s.elevation * 0.3048)}m`).join("; ")})`).join("\n"));
  const test = [...new Set(near.slice(0, 5).map((n) => n.l[0].s.stationTriplet))];
  for (const t of test) {
    for (const [a, b] of [["2025-01-10", "2025-01-12"], ["2024-01-10", "2024-01-12"]]) {
      const d = await get(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=${encodeURIComponent(t)}&elements=WSPDV,WSPDX,WDIRV&duration=HOURLY&beginDate=${a}&endDate=${b}`, { accept: "application/json" });
      const dj = json(d);
      const sum = Array.isArray(dj) ? dj.flatMap((x) => x.data ?? []).map((x) => `${x.stationElement?.elementCode}:${(x.values ?? []).filter((v) => v.value != null).length}`).join(" ") : `HTTP ${d.status} ${head(d.text, 100)}`;
      say(`- ${t} ${a}: ${sum || "no data rows"}`);
      await sleep(300);
    }
  }
  lic("NRCS AWDB REST: US government public domain, free, no key.");
} catch (e) { fail(`SNOTEL section: ${e.message}`); }

// E3 BC Wildfire Service weather data mart
try {
  for (const u of ["https://www.for.gov.bc.ca/ftp/HPR/external/!publish/BCWS_DATA_MART/", "https://www.for.gov.bc.ca/ftp/HPR/external/!publish/BCWS_DATA_MART/2025/"]) {
    const r = await get(u);
    say(`\nBCWS data mart ${u.replace(/.*MART/, "MART")}: HTTP ${r.status}, ${head(r.text.replace(/<[^>]+>/g, " "), 260)}`);
  }
  for (const y of ["2023", "2024", "2025"]) {
    const r = await get(`https://www.for.gov.bc.ca/ftp/HPR/external/!publish/BCWS_DATA_MART/${y}/${y}-01-10.csv`);
    const L = r.text.split("\n");
    say(`BCWS ${y}-01-10.csv: HTTP ${r.status}, ${L.length} lines. Header: ${head(L[0], 400)}`);
    if (y === "2025") say("  resort-area rows: " + head(L.filter((l) => /WHITE|SUN PEAKS|PANORAMA|SILVER|WHISTLER|FERNIE|REVELSTOKE|KICKING|CYPRESS|SEYMOUR|GROUSE/i.test(l)).slice(0, 6).join(" || "), 700));
  }
  lic("BC Wildfire Service weather stations on DataBC: Open Government Licence - British Columbia.");
} catch (e) { fail(`BCWS section: ${e.message}`); }

say("\nNot probed (named for the report): Synoptic/MesoWest public tier = PAID, tagged, never called. MADIS public archive needs a registration. NWAC data also flows through Synoptic.");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
if (failed) { console.error(`${failed} probe step(s) failed`); process.exit(1); }
