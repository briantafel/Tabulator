/* The resort sheet's summary, in more than one voice.
 *
 * Brian, 2026-10-30, on resortVerdict(): "The writing in the resort sheet
 * deeply others me … I want to generate a ton of versions of this copy. It
 * should be smart. For example, the temps now say 'it's spring, baby!' but
 * it's actually just LIKE spring. I want variations, with real skier talk
 * without being cartoonish."
 *
 * The sentence is three slots, each picked from a pool:
 *
 *   SNOW        how much is coming, and what that amount means
 *   CONDITIONS  temps and wind TOGETHER — cold plus wind is windchill, warm
 *               plus wind is something else, so the pair is the unit, not
 *               two words dropped into one frame
 *   SO WHAT     optional; at most one; only when the combination says
 *               something the first two sentences did not (heavy snow when
 *               it is warm, firm groomers when it is dry, a deal breaker)
 *
 * Templates mark the highlighted words with [square brackets] — Brian's own
 * convention from his mocks — so the copy can be edited as copy. Tokens:
 * {snow} the amount with its unit, {over} "over 4 days" or "in a single day", {w}/{wn} a
 * wind word / wind phrase for the band the template covers.
 *
 * The pick is SEEDED by resort and window, never random per render: the
 * sentence must not change every time the sheet opens. A new forecast run or
 * a different date range is what changes it.
 *
 * Behind a flag (see flags.js). verdict.js is untouched, so the classic
 * sentence is still exactly what ships by default.
 */

import { rainRisk, tempSeverity, windSeverity } from "./scoring.js";
import { snowWithUnit, cmToIn, cToF, kmhToMph } from "./units.js";
import { vetoOf } from "./rank.js";
import { RANGES } from "./outlook.js";

/* ------------------------------------------------------------------ copy -- */

/** Snow, by amount. Every template has exactly ONE [highlight]. */
export const SNOW = {
  none: [
    "[No new snow] in the forecast {over}.",
    "[Nothing] falling {over}, by the look of it.",
    "Looking like a dry spell, with [no new snow] {over}.",
    "[Not a flake] in the forecast {over}.",
  ],
  dusting: [
    "Looking like [{snow}] {over}, more of a dusting than a refresh.",
    "Just [{snow}] {over}. Pretty to look at, not much to ski on.",
    "Only [{snow}] {over}. Call it a cosmetic coat.",
    "A light dusting, [{snow}] {over}.",
  ],
  light: [
    "Looking like [{snow}] {over}. A modest refresh.",
    "[{snow}] {over}, enough to freshen things up.",
    "A few inches on the way, [{snow}] {over}.",
    "Looking like [{snow}] {over}. Enough to freshen the surface.",
  ],
  solid: [
    "Looking like [{snow}] {over}. A real refresh.",
    "[{snow}] {over}. That'll reset the whole mountain.",
    "A solid [{snow}] {over}.",
    "Looking like [{snow}] {over}, which puts fresh tracks back on the menu.",
  ],
  dump: [
    "Looking like [{snow}] {over}. That's a proper storm.",
    "[{snow}] {over}. It's dumping.",
    "A big one, [{snow}] {over}.",
    "Looking like [{snow}] {over}. Get there early.",
  ],
  cycle: [
    "Looking like [{snow}] {over}. That's a fat storm cycle.",
    "[{snow}] {over}. Clear the calendar.",
    "A serious cycle, [{snow}] {over}.",
    "Looking like [{snow}] {over}. Somebody call TGR. It's gonna be blower.",
  ],
};

/** Wind words for the two bands where one phrase cannot cover the range. */
export const WIND_WORDS = {
  calm: { w: ["calm", "dead calm"], wn: ["hardly any wind", "barely a breeze", "no wind to speak of"] },
  light: { w: ["light", "pretty mellow"], wn: ["a light breeze", "not much wind", "just a light breeze"] },
  breezy: { w: ["breezy", "a bit gusty", "moderate"], wn: ["a steady breeze", "some wind up top", "a bit of a breeze"] },
  stiff: { w: ["a little high", "gusty", "stiff"], wn: ["a stiff wind", "some real gusts", "a fair bit of wind up top"] },
};

/** Temps × wind. Every template has exactly TWO [highlights]: temp, then wind
 *  (or wind then temp — the order in the sentence is free). */
