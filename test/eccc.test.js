import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ecccPeriods, ecccAlerts, pointBox } from "../scripts/eccc.js";
import { toDays, iconFor, shortLabel } from "../src/lib/wx.js";
import { stormWord, snowRows, RANGES } from "../src/lib/outlook.js";
import { readoutFacts, templateReadout, validateReadout, accumulation } from "../src/lib/readout.js";
import resortData from "../src/data/resorts.json" with { type: "json" };

/* Real responses from api.weather.gc.ca, saved on Brian's Mac 2026-10-31
   and trimmed (the sandbox cannot reach the API). */
const whistlerPage = JSON.parse(readFileSync(new URL("./fixtures/eccc-citypage-whistler.json", import.meta.url)));
const alertsAll = JSON.parse(readFileSync(new URL("./fixtures/eccc-alerts.json", import.meta.url)));

// --- Environment Canada parsing ------------------------------------------

test("a city page becomes NWS-shaped periods, dated from the issue time", () => {
  const ps = ecccPeriods(whistlerPage, "America/Vancouver");
  assert.equal(ps.length, 12);
  assert.deepEqual(ps[0], {
    name: "Tonight", isDaytime: false, temperature: 32,
    shortForecast: "Chance of rain showers or wet flurries",
    detailedForecast: ps[0].detailedForecast,
    startTime: "2026-10-30T18:00:00-07:00",
  });
  assert.match(ps[0].detailedForecast, /wet flurries/);
  assert.equal(ps[1].name, "Saturday");
  assert.equal(ps[1].startTime, "2026-10-31T06:00:00-07:00");
  assert.equal(ps[1].temperature, 43, "6°C → 43°F");
  assert.equal(ps[2].name, "Saturday Night");
  assert.equal(ps[2].isDaytime, false);
  // Offsets come from the time-zone database, not assumed: it has British
  // Columbia staying at UTC-7 this November while Los Angeles falls back.
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "longOffset" })
    .formatToParts(new Date("2026-11-02T12:00:00Z")).find((p) => p.type === "timeZoneName").value.slice(3);
  assert.equal(ps.find((p) => p.name === "Monday").startTime, `2026-11-02T06:00:00${off}`);
});

test("the resort sheet's row reads Canadian periods like NWS ones", () => {
  const days = toDays(ecccPeriods(whistlerPage, "America/Vancouver"));
  assert.equal(days.length, 6);
  assert.deepEqual(days[0], { date: "2026-10-31", name: "Saturday", short: "A mix of sun and cloud", icon: "partly-cloudy", hi: 43, lo: 28 });
  assert.equal(iconFor("Chance of rain showers or wet flurries"), "sleet");
  assert.equal(iconFor("Snow at times heavy"), "snow--heavy");
  assert.equal(shortLabel("Chance of rain showers or wet flurries"), "Rain showers or wet flurries");
});

test("only winter alerts are kept, named the way the storm word reads them", () => {
  const all = alertsAll.features.map((f) => f.properties.alert_name_en);
  assert.ok(all.includes("air quality warning") && all.includes("wind warning"), "fixture has non-winter alerts");
  const kept = ecccAlerts(alertsAll.features);
  assert.ok(kept.length >= 1);
  for (const a of kept) {
    assert.equal(a.event, "Snowfall Warning");
    assert.equal(a.colour, "yellow");
    assert.ok(a.onset && a.ends);
  }
  assert.match(kept[0].headline, /cm is expected/);
});

test("alerts are looked up in a small box at the resort", () => {
  assert.equal(pointBox([51, -118.16]), "-118.1650,50.9950,-118.1550,51.0050");
});

test("every Canadian resort names its forecast town", () => {
  const ca = resortData.resorts.filter((r) => r.region === "Canada");
  assert.equal(ca.length, 4);
  for (const r of ca) {
    assert.match(r.eccc?.site ?? "", /^(bc|ab)-\d+$/, `${r.id} has no Environment Canada site`);
    assert.ok(Array.isArray(r.latlon), `${r.id} needs latlon for its alerts`);
  }
});

// --- the storm word, with regional thresholds -----------------------------

const NOW = new Date("2026-11-01T12:00:00");
const feed = (snowIn) => resortData.resorts.map((r) => ({
  id: r.id, name: r.name,
  days: Array.from({ length: 6 }, (_, i) => ({ date: `2026-11-0${i + 1}`, snow: ((snowIn[r.id] ?? [])[i] ?? 0) * 2.54 })),
}));
const rowsFor = (snowIn) => snowRows(feed(snowIn), NOW).filter((r) => snowIn[r.id]);

test("every resort has a regional warning threshold", () => {
  for (const r of resortData.resorts) assert.ok(RANGES[r.id]?.warnIn > 0, `${r.id} has no warnIn`);
  assert.equal(RANGES.alta.warnIn, 18);
  assert.equal(RANGES.stowe.warnIn, 7);
  assert.equal(RANGES.revelstoke.warnIn, 10);
});

