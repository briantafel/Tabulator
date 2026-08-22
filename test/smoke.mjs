/* End-to-end render check against the production build.
 *
 * No network stub any more: the app reads a static forecast.json, and Vite
 * copies public/ into dist/, so serving dist serves the data too. That is
 * itself worth noting — the browser makes no third-party request at runtime,
 * which is the whole reason the scrape had to move server-side.
 *
 * Run: npm run fixture && npm run build && npm run test:smoke */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import assert from "node:assert/strict";

const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(DIST, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch(existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {});
const page = await browser.newPage({ viewport: { width: 430, height: 950 } });

// The webfont is decoration and the sandbox has no route to Google Fonts.
// Abort it explicitly so a network failure can't masquerade as an app error.
await page.route("**://fonts.googleapis.com/**", (r) => r.abort());
await page.route("**://fonts.gstatic.com/**", (r) => r.abort());

/* Collect real errors only. The two font routes above are aborted on purpose,
 * and an aborted request logs as a console error — counting those would make
 * the check fail for a reason we created. */
const errors = [];
const ignorable = (t) => /ERR_FAILED|ERR_ABORTED|fonts\.(googleapis|gstatic)/.test(t);
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !ignorable(m.text()) && errors.push(m.text()));

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

await page.goto(base, { waitUntil: "networkidle" });

await check("app boots and loads the forecast", async () => {
  await page.waitForSelector(".ask", { timeout: 10000 });
  assert.equal(await page.locator(".loading").count(), 0, "still loading");
  assert.equal(await page.locator(".msg").count(), 0, "error state shown");
});

await check("sample data is labelled as such", async () => {
  const banner = await page.locator(".banner").first().textContent();
  assert.match(banner, /Sample data/, "synthetic data must not pass as a real forecast");
});

await check("results render for every resort", async () => {
  await page.locator(".arrow").click();
  await page.waitForSelector(".t-row");
  assert.equal(await page.locator(".t-row").count(), 23);
});

await check("table headers follow the Figma", async () => {
  const head = await page.locator(".t-head").textContent();
  for (const label of ["-3 days", "snow", "↑ temp", "↑ wind"]) {
    assert.ok(head.includes(label), `missing column "${label}" — got: ${head}`);
  }
});

await check("severity markers use shape as well as colour", async () => {
  // Colour alone fails in greyscale and for a colourblind reader, so red is a
  // circle and amber a triangle. Assert both exist and are shaped differently.
  const red = page.locator(".sev-red").first();
  const amber = page.locator(".sev-amber").first();
  assert.ok(await red.count() > 0, "no red markers in the sample data");
  assert.ok(await amber.count() > 0, "no amber markers in the sample data");
  // The colour and shape now live on ::before — the element itself is the
  // fixed-width reserved slot that keeps the number aligned.
  const shape = (el) => el.evaluate((n) => {
    const s = getComputedStyle(n, "::before");
    return { radius: s.borderRadius, clip: s.clipPath, bg: s.backgroundColor,
             w: s.width, slot: getComputedStyle(n).width };
  });
  const r = await shape(red), a = await shape(amber);
  assert.notEqual(r.clip, a.clip, "red and amber must not be the same shape");
  assert.equal(r.slot, a.slot, "both markers must occupy the same reserved slot");
  assert.equal(r.slot, "16px", "slot is 16px, measured from the design PDF");
  assert.match(r.bg, /255,\s*56,\s*60/, `red should be #FF383C, got ${r.bg}`);
  assert.match(a.bg, /255,\s*204,\s*0/, `amber should be #FFCC00, got ${a.bg}`);
});

await check("the explanatory key is gone", async () => {
  // Brian: "We don't need the key, honestly. I believe skiers will know."
  const table = await page.locator(".table").textContent();
  assert.ok(!/above .* or over/.test(table), "the old legend line is still rendering");
});

await check("resorts are ranked by snowfall, deepest first", async () => {
  const nums = await page.locator(".t-snow").allTextContents();
  const vals = nums.map((t) => parseFloat(t) || 0);
  for (let i = 1; i < vals.length; i++) {
    assert.ok(vals[i] <= vals[i - 1], `row ${i} (${vals[i]}) above ${vals[i - 1]}`);
  }
});

await check("metric mode shows no inch mark", async () => {
  // The regression this pass exists to fix.
  await page.locator(".gear").click();
  await page.getByRole("button", { name: "cm / °C" }).click();
  const body = await page.locator(".table").textContent();
  assert.ok(!body.includes("″"), "inch mark leaked into metric mode");
  assert.ok(body.includes("cm"), "expected cm units");
  await page.getByRole("button", { name: "in / °F" }).click();
  await page.locator(".gear").click();
});

