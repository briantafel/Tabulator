/* Wind truth probe, W0 of claude/wind-model-plan-2026-11-23.md (Actions only, read-only, writes nothing to the archive).
 *
 * For the app's resorts, which PUBLIC stations near them report wind, how far away they are, at what height they sit
 * against the resort's tiers, and whether the wind fields are really filled. Two sources:
 *   A. ECCC SWOB-ML real time (api.weather.gc.ca, Canadian resorts): stations within 40 km, and whether the origin still
 *      holds data 35 days back (the plan says it keeps ~30 days: collect first).
 *   B. NWS observation stations (api.weather.gov, US resorts): the stations the NWS lists for each resort's point, with
 *      the latest wind speed and gust. Includes the mesonet and RAWS stations NWS ingests, and carries elevation.
 * Everything unexpected is printed, never skipped quietly. Exit code 1 if a whole source returns nothing. */
import { readFileSync } from "node:fs";
import { UA, sleep } from "./common.js";

const app = JSON.parse(readFileSync("public/forecast.json", "utf8")).resorts;
const meta = JSON.parse(readFileSync("src/data/resorts.json", "utf8")).resorts;
const byId = new Map(meta.map((r) => [r.id, r]));
const RADIUS_KM = 40;
const km = ([a, b], [c, d]) => { const r = Math.PI / 180, x = Math.sin(((c - a) * r) / 2), y = Math.sin(((d - b) * r) / 2); return 12742 * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); };
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };

async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json, application/json" }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.json();
      err = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) { err = e.message; }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`${url} -> ${err}`);
}
const pt = (r) => r.nws ?? r.latlon;
const tiers = (id) => app.find((x) => x.id === id)?.elevation ?? {};

// ------------------------------------------------------------------ A. ECCC SWOB-ML
let failed = 0;
say("## A. ECCC SWOB-ML real time (Canadian app resorts)\n");
try {
  const cols = await getJson("https://api.weather.gc.ca/collections?f=json");
  const sw = (cols.collections ?? []).filter((c) => /swob/i.test(c.id)).map((c) => c.id);
  say(`SWOB collections: ${sw.join(", ") || "NONE FOUND"}`);
  const coll = sw.includes("swob-realtime") ? "swob-realtime" : sw[0];
  if (!coll) throw new Error("no swob collection");
  const now = Date.now(), iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  const stations = new Map();   // id -> {name, lat, lon, elev, wind:Set, near:[resort]}
  let keysShown = false;
  for (const r of app.filter((x) => byId.get(x.id)?.region === "Canada")) {
    const c = pt(byId.get(r.id)); if (!c) continue;
    const d = 0.45;
    const bbox = [c[1] - d, c[0] - d, c[1] + d, c[0] + d].join(",");
    const url = `https://api.weather.gc.ca/collections/${coll}/items?f=json&limit=1000&bbox=${bbox}&datetime=${iso(now - 3 * 3600e3)}/${iso(now)}`;
    let j;
    try { j = await getJson(url); } catch (e) { say(`- ${r.id}: ${e.message}`); failed++; continue; }
    const feats = j.features ?? [];
    if (feats.length && !keysShown) { keysShown = true; say("\nOne feature's property keys (for the collector):\n```\n" + Object.keys(feats[0].properties).filter((k) => /wnd|gst|elev|stn|nam|id|tm|dwpt|air_temp/i.test(k)).join("\n") + "\n```\n"); }
    for (const f of feats) {
      const p = f.properties ?? {}, g = f.geometry?.coordinates;
      const id = p["msc_id-value"] ?? p["stn_nam-value"] ?? p.id ?? f.id;
      if (!g || id == null) continue;
      const s = stations.get(id) ?? { id, name: p["stn_nam-value"] ?? p.name ?? "", lat: g[1], lon: g[0], elev: p["stn_elev-value"] ?? g[2] ?? null, wind: new Set(), near: new Set(), n: 0 };
      for (const [k, v] of Object.entries(p)) if (/^(avg|max)_(pk_)?wnd.*(_pst\d+(mts|hr)|_10m)$/.test(k) && v !== null && v !== "" && v !== undefined) s.wind.add(k);
      s.near.add(r.id); s.n++;
      stations.set(id, s);
    }
    await sleep(250);
  }
  say(`\n${stations.size} stations seen in the last 3 h around the Canadian app resorts.\n`);
  say("| resort | station | km | elev m | tiers (bot/mid/top m) | wind fields filled (last 3 h) |\n|---|---|---:|---:|---|---|");
  for (const r of app.filter((x) => byId.get(x.id)?.region === "Canada")) {
    const c = pt(byId.get(r.id)); if (!c) continue;
    const near = [...stations.values()].filter((s) => s.near.has(r.id)).map((s) => ({ s, d: km(c, [s.lat, s.lon]) })).filter((x) => x.d <= RADIUS_KM).sort((a, b) => a.d - b.d);
    const t = tiers(r.id);
    if (!near.length) say(`| ${r.id} | none within ${RADIUS_KM} km | | | ${t.bot}/${t.mid}/${t.top} | |`);
    near.slice(0, 6).forEach(({ s, d }, i) => say(`| ${i ? "" : r.id} | ${s.name || s.id} | ${d.toFixed(1)} | ${s.elev ?? "?"} | ${i ? "" : `${t.bot}/${t.mid}/${t.top}`} | ${[...s.wind].map((k) => k.replace(/_pst\d+mts|_pst\d+hrs/g, "")).join(", ") || "NONE"} |`));
  }
  // retention: is anything there 35 days back?
  const c0 = pt(byId.get("whistler")) ?? [50.1, -122.95];
  const bb = [c0[1] - 1, c0[0] - 1, c0[1] + 1, c0[0] + 1].join(",");
  for (const days of [7, 20, 28, 35, 60]) {
    const t = now - days * 86400e3;
    try {
      const j = await getJson(`https://api.weather.gc.ca/collections/${coll}/items?f=json&limit=5&bbox=${bb}&datetime=${iso(t - 3600e3)}/${iso(t)}`);
      say(`\nRetention check, ${days} days back (Whistler area): ${(j.features ?? []).length} observations`);
    } catch (e) { say(`\nRetention check, ${days} days back: ${e.message}`); }
  }
} catch (e) { say(`ECCC probe failed: ${e.message}`); failed++; }

