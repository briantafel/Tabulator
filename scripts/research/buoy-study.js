#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * The Powder Buoy test: does a swell "pop" at a NOAA buoy (51101 or 51001) predict a
 * storm in our mountains about two weeks later? Run by
 * .github/workflows/buoy-study.yml (the sandbox cannot reach NOAA or
 * SNOTEL). Writes out/buoy-study.md (also the job summary) and CSVs.
 *
 * Research only: nothing here touches the app or the archive. The
 * definitions and the verdict rule are fixed in buoy-stats.js.
 * ------------------------------------------------------------------ */

import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pickStations } from "../archive/snotel.js";
import {
  parseNdbc, dailyMax, findPops, gainsFromAccum, regionDaily, score, lagScan, persistenceSplit, seasonOf, PRIMARY,
} from "./buoy-stats.js";

/* Which buoy. 51101 (NW of Kauai) is the one the Powder Buoy press names;
   Ruzek has said he started on 51001 ("Hawaii Buoy One", farther NW) in
   2002, so the study runs on either. Same pre-registered definition for
   both: the thresholds were fixed before any result and are not retuned
   per buoy. */
const BUOY = process.env.BUOY ?? "51101";
if (!/^\d{5}$/.test(BUOY)) throw new Error(`BUOY must be a 5-digit NDBC station id, got "${BUOY}"`);
/* COMPARE (optional, added 2026-11-17): a second buoy. The report then adds an
   overlap section: which of BUOY's pops the other buoy also flagged (±MATCH_POP
   days), and the Wasatch score of the shared and the unshared pops separately,
   on days both buoys have data. Exploratory: the verdict above is unchanged. */
const COMPARE = process.env.COMPARE ?? "";
const MATCH_POP = 3;
const FIRST_YEAR = Number(process.env.BUOY_FIRST_YEAR ?? 2008);
const LAST_WINTER_END = process.env.LAST_WINTER_END ?? "2026-04-30";
const AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1";
const UA = "Tabulator/1.0 (personal ski-forecast research; github.com/briantafel/Tabulator)";
const OUT = "out";

/* Regions by resort, so the stations are the same SNOTEL picks the
   archive uses (within 30 km, up to three per resort). The Wasatch is the
   region the method was built on and the one the verdict rests on. */
const REGIONS = {
  Wasatch: ["alta", "snowbird", "brighton", "solitude", "snowbasin", "powder-mountain"],
  Colorado: ["vail", "breckenridge", "arapahoe-basin", "steamboat", "aspen-highlands", "crested-butte", "telluride", "wolf-creek"],
  Tetons: ["jackson-hole", "grand-targhee"],
  Tahoe: ["palisades", "northstar", "sugar-bowl", "kirkwood", "heavenly", "mt-rose", "sierra-at-tahoe", "homewood"],
};
const PRIMARY_REGION = "Wasatch";

const log = (...a) => console.error(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { binary = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (attempt === 2) throw new Error(`${url}: ${e.message}`);
      await sleep(3000 * (attempt + 1));
    }
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Every year's file; for the current year (not yet archived as a yearly
 *  file) the monthly files. */
async function buoyReadings(id = BUOY) {
  const now = new Date();
  const readings = [], coverage = [];
  for (let y = FIRST_YEAR; y < now.getUTCFullYear(); y++) {
    const gz = await get(`https://www.ndbc.noaa.gov/data/historical/stdmet/${id}h${y}.txt.gz`, { binary: true });
    if (!gz) { coverage.push(`${y}: no yearly file`); continue; }
    const r = parseNdbc(gunzipSync(gz).toString("utf8"));
    readings.push(...r);
    coverage.push(`${y}: ${r.length} readings`);
  }
  const y = now.getUTCFullYear();
  for (let m = 0; m < now.getUTCMonth(); m++) {
    const gz = await get(`https://www.ndbc.noaa.gov/data/stdmet/${MONTHS[m]}/${id}${m + 1}${y}.txt.gz`, { binary: true });
    const text = gz ? gunzipSync(gz).toString("utf8") : await get(`https://www.ndbc.noaa.gov/data/stdmet/${MONTHS[m]}/${id}.txt`);
    if (!text) { coverage.push(`${y}-${MONTHS[m]}: no monthly file`); continue; }
    const r = parseNdbc(text);
    readings.push(...r);
    coverage.push(`${y}-${MONTHS[m]}: ${r.length} readings`);
  }
  return { readings, coverage };
}