await check("detail sheet opens with the forecaster's prose", async () => {
  await page.locator(".t-row").first().click();
  await page.waitForSelector(".sheet");
  assert.ok(await page.locator(".sheet-prose").count() > 0, "no summary text");
  assert.equal(await page.locator(".sd").count(), 4, "expected the 4-day window");
  await page.locator(".sheet-close").click();
});

await check("the mode pill does not move between days and calendar", async () => {
  // Brian: "when I switch to calendar view it jumps down. That's bad UX."
  await page.getByRole("button", { name: /mountains/ }).click();
  const where = () => page.evaluate(() => {
    const go = document.querySelector(".go").getBoundingClientRect();
    const pill = document.querySelector(".pill").getBoundingClientRect();
    const ph = document.querySelector(".phone").getBoundingClientRect();
    // Relative to the phone frame — the viewport may be wider than 402.
    return { top: +go.top.toFixed(1), centre: +(pill.x + pill.width / 2 - ph.x).toFixed(1),
             frame: +ph.width.toFixed(1) };
  });
  const days = await where();
  await page.locator(".pill button").nth(1).click();
  await page.waitForSelector(".cal");
  const cal = await where();
  assert.equal(cal.top, days.top, "the pill row moved between modes");
  assert.equal(cal.centre, days.centre, "the pill is not centred in both modes");
  assert.equal(cal.centre, cal.frame / 2, `pill centre ${cal.centre} in a ${cal.frame} frame`);

  // Every month must be the same height too, or paging jumps the pill instead.
  const h = async () => page.evaluate(() => +document.querySelector(".cal").getBoundingClientRect().height.toFixed(1));
  const first = await h();
  const dots = page.locator(".cal-dots button");
  assert.equal(await dots.count(), 3, "expected three month dots");
  for (let i = 0; i < 3; i++) {
    await dots.nth(i).click();
    assert.equal(await h(), first, `month dot ${i} is a different height`);
  }
  await page.locator(".pill button").first().click();
  await page.waitForSelector(".wheel");
});

await check("range selection is circles joined by one unbroken band", async () => {
  // Brian's Calendar selection PDF: darker circle on each end, lighter band
  // between them, continued to the row edge where the range wraps a line.
  await page.locator(".pill button").nth(1).click();
  await page.waitForSelector(".cal");
  const open = page.locator(".cal-d:not(.off)");
  await open.first().click();
  await open.last().click();

  const shape = await page.evaluate(() => {
    const px = (el, p) => getComputedStyle(el, p);
    const a = document.querySelector(".cal-d.sel-a");
    const b = document.querySelector(".cal-d.sel-b");
    const mid = [...document.querySelectorAll(".cal-d.in")]
      .find((e) => !e.classList.contains("sel-a") && !e.classList.contains("sel-b"));
    const cell = a.getBoundingClientRect();
    return {
      ends: [px(a, "::after").borderRadius, px(b, "::after").borderRadius],
      endBg: px(a, "::after").backgroundColor,
      round: px(a, "::after").width === px(a, "::after").height,
      bandBg: px(mid, "::before").backgroundColor,
      // A middle cell's band must span the WHOLE cell, or the run has gaps.
      bandFull: Math.abs(parseFloat(px(mid, "::before").width) - cell.width) < 0.6,
      bandSquare: px(mid, "::before").borderRadius,
    };
  });
  assert.deepEqual(shape.ends, ["50%", "50%"], "the range ends are not circles");
  assert.ok(shape.round, "the endpoint is an ellipse, not a circle");
  assert.match(shape.endBg, /194,\s*194,\s*194/, `endpoint should be #C2C2C2, got ${shape.endBg}`);
  assert.match(shape.bandBg, /217,\s*217,\s*217/, `band should be #D9D9D9, got ${shape.bandBg}`);
  assert.ok(shape.bandFull, "the band does not fill the cell — the run will have gaps");
  assert.equal(shape.bandSquare, "0px", "the band segments must not be rounded");

  // Picking a date collapses the results; put them back for the checks below.
  await page.locator(".pill button").first().click();
  await page.waitForSelector(".wheel");
  await page.locator(".arrow").click();
  await page.waitForSelector(".t-row");
});

await check("chart page renders", async () => {
  await page.locator(".dots button").nth(1).click();
  await page.waitForSelector(".chart-svg");
  assert.ok(await page.locator(".c-line").count() > 0, "no series drawn");
});