test("strong needs a warning AND the region's own amount in our table", () => {
  const warn = (id, event) => ({ [id]: { alerts: [{ event }] } });
  // Wasatch: 18" needed.
  assert.equal(stormWord(rowsFor({ alta: [0, 6, 8, 0, 0, 0] }), warn("alta", "Winter Storm Warning"), 8), "moderate", "14\" is short of the Wasatch's 18");
  assert.equal(stormWord(rowsFor({ alta: [0, 8, 10, 0, 0, 0] }), warn("alta", "Winter Storm Warning"), 10), "strong");
  // Vermont: 7" is a big storm there.
  assert.equal(stormWord(rowsFor({ stowe: [0, 4, 3, 0, 0, 0] }), warn("stowe", "Winter Storm Warning"), 4), "strong");
  // Canada: Environment Canada's snowfall warning, 10" in the west.
  assert.equal(stormWord(rowsFor({ revelstoke: [0, 5, 6, 0, 0, 0] }), warn("revelstoke", "Snowfall Warning"), 6), "strong");
  assert.equal(stormWord(rowsFor({ revelstoke: [0, 3, 3, 0, 0, 0] }), warn("revelstoke", "Snowfall Warning"), 3), "moderate");
});

test("watches, advisories and big days without alerts are moderate; small ones light", () => {
  const rows = rowsFor({ telluride: [0, 11, 4, 0, 0, 0] });
  assert.equal(stormWord(rows, { telluride: { alerts: [{ event: "Winter Storm Watch" }] } }, 11), "moderate");
  assert.equal(stormWord(rows, { telluride: { alerts: [{ event: "Winter Weather Advisory" }] } }, 11), "moderate");
  assert.equal(stormWord(rows, { telluride: { alerts: [] } }, 11), "moderate");
  assert.equal(stormWord(rowsFor({ telluride: [0, 2, 0, 0, 0, 0] }), { telluride: { alerts: [] } }, 2), "light");
  assert.equal(stormWord(rows, { telluride: { alerts: [{ event: "Air Quality Warning" }] } }, 2), "light", "not a snow alert");
});

test("with no weather at all, the heaviest day still decides", () => {
  assert.equal(stormWord(rowsFor({ alta: [0, 12, 0, 0, 0, 0] }), null, 12), "strong");
  assert.equal(stormWord(rowsFor({ alta: [0, 5, 0, 0, 0, 0] }), {}, 5), "moderate");
});

// --- the read-out, for a Canadian region ----------------------------------

test("Environment Canada's centimetres become inches", () => {
  assert.deepEqual(accumulation("Snow at times heavy. Amount 15 to 20 cm."), [6, 8]);
  assert.deepEqual(accumulation("Flurries. Amount 5 cm."), [2, 2]);
});

test("a Canadian region names Environment Canada, never the NWS", () => {
  const weather = {
    revelstoke: {
      source: "eccc",
      periods: [
        { name: "Sunday", isDaytime: true, temperature: 30, shortForecast: "Snow", detailedForecast: "Snow at times heavy. Amount 30 to 40 cm. High minus 1.", startTime: "2026-11-01T06:00:00-08:00" },
      ],
      alerts: [{ event: "Snowfall Warning", onset: "2026-11-01T06:00:00-08:00", ends: "2026-11-02T06:00:00-08:00" }],
    },
  };
  const facts = readoutFacts({ resorts: feed({ revelstoke: [0, 0, 0, 0, 0, 0], "kicking-horse": [0, 0, 0, 0, 0, 0] }).map((r) => r.id === "revelstoke" ? { ...r, days: r.days.map((d, i) => ({ ...d, snow: i === 0 ? 8 * 2.54 : 0 })) } : r), weather, now: NOW });
  const g = facts.regions.find((x) => x.key === "the Canadian Rockies");
  assert.ok(g, "Canadian Rockies region present");
  const rev = g.resorts[0];
  assert.equal(rev.forecaster, "Environment Canada");
  assert.equal(rev.nwsHigher.by, "Environment Canada");
  for (const p of rev.nws) assert.doesNotMatch(p.detail ?? "", /cm|amount/i, "amounts reach the writer only through nwsHigher");
  const t = templateReadout(facts);
  const text = t.regions.find((r) => r.key === "the Canadian Rockies").text;
  assert.match(text, /Environment Canada has heavy snow at Revelstoke Sunday/);
  assert.match(text, /Environment Canada is calling for more at Revelstoke: 12 to 16" Sunday/);
  assert.doesNotMatch(text, /NWS|National Weather Service/);
  assert.deepEqual(validateReadout(t, facts), []);
});