export const CONDITIONS = {
  spring: {
    still: [
      "It's going to feel [like spring], with [{wn}].",
      "Temps look [downright springlike], and winds are [{w}].",
      "[T-shirt warm] in the afternoons, with [{wn}].",
    ],
    windy: [
      "It's going to feel [like spring], though winds are [{w}].",
      "Temps look [springlike], and winds are [{w}].",
      "[Spring warmth], with [{wn}] on top of it.",
    ],
    howling: [
      "Temps look [springlike], but winds are [howling].",
      "[Warm as April], and [blowing hard] up top.",
      "It'll feel [like spring] down low and [ripping] up high.",
    ],
  },
  tooWarm: {
    still: [
      "Temps look [almost too warm to ski], and winds are [{w}].",
      "Highs are [pushing 40], with [{wn}].",
      "[Warm enough to turn things to slush], with [{wn}].",
    ],
    windy: [
      "Highs are [pushing 40], and winds are [{w}].",
      "[Almost too warm to ski], with [{wn}].",
      "Temps look [warm enough to go soft], and winds are [{w}].",
    ],
    howling: [
      "Highs are [pushing 40], and winds are [howling].",
      "Temps look [almost too warm], and it's [blowing hard].",
      "[Warm and heavy-feeling], with winds [ripping] up top.",
    ],
  },
  warm: {
    still: [
      "Temps look [pretty damn warm], and winds are [{w}].",
      "[Above freezing] most afternoons, with [{wn}].",
      "It'll be [warm enough to soften things], with [{wn}].",
    ],
    windy: [
      "Temps look [pretty warm], and winds are [{w}].",
      "[Above freezing] in the afternoons, with [{wn}].",
      "Temps are [on the warm side], and winds are [{w}].",
    ],
    howling: [
      "Temps look [warm], and winds are [howling].",
      "[Above freezing] and [blowing hard], which is not a great combo.",
      "It'll be [warm], with winds [ripping] across the ridges.",
    ],
  },
  bitWarm: {
    still: [
      "Temps look [a touch warm], and winds are [{w}].",
      "Hovering [right around freezing], with [{wn}].",
      "[Mild], with [{wn}].",
    ],
    windy: [
      "Temps look [a bit warm], and winds are [{w}].",
      "Hovering [around freezing], with [{wn}].",
      "[Mild], though winds are [{w}].",
    ],
    howling: [
      "Temps are [around freezing], but winds are [howling].",
      "[Mild] down low, and [ripping] up top.",
      "Temps look [a bit warm], and winds are [strong enough to hold lifts].",
    ],
  },
  mixed: {
    still: [
      "Temps look [all over the place], and winds are [{w}].",
      "A [warm spell and a hard freeze] in the same window, with [{wn}].",
      "Temps are [swinging hard], but winds stay [{w}].",
    ],
    windy: [
      "Temps look [all over the place], and winds are [{w}].",
      "Temps are [swinging from thaw to freeze], with [{wn}].",
      "[Up and down] on temps, with [{wn}].",
    ],
    howling: [
      "Temps look [all over the place], and winds are [howling].",
      "Temps are [swinging hard], and it's [blowing hard] on top of that.",
      "[Thaw, then freeze], with winds [ripping].",
    ],
  },
  frigid: {
    still: [
      "Temps look [frigid], though winds are [{w}].",
      "It's going to be [bitterly cold], with [{wn}] at least.",
      "[Seriously cold], but [{w}], which helps.",
    ],
    windy: [
      "Temps look [frigid], and winds are [{w}]. That's real windchill.",
      "[Bitterly cold], with [{wn}] to make it bite.",
      "[Dangerously cold] once you add [{wn}].",
    ],
    howling: [
      "Temps look [downright miserable], with winds [howling].",
      "[Brutally cold] and [blowing hard]. Frostbite weather.",
      "[Arctic], with winds [ripping]. That's a tough day out.",
    ],
  },
  deep: {
    still: [
      "Temps look [properly cold], and winds are [{w}].",
      "[Below zero] at night, but [{w}].",
      "[Deep-winter cold], with [{wn}].",
    ],
    windy: [
      "Temps look [fairly miserable], and winds are [{w}].",
      "[Properly cold], and [{wn}] makes it worse.",
      "[Below zero] with [{wn}]. Cover every inch of skin.",
    ],
    howling: [
      "Temps look [downright miserable], and winds are [howling].",
      "[Bitter], with winds [ripping]. Upper lifts will struggle.",
      "[Deep cold] and [blowing hard].",
    ],
  },
  cold: {
    still: [
      "Temps look [cold], and winds are [{w}].",
      "[Crisp and cold], with [{wn}].",
      "[Chilly], but [{w}]. Layer up and it's fine.",
    ],
    windy: [
      "Temps look [fairly miserable], and winds are [{w}].",
      "[Cold], with [{wn}] that'll sting.",
      "[Cold] and [{w}]. Neck gaiter weather.",
    ],
    howling: [
      "Temps look [cold], and winds are [howling].",
      "[Cold] and [blowing hard], so the lift rides will be rough.",
      "[Raw], with winds [ripping].",
    ],
  },
  pleasant: {
    still: [
      "Temps look [pleasant], and winds are [{w}].",
      "[Comfortable] temps and [{wn}].",
      "[Nice winter temps], with [{wn}].",
      "Temps look [about perfect], with [{wn}].",
    ],
    windy: [
      "Temps look [pleasant], and winds are [{w}].",
      "[Comfortable] temps, though it's [{w}] up top.",
      "[Mild], with [{wn}].",
    ],
    howling: [
      "Temps look [pleasant], but winds are [howling].",
      "[Comfortable] temps, but it's [blowing hard] up high.",
      "[Mild], though winds are [strong enough to hold lifts].",
    ],
  },
  fine: {
    still: [
      "Temps look [good], and winds are [{w}].",
      "[Seasonably cold], with [{wn}].",
      "[Classic winter temps], with [{wn}].",
    ],
    windy: [
      "Temps look [good], and winds are [{w}].",
      "[Seasonable], with [{wn}].",
      "[Wintry], with [{wn}].",
    ],
    howling: [
      "Temps look [fine], but winds are [howling].",
      "[Seasonable], but [blowing hard] up high.",
      "Temps are [no problem], but winds are [ripping].",
    ],
  },
};