await check("radar shows the six-day horizon", async () => {
  await page.getByRole("button", { name: /radar/ }).click();
  await page.waitForSelector(".rd-cell");
  assert.equal(await page.locator(".rd-col").count(), 6, "expected 6 day columns");
  assert.equal(await page.locator(".rd-name").count(), 12, "expected 12 resorts");
});

await check("trips screen renders empty state", async () => {
  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".fav-head");
  assert.match(await page.locator(".trips").textContent(), /No favourites yet/);
  assert.equal(await page.locator(".fav-edit").count(), 0, "Edit shows with nothing to edit");
});

await check("the star favourites; the calendar-plus opens the trip panel", async () => {
  await page.getByRole("button", { name: /mountains/ }).click();
  await page.locator('.viewtoggle button[aria-label="Table"]').click();
  await page.waitForSelector(".t-row", { timeout: 5000 });
  await page.locator(".t-row").first().click();
  await page.waitForSelector(".sheet");
  const name = await page.locator(".sheet-head h2").textContent();

  // Two different actions. The star must not save anything, and the
  // calendar-plus must not favourite.
  assert.equal(await page.locator(".sheet-star.on").count(), 0, "star starts filled");
  await page.locator(".sheet-star").click();
  assert.equal(await page.locator(".sheet-star.on").count(), 1, "star did not light");
  assert.equal(await page.locator(".addtrip").count(), 0, "the star opened the panel");

  // Brian's bug: the table UNDER the sheet must gain the star immediately,
  // without waiting for the sheet to close.
  const live = await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".t-row")]
      .find((r) => r.textContent.includes(n));
    return row ? !!row.querySelector(".t-star svg") : null;
  }, name.trim());
  assert.equal(live, true, "the row behind the sheet did not gain a star");

  // And every name keeps the same x, starred or not — the star sits in a
  // reserved slot, the same rule the severity markers follow.
  const xs = await page.evaluate(() => [...document.querySelectorAll(".t-row")].map((r) => {
    const t = [...r.querySelector(".t-name").childNodes]
      .find((c) => c.nodeType === 3 && c.textContent.trim());
    const rg = document.createRange(); rg.selectNode(t);
    return +rg.getBoundingClientRect().x.toFixed(1);
  }));
  assert.equal(new Set(xs).size, 1, `names are ragged: ${[...new Set(xs)].join(", ")}`);

  await page.locator(".sheet-add").click();
  await page.waitForSelector(".addtrip");
  assert.equal(await page.locator(".sheet-add.on").count(), 1, "the add icon did not go dark");
  assert.equal(await page.locator(".at-new").count(), 1, "no new-trip row");

  // The panel must not cover the action row — Close stays reachable.
  const clear = await page.evaluate(() => {
    const p = document.querySelector(".addtrip").getBoundingClientRect();
    const c = document.querySelector(".sheet-close").getBoundingClientRect();
    return +(c.top - p.bottom).toFixed(1);
  });
  assert.ok(clear > 20, `panel bottom is only ${clear} above Close`);

  await page.locator(".at-new").click();
  assert.equal(await page.locator(".addtrip").count(), 0, "the panel stayed open");
  await page.locator(".sheet-close").click();

  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".tp-row");
  assert.ok(await page.locator(".tp-name").count() >= 2, "no trip row and New trip row");

  // The favourited resort is listed under Favorites, with Brian's star before
  // the name — and the star is black even on the coral leading row.
  await page.waitForSelector(".t-star");
  const fav = await page.evaluate((n) => {
    const row = [...document.querySelectorAll(".trips .t-row")]
      .find((r) => r.textContent.includes(n));
    if (!row) return null;
    const slot = row.querySelector(".t-star");
    const path = row.querySelector(".t-star path");
    const name2 = row.querySelector(".t-name");
    return { hasStar: !!path,
             starFirst: slot ? name2.firstElementChild === slot : false,
             starColour: path ? getComputedStyle(path).fill : null };
  }, name.trim());
  assert.ok(fav && fav.hasStar, `${name} is not listed under Favorites`);
  assert.ok(fav.starFirst, "the star must come before the name");
  assert.match(fav.starColour, /17,\s*17,\s*17/, `star should be ink, got ${fav.starColour}`);

  await page.getByRole("button", { name: /mountains/ }).click();
  await page.waitForSelector(".t-row");
});

await check("no console or page errors throughout", () => {
  assert.deepEqual(errors, []);
});

await page.getByRole("button", { name: /mountains/ }).click();
// The chart page is still selected from an earlier check — go back to the
// table so the screenshot shows the primary screen.
await page.locator(".dots button").first().click();
await page.waitForSelector(".t-row");
await page.screenshot({ path: new URL("./screenshot.png", import.meta.url).pathname, fullPage: true });

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