/** SNOTEL daily accumulated precipitation for every station picked for a
 *  region's resorts, as daily gains in inches of water. */
async function regionSeries(resorts, stations) {
  const out = {};
  for (const [name, ids] of Object.entries(REGIONS)) {
    const rs = resorts.filter((r) => ids.includes(r.id));
    const picks = pickStations(stations, rs, new Date());
    const triplets = [...new Set(picks.map((p) => p.station.stationTriplet))];
    const gains = [];
    for (let i = 0; i < triplets.length; i += 8) {
      const q = new URLSearchParams({
        stationTriplets: triplets.slice(i, i + 8).join(","), elements: "PREC", duration: "DAILY",
        beginDate: `${FIRST_YEAR}-10-01`, endDate: LAST_WINTER_END,
      });
      const text = await get(`${AWDB}/data?${q}`);
      if (!text) throw new Error(`SNOTEL data 404 for ${name}`);
      for (const st of JSON.parse(text)) {
        for (const el of st.data ?? []) {
          if (el.stationElement?.elementCode !== "PREC") continue;
          const unit = String(el.stationElement?.storedUnitCode ?? "in").toLowerCase();
          const k = unit === "in" ? 1 : unit === "mm" ? 1 / 25.4 : NaN;
          if (!Number.isFinite(k)) throw new Error(`${st.stationTriplet} PREC in unknown unit ${unit}`);
          const vals = (el.values ?? []).filter((v) => Number.isFinite(v.value))
            .map((v) => ({ date: String(v.date).slice(0, 10), value: v.value * k }));
          gains.push({ station: st.stationTriplet, gains: gainsFromAccum(vals) });
        }
      }
      await sleep(500);
    }
    out[name] = { stations: triplets, perStation: gains, daily: regionDaily(gains.map((g) => g.gains)) };
    log(`${name}: ${triplets.length} stations, ${out[name].daily.size} region-days`);
  }
  return out;
}

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");
const pp = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pts` : "–");
const range = ([a, b]) => `${pp(a)} to ${pp(b)}`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const resorts = JSON.parse(await readFile(new URL("../../src/data/resorts.json", import.meta.url), "utf8")).resorts;

  const { readings, coverage } = await buoyReadings();
  const wave = dailyMax(readings);
  log(`buoy ${BUOY}: ${readings.length} readings, ${wave.size} days`);
  const buoyWinters = new Set([...wave.keys()].map(seasonOf));
  if (buoyWinters.size < 8) throw new Error(`only ${buoyWinters.size} winters of buoy data — too few to judge anything`);

  const stationsText = await get(`${AWDB}/stations?stationTriplets=*:*:SNTL`);
  const stations = JSON.parse(stationsText);
  if (!Array.isArray(stations) || stations.length < 100) throw new Error("SNOTEL station list looks wrong");
  const regions = await regionSeries(resorts, stations);
  if (regions[PRIMARY_REGION].stations.length < 3) throw new Error(`${PRIMARY_REGION}: fewer than 3 SNOTEL stations — can't judge`);

  const pops = findPops(wave, PRIMARY);
  await writeFile(`${OUT}/pops.csv`, "date,wvht_m\n" + pops.map((d) => `${d},${wave.get(d)}`).join("\n") + "\n");

  const lines = [];
  const L = (s = "") => lines.push(s);
  L(`# Does a buoy ${BUOY} "pop" predict a storm about two weeks later?`);
  L();
  L(`Run ${new Date().toISOString().slice(0, 16)}Z. Buoy: ${wave.size} days over ${buoyWinters.size} winters. ${pops.length} pops (Nov–Mar).`);
  L();
  L("Pre-registered (fixed before any result was seen; see scripts/research/buoy-stats.js):");
  L(`- **Pop:** daily highest wave height ≥ ${PRIMARY.minHeightM} m and ≥ ${PRIMARY.riseM} m above the lowest daily high of the ${PRIMARY.lookback} days before; one per swell (${PRIMARY.gapDays}-day gap).`);
  L(`- **Storm:** a day with ≥ ${PRIMARY.stormIn} in of water (≈ 6–8 in of snow), median of the region's SNOTEL gauges.`);
  L(`- **Window:** a storm day ${PRIMARY.from}–${PRIMARY.to} days after the pop.`);
  L(`- **Verdict:** skill only if the 90% range of (storm chance after a pop − storm chance on comparable days without one) is above zero for the ${PRIMARY_REGION}. Comparable = non-pop days within ±10 days of the same date, in every winter. Ranges come from resampling whole winters.`);
  L();

  const primary = score(pops, regions[PRIMARY_REGION].daily, PRIMARY);
  L(`## Verdict (${PRIMARY_REGION}): ${primary.skill ? "**SKILL** — a pop raises the storm chance beyond chance" : "**NO MEASURABLE SKILL** — storms follow pops about as often as they follow any comparable day"}`);
  L();
  L("| | after a pop | comparable days | difference (90% range) | ratio (90% range) | pops scored | winters |");
  L("| :-- | --: | --: | --: | --: | --: | --: |");
  L(`| ${PRIMARY_REGION} | ${pct(primary.pPop)} | ${pct(primary.pBase)} | ${pp(primary.diff)} (${range(primary.diff90)}) | ${primary.lift.toFixed(2)} (${primary.lift90.map((x) => x.toFixed(2)).join("–")}) | ${primary.nPops} | ${primary.seasons} |`);
  L();

  L("## Exploratory (not part of the verdict — many comparisons, expect some to pass by chance)");
  L();
  L("| region | storm ≥ | after a pop | comparable days | difference (90% range) | pops |");
  L("| :-- | --: | --: | --: | --: | --: |");
  const rows = [];
  for (const [name, r] of Object.entries(regions)) {
    for (const stormIn of [0.5, 1.0]) {
      const s = score(pops, r.daily, { ...PRIMARY, stormIn });
      rows.push({ name, stormIn, ...s });
      L(`| ${name} | ${stormIn} in | ${pct(s.pPop)} | ${pct(s.pBase)} | ${pp(s.diff)} (${range(s.diff90)})${s.skill ? " ✓" : ""} | ${s.nPops} |`);
    }
  }
  await writeFile(`${OUT}/scores.csv`, "region,storm_in,p_pop,p_base,diff,diff_lo,diff_hi,lift,n_pops,winters\n" +
    rows.map((r) => [r.name, r.stormIn, r.pPop, r.pBase, r.diff, ...r.diff90, r.lift, r.nPops, r.seasons].join(",")).join("\n") + "\n");
  L();

  L(`### Lag scan, ${PRIMARY_REGION}: storm chance on the single day N days after a pop`);
  L("A real two-week signal shows a bump near 14 that stands above its neighbours. A flat or noisy line means the window result is chance.");
  L();
  L("| days after | after a pop | all other days | difference |");
  L("| --: | --: | --: | --: |");
  const lag = lagScan(pops, regions[PRIMARY_REGION].daily);
  for (const x of lag) L(`| ${x.lag} | ${pct(x.pPop)} | ${pct(x.pBase)} | ${pp(x.pPop - x.pBase)} |`);
  await writeFile(`${OUT}/lag-scan.csv`, "lag,p_pop,p_base,n\n" + lag.map((x) => [x.lag, x.pPop, x.pBase, x.n].join(",")).join("\n") + "\n");
  L();

  const ps = persistenceSplit(pops, regions[PRIMARY_REGION].daily);
  L(`### Is a pop just a sign of a stormy pattern already under way? (${PRIMARY_REGION})`);
  L("If the pop's edge disappears once you know whether it had already been storming, the buoy is echoing the pattern, not predicting it.");
  L();
  L("| | after a pop | comparable days |");
  L("| :-- | --: | --: |");
  L(`| a storm in the 7 days before | ${pct(ps.afterStorm.pop.p)} (n ${ps.afterStorm.pop.n}) | ${pct(ps.afterStorm.base.p)} (n ${ps.afterStorm.base.n}) |`);
  L(`| no storm in the 7 days before | ${pct(ps.afterQuiet.pop.p)} (n ${ps.afterQuiet.pop.n}) | ${pct(ps.afterQuiet.base.p)} (n ${ps.afterQuiet.base.n}) |`);
  L();

  if (COMPARE && COMPARE !== BUOY) {
    const other = dailyMax((await buoyReadings(COMPARE)).readings);
    const both = new Map([...wave].filter(([d]) => other.has(d)));
    const mine = findPops(both, PRIMARY), theirs = findPops(new Map([...other].filter(([d]) => wave.has(d))), PRIMARY);
    const near = (d, xs) => xs.some((x) => Math.abs(Date.parse(x) - Date.parse(d)) <= MATCH_POP * 864e5);
    const shared = mine.filter((d) => near(d, theirs)), onlyMine = mine.filter((d) => !near(d, theirs));
    const onlyTheirs = theirs.filter((d) => !near(d, mine));
    const hMine = (xs) => xs.length ? (xs.reduce((a, d) => a + both.get(d), 0) / xs.length).toFixed(1) : "–";
    L(`## Overlap with buoy ${COMPARE} (exploratory — days both buoys have data)`);
    L(`Do the two buoys flag the same swells? A pop "matches" if the other buoy popped within ±${MATCH_POP} days. ${both.size} shared days.`);
    L();
    L(`| pops | count | mean wave height at ${BUOY} (m) | ${PRIMARY_REGION}: after a pop | comparable days | difference (90% range) |`);
    L("| :-- | --: | --: | --: | --: | --: |");
    for (const [label, xs] of [[`all ${BUOY} pops`, mine], [`${BUOY} pops ${COMPARE} also flagged`, shared],
                               [`${BUOY} pops ${COMPARE} missed`, onlyMine], [`all ${COMPARE} pops`, theirs],
                               [`${COMPARE} pops ${BUOY} missed`, onlyTheirs]]) {
      const sc = xs.length >= 10 ? score(xs, regions[PRIMARY_REGION].daily, PRIMARY) : null;
      const h = label.startsWith(`all ${COMPARE}`) || label.startsWith(`${COMPARE} pops`) ? "–" : hMine(xs);
      L(`| ${label} | ${xs.length} | ${h} | ${sc ? pct(sc.pPop) : "–"} | ${sc ? pct(sc.pBase) : "–"} | ${sc ? `${pp(sc.diff)} (${range(sc.diff90)})` : "too few"} |`);
    }
    L();
    await writeFile(`${OUT}/overlap.csv`, "date,group\n" + [...shared.map((d) => `${d},shared`), ...onlyMine.map((d) => `${d},only-${BUOY}`),
      ...onlyTheirs.map((d) => `${d},only-${COMPARE}`)].join("\n") + "\n");
  }

  L("## Data");
  for (const [name, r] of Object.entries(regions)) L(`- ${name}: ${r.stations.length} SNOTEL stations (${r.stations.join(", ")}), ${r.daily.size} region-days.`);
  L(`- Buoy ${BUOY} files: ${coverage.join("; ")}.`);
  L("- Method credit: Mike Ruzek, Powder Buoy (powderbuoy.com). Buoy data: NOAA NDBC. Truth: NRCS SNOTEL.");

  const md = lines.join("\n") + "\n";
  await writeFile(`${OUT}/buoy-study.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  process.stdout.write(md);
}

main().catch((e) => {
  console.log(`::error::Buoy study failed: ${e.message}`);
  process.exitCode = 1;
});