/** Over 45mph the wind IS the sentence; the temp only needs a word. */
export const GALE = [
  "Temps look [{t}], but winds are [absolutely howling].",
  "Winds are [absolutely howling], and temps look [{t}].",
  "It's [blowing a gale], and temps look [{t}].",
];
export const GALE_TEMP = {
  spring: "springlike", tooWarm: "almost too warm", warm: "warm", bitWarm: "mild",
  mixed: "all over the place", frigid: "frigid", deep: "properly cold", cold: "cold",
  pleasant: "pleasant", fine: "fine",
};

/** The so-what. First matching rule wins; most cases say nothing. No
 *  highlights — like the old concern clause, it is a reading, not a number.
 *  Regional words ("Sierra cement", "Wasatch blower") only fire for the
 *  ranges they belong to; used anywhere else they are exactly the cartoon
 *  Brian asked to avoid. */
export const SO_WHAT = {
  vetoWind: [
    "Wind is a deal breaker. Expect lifts on hold.",
    "That's lift-closing wind, so it's a deal breaker.",
    "The upper mountain will likely be on wind hold. Deal breaker.",
  ],
  vetoCold: [
    "That cold is a deal breaker.",
    "Too cold to be out in for long. Deal breaker.",
    "Frostbite cold, so it's a deal breaker.",
  ],
  vetoWarm: [
    "Warm enough to be a deal breaker and slush by noon.",
    "Too warm to hold up. Deal breaker.",
    "Spring conditions, not ski-trip conditions. Deal breaker.",
  ],
  rain: [
    "The freezing level sits above mid-mountain, so expect rain lower down.",
    "Watch the rain line. It may be wet below mid-mountain.",
    "Some of that could come down as rain.",
  ],
  stormWind: [
    "Wind could hold the upper lifts, but the trees should be deep.",
    "Expect wind-loaded pockets and some lift holds.",
    "Storm skiing. Stick to the trees.",
  ],
  heavy: [
    "It'll be heavy, wet snow.",
    "Dense stuff, but it'll build the base.",
    "Expect it heavy and sticky.",
  ],
  heavySierra: ["Classic Sierra cement.", "It'll be Sierra cement, but it'll build the base."],
  heavyCascades: ["Cascade concrete, most likely.", "Heavy Cascade snow, but it'll build the base."],
  heavyEast: ["Heavy and wet, the way the East does it."],
  dry: [
    "Cold enough to keep it light and dry.",
    "That should ski light and bottomless.",
    "Cold snow, so it'll stay light.",
  ],
  dryWasatch: ["Classic Wasatch blower.", "Light, dry Wasatch snow."],
  dryRockies: ["Light, dry Rockies snow.", "That should be cold smoke."],
  go: [
    "That's the move.",
    "Lordy. This is the one.",
    "Call in sick.",
    "Get there for first chair.",
  ],
  corn: [
    "Firm mornings, soft afternoons. Time it for corn.",
    "Let it soften up, then go.",
    "Expect a crust in the mornings.",
  ],
  /* Brian, 2026-10-31: "one state that exists when it snows, gets warm, then
     very cold. Expect crust on fluff." and "snow → warm → freezing → light
     snow in a 48 hour period. Expect fluff on crust." Read off the sequence
     of forecast periods, not the window's extremes — order is the point. */
  crustOnFluff: [
    "Snow, then a thaw, then a hard freeze. Expect crust on fluff.",
    "The warm spell will cook the new snow and the cold will lock it up. Crust on fluff.",
    "Expect a breakable crust over soft snow underneath.",
  ],
  fluffOnCrust: [
    "Thaw, refreeze, then a light coat on top. Expect fluff on crust.",
    "Fresh snow over a refrozen crust. Soft on top, firm underneath.",
    "Expect fluff on crust. Fun until you find the layer below.",
  ],
  crust: [
    "Expect a crust after the thaw.",
    "Whatever melts will refreeze, so expect it firm.",
    "Thaw then freeze usually means crust. Pick your timing.",
  ],
  firm: [
    "Groomers will be firm and fast.",
    "Expect firm, chalky groomers.",
    "Sharp edges will help.",
  ],
  firmEast: ["Classic Eastern hardpack. Sharpen the edges.", "Expect it firm. That's the East."],
  cruise: [
    "Good for cruising groomers, not much else.",
    "A groomer day.",
    "Fine for laps, nothing to chase.",
  ],
  wind: ["Wind could be a concern.", "Wind could hold the upper lifts."],
  temps: ["Temps could be a concern.", "Expect soft, sticky snow in the afternoons."],
  windTemps: ["Wind and temps could both be a concern."],
};