// ------------------------------------------------------------------ B. NWS stations (US app resorts)
say("\n## B. NWS observation stations near the US app resorts\n");
let usSeen = 0;
say("| resort | station | name | km | elev m | tiers (bot/mid/top m) | latest wind km/h | gust km/h |\n|---|---|---|---:|---:|---|---:|---:|");
for (const r of app) {
  const m = byId.get(r.id);
  if (!m || m.region === "Canada" || !m.nws) continue;
  const c = m.nws, t = tiers(r.id);
  try {
    const p = await getJson(`https://api.weather.gov/points/${c[0]},${c[1]}`);
    const list = await getJson(p.properties.observationStations + "?limit=25");
    const rows = [];
    for (const f of list.features ?? []) {
      const g = f.geometry?.coordinates; if (!g) continue;
      const d = km(c, [g[1], g[0]]);
      if (d > RADIUS_KM) continue;
      let w = null, gust = null;
      try {
        const o = await getJson(`https://api.weather.gov/stations/${f.properties.stationIdentifier}/observations?limit=6`);
        for (const x of o.features ?? []) { const q = x.properties; if (q.windSpeed?.value != null) w = q.windSpeed.value; if (q.windGust?.value != null) gust = q.windGust.value; if (w != null && gust != null) break; }
      } catch { /* shown as blank */ }
      rows.push({ id: f.properties.stationIdentifier, name: f.properties.name, d, el: f.properties.elevation?.value, w, gust });
      await sleep(150);
    }
    rows.sort((a, b) => a.d - b.d); usSeen += rows.length;
    if (!rows.length) say(`| ${r.id} | none within ${RADIUS_KM} km | | | | ${t.bot}/${t.mid}/${t.top} | | |`);
    rows.slice(0, 8).forEach((x, i) => say(`| ${i ? "" : r.id} | ${x.id} | ${x.name} | ${x.d.toFixed(1)} | ${x.el != null ? Math.round(x.el) : "?"} | ${i ? "" : `${t.bot}/${t.mid}/${t.top}`} | ${x.w != null ? x.w.toFixed(0) : "-"} | ${x.gust != null ? x.gust.toFixed(0) : "-"} |`));
  } catch (e) { say(`| ${r.id} | ERROR ${e.message.slice(0, 80)} | | | | | | |`); failed++; }
  await sleep(250);
}
if (!usSeen) { say("NWS returned no stations for any US resort."); failed++; }
if (process.env.GITHUB_STEP_SUMMARY) (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
if (failed) { console.error(`${failed} probe step(s) failed`); process.exit(1); }
