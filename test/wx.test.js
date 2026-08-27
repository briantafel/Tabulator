import { test } from "node:test";
import assert from "node:assert/strict";
import { iconFor, shortLabel, toDays } from "../src/lib/wx.js";
import { WX_ICONS } from "../src/lib/wx-icons.js";

test("every icon the mapping can return actually exists", () => {
  // The mapping is a list of regexes and names typed by hand; a name with a
  // typo would render an empty 32x32 box, which looks like a layout bug
  // rather than a missing icon.
  const phrases = [
    "Blizzard Conditions", "Heavy Snow", "Freezing Rain", "Sleet", "Blowing Snow",
    "Snow Showers", "Light Snow", "Heavy Rain", "Isolated T-storms", "Drizzle",
    "Scattered Showers", "Rain", "Windy", "Mostly Sunny", "Partly Sunny",
    "Sunny", "Mostly Cloudy", "Fog", "Something Unheard Of", "",
  ];
  for (const p of phrases) {
    const name = iconFor(p);
    assert.ok(WX_ICONS[name], `${JSON.stringify(p)} -> "${name}", which is not an icon`);
    assert.ok(WX_ICONS[name].length > 0, `"${name}" has no paths`);
  }
});

test("snow wins over rain in a mixed phrase", () => {
  // This app exists to find snow; a phrase mentioning both should show the
  // half that matters here.
  assert.equal(iconFor("Rain And Snow"), "snow");
  assert.equal(iconFor("Chance Rain And Snow Showers"), "snow--scattered");
  assert.equal(iconFor("Blizzard Conditions"), "snow--blizzard");
  assert.equal(iconFor("Heavy Snow"), "snow--heavy");
});

test("the icon and the label describe the same half of the day", () => {
  // "Sunny then Isolated T-storms" drew a heavy-rain cloud over the word
  // "Sunny" until iconFor() was cut at "then" the way shortLabel() is.
  for (const p of ["Sunny then Isolated T-storms", "Partly Sunny then Snow", "Heavy Snow then Clearing"]) {
    const label = shortLabel(p).toLowerCase();
    const icon = iconFor(p);
    const first = p.split(/\s+then\s+/i)[0];
    assert.equal(icon, iconFor(first), `${p}: icon follows the wrong clause`);
    assert.ok(first.toLowerCase().includes(label.split(" ")[0]), `${p}: label ${label} is not from the first clause`);
  }
});

test("labels are short enough for a 67-wide column", () => {
  assert.equal(shortLabel("Slight Chance Rain Showers then Mostly Cloudy"), "Rain showers");
  assert.equal(shortLabel("Chance Light Snow"), "Light snow");
  assert.equal(shortLabel(null), "—");
});

test("day and night periods fold into one column each", () => {
  const periods = [
    { name: "Tonight", isDaytime: false, temperature: 12, shortForecast: "Snow", startTime: "2027-01-01T18:00:00-07:00" },
    { name: "Friday", isDaytime: true, temperature: 23, shortForecast: "Heavy Snow", startTime: "2027-01-02T06:00:00-07:00" },
    { name: "Friday Night", isDaytime: false, temperature: 13, shortForecast: "Snow", startTime: "2027-01-02T18:00:00-07:00" },
    { name: "Saturday", isDaytime: true, temperature: 28, shortForecast: "Snow Showers", startTime: "2027-01-03T06:00:00-07:00" },
    { name: "Saturday Night", isDaytime: false, temperature: 16, shortForecast: "Snow", startTime: "2027-01-03T18:00:00-07:00" },
  ];
  const days = toDays(periods);
  // The leading night has no day of its own and is dropped: a column with a
  // low and no high reads as a bug.
  assert.deepEqual(days.map((d) => d.date), ["2027-01-02", "2027-01-03"]);
  assert.deepEqual(days.map((d) => [d.hi, d.lo]), [[23, 13], [28, 16]]);
  assert.equal(days[0].icon, "snow--heavy");
});

test("a trailing day with no night still renders, and the limit holds", () => {
  const day = (i) => ({
    isDaytime: true, temperature: 20 + i, shortForecast: "Snow",
    startTime: `2027-01-0${i + 1}T06:00:00-07:00`,
  });
  const days = toDays([day(0)]);
  assert.equal(days.length, 1);
  assert.equal(days[0].lo, null, "a missing night is null, not a fabricated number");
  assert.equal(toDays(Array.from({ length: 20 }, (_, i) => day(i % 9)), 6).length, 6);
  assert.deepEqual(toDays([]), []);
  assert.deepEqual(toDays(null), []);
});