/* ----------------------------------------------------------------- logic -- */

/** FNV-1a. Small, stable, and the same in every browser. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const pick = (pool, seed, salt) => pool[hash(`${seed}|${salt}`) % pool.length];

/* Words that promise cold, dry snow. Brian's own storm-cycle line says "It's
   gonna be blower", which is exactly right at 20°F and exactly wrong at 36°F
   — so any line carrying one of these sits out a window with a thaw in it,
   whichever pool it is in. */
const DRY_WORDS = /blower|cold smoke|light and dry|bottomless|champagne/i;
const DRY_MAX_F = 30;
const forWindow = (pool, x) =>
  x.hi != null && x.hi > DRY_MAX_F ? pool.filter((t) => !DRY_WORDS.test(t)) : pool;

/* ------------------------------------------------------- the snowpack -- */

const THAW_F = 33;        // above freezing: Snow-Forecast's 1°C is 33.8°F
const HARD_FREEZE_F = 28; // a refreeze that sets a crust
const VERY_COLD_F = 15;   // "very cold" — locks a cooked surface solid
const FIRST_SNOW_IN = 2;  // enough new snow for the thaw to cook
const LIGHT_SNOW = [0.5, 4]; // inches: a coat on top, not a fresh storm (Brian: "6\" is significant")
const STEPS_48H = 6;      // three periods a day (am / pm / night)

/** The window as a time series. Snow-Forecast gives three periods a day, each
 *  with its own snow and temperature; a day without them becomes one step
 *  carrying its high and low, which cannot say which came first but can say
 *  "it thawed and froze that day". */
function steps(win) {
  const out = [];
  for (const d of win) {
    const ps = (d.periods ?? []).filter((p) => typeof p.tempMax === "number");
    if (ps.length) {
      for (const p of ps) {
        const t = cToF(p.tempMax);
        out.push({ snow: cmToIn(p.snow ?? 0), hi: t, lo: t, perDay: ps.length });
      }
    } else if (typeof d.tempMax === "number" && typeof d.tempMin === "number") {
      out.push({ snow: cmToIn(d.snow ?? 0), hi: cToF(d.tempMax), lo: cToF(d.tempMin), perDay: 1, day: true });
    }
  }
  return out;
}

