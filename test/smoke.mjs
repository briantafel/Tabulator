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
  await page.waitForSelector(".screen-h");
  assert.match(await page.locator(".trips").textContent(), /Nothing saved yet/);
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
