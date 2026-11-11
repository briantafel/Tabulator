import { test } from "node:test";
import assert from "node:assert/strict";
import { skyFollowsSnow, SKY_SNOW_MIN_CM, isSnowySky } from "../src/lib/wx.js";
import { parseFlags } from "../src/lib/flags.js";

const gov = (date, short, hi = 30, lo = 20) => ({ date, short, icon: "sun", hi, lo });
const sf = (date, snow, phrases, extra = {}) => ({ date, snow, periods: phrases.map((phrase, i) => ({ name: ["AM", "PM", "night"][i], phrase })), ...extra });

test("chart shows snow, government says sunny → Snow-Forecast's sky, temps kept", () => {
  const [d] = skyFollowsSnow([gov("2026-11-14", "Sunny", 31, 18)], [sf("2026-11-14", 4, ["clear", "light snow", "mod. snow"])]);
  assert.equal(d.icon, "snow");              // a snow sky from the day's periods
  assert.ok(isSnowySky(d.short));
  assert.equal(d.skyFrom, "sf");
  assert.equal(d.hi, 31); assert.equal(d.lo, 18);
});

test("government already mentions snow → untouched", () => {
  const w = gov("2026-11-14", "Chance Snow Showers");
  assert.equal(skyFollowsSnow([w], [sf("2026-11-14", 6, ["heavy snow"])])[0], w);
});

test("below the threshold, missing snow, projected days → untouched", () => {
  const w = gov("2026-11-14", "Sunny");
  assert.equal(skyFollowsSnow([w], [sf("2026-11-14", SKY_SNOW_MIN_CM - 0.1, ["light snow"])])[0], w);
  assert.equal(skyFollowsSnow([w], [sf("2026-11-14", null, ["light snow"])])[0], w);
  assert.equal(skyFollowsSnow([w], [sf("2026-11-14", 8, ["light snow"], { projected: true })])[0], w);
});

test("Snow-Forecast's own sky has no snow word → leave the government sky", () => {
  const w = gov("2026-11-14", "Sunny");
  assert.equal(skyFollowsSnow([w], [sf("2026-11-14", 2, ["clear", "some clouds"])])[0], w);
});

test("weatherSource switch defaults to off; flags.json can bring it back", () => {
  assert.equal(parseFlags({}).weatherSource, "off");
  assert.equal(parseFlags({ weatherSource: "preview" }).weatherSource, "preview");
});