/** "fluffOnCrust", "crustOnFluff", or null.
 *
 *  fluff on crust: new snow, a thaw, a hard freeze, then a light coat — the
 *    thaw-freeze-coat inside 48 hours.
 *  crust on fluff: new snow, a thaw, then very cold, with nothing worth
 *    mentioning falling after the thaw to bury the crust.
 *
 *  The most recent thaw decides, because that is the surface you will ski. */
export function layering(win) {
  const s = steps(win);
  let verdict = null;
  for (let j = 0; j < s.length; j++) {
    if (s[j].hi < THAW_F) continue;
    const before = s.slice(0, j).reduce((a, x) => a + x.snow, 0);
    if (before < FIRST_SNOW_IN) continue;
    // A daily step's own low counts as the night after its high.
    const from = s[j].day ? j : j + 1;
    const after = s.slice(j + 1).reduce((a, x) => a + x.snow, 0);

    // 48 hours from the thaw: six periods, or the next day for a daily step.
    const reach = s[j].day ? 1 : Math.round((STEPS_48H * s[j].perDay) / 3);
    let fluff = false;
    for (let k = from; k < Math.min(s.length, j + reach); k++) {
      if (s[k].lo > HARD_FREEZE_F) continue;
      const coat = s.slice(k + 1, j + reach + 1).reduce((a, x) => a + x.snow, 0);
      if (coat >= LIGHT_SNOW[0] && coat <= LIGHT_SNOW[1]) fluff = true;
      break;
    }
    if (fluff) { verdict = "fluffOnCrust"; continue; }

    const cold = s.slice(from).some((x) => x.lo <= VERY_COLD_F);
    if (cold && after < LIGHT_SNOW[0]) verdict = "crustOnFluff";
    else verdict = null; // buried by a real storm, or never set hard
  }
  return verdict;
}

/** Window extremes in the AUTHORED units (°F, mph, inches) — the copy is
 *  written against those numbers, so the logic reads them too. */
function read(r) {
  const nums = (k) => r.win.map((d) => d[k]).filter((x) => typeof x === "number" && Number.isFinite(x));
  const hiC = nums("tempMax"), loC = nums("tempMin"), wK = nums("windMax");
  const days = r.win.length;
  const totalIn = cmToIn(r.total ?? 0);
  return {
    days,
    totalIn,
    rate: days ? totalIn / days : 0,
    hi: hiC.length ? cToF(Math.max(...hiC)) : null,
    lo: loC.length ? cToF(Math.min(...loC)) : null,
    wind: wK.length ? kmhToMph(Math.max(...wK)) : null,
    // The metric originals, for the shared helpers that speak metric.
    m: {
      hi: hiC.length ? Math.max(...hiC) : null,
      lo: loC.length ? Math.min(...loC) : null,
      wind: wK.length ? Math.max(...wK) : null,
    },
  };
}

/** Same thresholds as constants.js, in the authored units. */
export function snowBucket({ totalIn, rate }) {
  if (totalIn < 0.5) return "none";
  if (totalIn < 2) return "dusting";
  if (totalIn < 5 && rate < 2) return "light";
  if (rate < 4) return "solid";
  if (rate < 8 && totalIn < 30) return "dump";
  return "cycle";
}

/** The temp ladder from verdict.js, plus "spring" broken out as a bucket
 *  rather than a whole-sentence replacement. */
export function tempBucket({ hi, lo }) {
  const warm = hi != null && hi >= 31;
  const cold = lo != null && lo <= 10;
  if (warm && cold) return "mixed";
  if (warm) {
    if (hi > 40) return "spring";
    if (hi >= 38) return "tooWarm";
    if (hi > 34) return "warm";
    return "bitWarm";
  }
  if (cold) {
    if (lo <= -16) return "frigid";
    // Cold plus wind is handled in the "windy" column of the cold rows, so
    // the bucket stays about temperature alone.
    return lo <= 0 ? "deep" : "cold";
  }
  return hi != null && hi >= 20 ? "pleasant" : "fine";
}

