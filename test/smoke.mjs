/* End-to-end render check against the production build.
 *
 * Open-Meteo is stubbed, so this runs offline and deterministically. It proves
 * the app boots, fetches, ranks, and renders every screen — not that the live
 * API is up. Run: npm run build && npm run test:smoke */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import assert from "node:assert/strict";
import { makeFixture } from "./fixture.js";

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

/* The sandbox ships a Chromium that may not match the version this Playwright
 * expects. Prefer the preinstalled one when it's there. */
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch(
  existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {}
);
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });

/* The webfont is decoration, and the sandbox has no route to Google Fonts.
 * Abort it explicitly so a network failure can't masquerade as an app error —
 * the app must render legibly on the fallback stack regardless. */
await page.route("**://fonts.{googleapis,gstatic}.com/**", (route) => route.abort());

const errors = [];
const IGNORE = /fonts\.(googleapis|gstatic)\.com|ERR_TUNNEL_CONNECTION_FAILED|net::ERR_FAILED/;
page.on("console", (m) => m.type() === "error" && !IGNORE.test(m.text()) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

// Stub Open-Meteo with the fixture.
let apiCalls = 0;
await page.route("**/api.open-meteo.com/**", (route) => {
  apiCalls++;
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeFixture()) });
});

const step = async (name, fn) => {
  await fn();
  console.log(`  ok  ${name}`);
};

await page.goto(base, { waitUntil: "networkidle" });

await step("app boots and requests the forecast once", async () => {
  assert.equal(apiCalls, 1, `expected 1 API call, saw ${apiCalls}`);
  await page.waitForSelector(".wheel", { timeout: 5000 });
  assert.equal(await page.locator(".loading").count(), 0, "still showing the loading state");
});

await step("the days wheel renders 2 through 14", async () => {
  const ns = await page.locator(".wheel-n").allTextContents();
  assert.deepEqual(ns, Array.from({ length: 13 }, (_, i) => String(i + 2)));
  assert.equal(await page.locator(".wheel-n.on").textContent(), "4", "defaults to 4 days");
});

await step("the arrow reveals a full 23-row table", async () => {
  await page.click('button[aria-label="Show results"]');
  await page.waitForSelector(".t-row");
  assert.equal(await page.locator(".t-row").count(), 23);
  assert.equal(await page.locator(".t-row.best").count(), 1, "exactly one leader");
});

await step("the table is sorted deepest-first", async () => {
  const snow = await page.locator(".t-row .t-snow").allTextContents();
  const nums = snow.map((s) => parseFloat(s));
  for (let i = 1; i < nums.length; i++) {
    assert.ok(nums[i - 1] >= nums[i], `row ${i} breaks the sort: ${nums[i - 1]} then ${nums[i]}`);
  }
});

await step("tapping a row opens the detail sheet, Escape closes it", async () => {
  await page.locator(".t-row").first().click();
  await page.waitForSelector(".sheet");
  assert.equal(await page.locator(".sd").count(), 4, "one row per day in a 4-day window");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".sheet", { state: "detached" });
});

await step("the second page shows the chart with five series", async () => {
  await page.locator('.dots button[aria-label="Chart"]').click();
  await page.waitForSelector(".chart-svg");
  assert.equal(await page.locator(".c-line").count(), 5);
  assert.equal(await page.locator(".ck").count(), 5, "legend matches the series count");
});

await step("saving a window puts it on the trips tab", async () => {
  await page.locator('.dots button[aria-label="Table"]').click();
  await page.click("button.save");
  await page.click('.tabs button:has-text("trips")');
  await page.waitForSelector(".trip");
  assert.equal(await page.locator(".trip").count(), 1);
});

await step("radar draws 12 resorts across 16 days", async () => {
  await page.click('.tabs button:has-text("radar")');
  await page.waitForSelector(".rd-grid");
  assert.equal(await page.locator(".rd-name").count(), 12);
  assert.equal(await page.locator(".rd-col").count(), 16, "forecast days only, no history");
  assert.equal(await page.locator(".rd-cell").count(), 12 * 16);
});

await step("tapping a radar column jumps to a trip on that date", async () => {
  await page.locator(".rd-col").nth(5).click();
  await page.waitForSelector(".cal-grid", { timeout: 5000 });
  assert.equal(await page.locator(".cal-d.start").count(), 1, "start date is marked");
  assert.ok(await page.locator(".t-row").count() > 0, "results carried across");
});

await step("metric toggle converts the numbers", async () => {
  await page.click('button[aria-label="Settings"]');
  const before = await page.locator(".t-row .t-snow").first().textContent();
  await page.click('.pill.sm button:has-text("cm")');
  const after = await page.locator(".t-row .t-snow").first().textContent();
  assert.notEqual(before, after, "switching to centimetres changed nothing");
});

await step("no application console errors along the way", async () => {
  assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
});

await page.screenshot({ path: "test/screenshot.png", fullPage: true });

await browser.close();
server.close();
console.log("\nall smoke checks passed");