export function windBand(wind) {
  if (wind == null || wind < 12) return "calm";
  if (wind < 18) return "light";
  if (wind < 25) return "breezy";
  if (wind < 31) return "stiff";
  if (wind <= 45) return "howling";
  return "gale";
}
const column = (band) =>
  band === "calm" || band === "light" ? "still" : band === "breezy" || band === "stiff" ? "windy" : band;

const region = (id) => {
  const r = RANGES[id];
  if (!r) return null;
  if (r.range === "the Sierra") return "sierra";
  if (r.range === "the Cascades" || r.range === "the Coast Mountains") return "cascades";
  if (r.range === "the Wasatch") return "wasatch";
  if (r.range === "the Rockies" || r.range === "the Canadian Rockies") return "rockies";
  if (r.range === "the Northeast") return "east";
  return null;
};

/** Which so-what pool applies, or null. Exported so tests and the copy sheet
 *  can name the rule that fired. */
export function soWhatKey(x, r) {
  const veto = vetoOf(x.m);
  if (veto === "wind") return "vetoWind";
  if (veto === "cold") return "vetoCold";
  if (veto === "warm") return "vetoWarm";

  const snow = snowBucket(x);
  const snowy = snow === "solid" || snow === "dump" || snow === "cycle";
  const big = snow === "dump" || snow === "cycle";
  const reg = region(r.id);
  const band = windBand(x.wind);

  if (snowy && rainRisk(r)) return "rain";
  const layers = layering(r.win ?? []);
  if (layers) return layers;
  if (snowy && band === "howling") return "stormWind";
  if (snowy && x.hi != null && x.hi > 34) {
    return reg === "sierra" ? "heavySierra" : reg === "cascades" ? "heavyCascades" : reg === "east" ? "heavyEast" : "heavy";
  }
  if (big && x.hi != null && x.hi <= 22) {
    return reg === "wasatch" ? "dryWasatch" : reg === "rockies" ? "dryRockies" : "dry";
  }
  if (big && column(band) === "still") return "go";

  const thin = snow === "none" || snow === "dusting";
  if (thin && x.hi != null && x.hi > 32 && x.lo != null && x.lo < 28) return "corn";
  if (thin && column(band) === "still" && x.hi != null && x.hi < 28) return reg === "east" ? "firmEast" : "firm";
  if (thin && column(band) === "still") return "cruise";

  if (!snowy && tempBucket(x) === "mixed") return "crust";

  const badWind = windSeverity(x.m.wind) === "red";
  const badTemp = tempSeverity(x.m.hi, x.m.lo) === "red";
  if (badWind && badTemp) return "windTemps";
  if (badWind) return "wind";
  if (badTemp) return "temps";
  return null;
}

/** "[hot] plain {token}" → segments. */
function segments(tpl, fill) {
  const s = tpl.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? `{${k}}`);
  const out = [];
  const re = /\[([^\]]+)\]/g;
  let at = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ t: s.slice(at, m.index) });
    out.push({ t: m[1], hot: true });
    at = re.lastIndex;
  }
  if (at < s.length) out.push({ t: s.slice(at) });
  return out;
}

/** The resort sheet's summary, as segments — same shape as resortVerdict(),
 *  so the sheet renders either without knowing which it got. */
export function resortVoice(r, metric) {
  if (!r?.win?.length) return null;
  const x = read(r);
  const seed = `${r.id ?? r.name ?? ""}|${r.win[0]?.date ?? ""}|${x.days}`;
  const band = windBand(x.wind);
  const temp = tempBucket(x);
  const words = WIND_WORDS[band];

  const fill = {
    snow: snowWithUnit(r.total, metric),
    over: x.days === 1 ? "in a single day" : `over ${x.days} days`,
    w: words ? pick(words.w, seed, "w") : "",
    wn: words ? pick(words.wn, seed, "wn") : "",
    t: GALE_TEMP[temp],
  };

  const snowTpl = pick(forWindow(SNOW[snowBucket(x)], x), seed, "snow");
  const condTpl = band === "gale"
    ? pick(GALE, seed, "cond")
    : pick(CONDITIONS[temp][column(band)], seed, "cond");
  const key = soWhatKey(x, r);

  const out = [...segments(snowTpl, fill), { t: " " }, ...segments(condTpl, fill)];
  if (key) out.push({ t: " " }, { t: pick(forWindow(SO_WHAT[key], x), seed, "so") });
  return out;
}
