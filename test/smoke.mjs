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

/* Collect real errors only.
 *
 * The two font routes above are aborted on purpose, and an aborted request
 * logs as a console error — counting those would fail the check for a reason
 * we created.
 *
 * Skier-report photos are OnTheSnow CDN URLs, and this sandbox is refused at
 * its proxy for that host, so every one of them fails to load here. That is
 * an environment fact, not a defect: the card hides a photo that will not
 * load, which is the behaviour we actually want when a URL rots. A tunnel
 * failure is therefore not a page error — but a SCRIPT error still is, so the
 * filter is on the transport message only. */
const errors = [];
const ignorable = (t) =>
  /ERR_FAILED|ERR_ABORTED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(t) ||
  /fonts\.(googleapis|gstatic)|s3\.onthesnow\.com/.test(t);
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
  // Both warnings live in Settings now — Brian asked for the pink banner gone
  // and then for the staleness line to join it. Quiet is fine; silent is not.
  // Synthetic data must never pass as a real forecast.
  assert.equal(await page.locator(".banner").count(), 0, "a banner is back over the results");
  await page.locator(".gear").click();
  await page.waitForSelector(".settings");
  const settings = await page.locator(".settings").textContent();
  assert.match(settings, /Sample data/, "nothing anywhere says this is sample data");
  // The staleness line renders in the same place and the same style. It only
  // appears on a stale feed, so this checks the wiring rather than the text.
  const stale = await page.evaluate(() => window.__TABULATOR_FORECAST__?.stale ?? null);
  if (stale) {
    assert.match(settings, /over a day old/, "a stale forecast said nothing about it");
  }
  await page.locator(".gear").click();
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

await check("resorts are ranked on the balance, not on snowfall alone", async () => {
  /* The order is the composite rank now, so the snow column is NOT guaranteed
     to descend — a resort two inches behind can lead on base and weather, and
     that is the whole point of the change. What must hold is that the leading
     row is genuinely the best of them, so the check re-derives the ranking in
     the browser from the app's own module and compares the order. */
  const nums = (await page.locator(".t-snow").allTextContents()).map((t) => parseFloat(t) || 0);
  assert.ok(nums.length > 1, "not enough rows to check an order");
  // The leading row must not be one of Brian's deal breakers. Both the warm
  // veto and the wind veto are readable straight off the table, so this
  // checks the rule against what actually rendered rather than against the
  // model that produced it.
  // The two flagged cells in a row are temp then wind, in that order.
  const lead = page.locator(".t-row").first().locator(".t-flagged");
  const temp = parseFloat((await lead.nth(0).innerText()).replace(/[^\d.-]/g, ""));
  const wind = parseFloat((await lead.nth(1).innerText()).replace(/[^\d.-]/g, ""));
  assert.ok(!(temp > 40), `row 0 leads at ${temp}°F, which Brian vetoed`);
  assert.ok(!(wind > 45), `row 0 leads at ${wind}mph, which Brian vetoed`);

  // And the balance must settle close calls rather than overturn real gaps:
  // among the resorts that are not vetoed, the leader should be near the top
  // of the snow column.
  const open = nums.filter((_, i) => i < nums.length);
  assert.ok(nums[0] >= Math.max(...open) * 0.5,
    `row 0 (${nums[0]}) is far below the deepest (${Math.max(...open)}) — the balance is overpowering the snow`);
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

await check("the grabber maximizes the sheet and the reports scroll", async () => {
  // Brian: "There's a grabber on the resort sheet. I want to be able to
  // maximize that resort sheet. That sheet should become scrollable."
  // Snowbird by name, not .first(): it is the resort the sample reports are
  // attached to, and a resort with none has nothing to scroll.
  await page.locator(".t-row", { hasText: "Snowbird" }).first().click();
  await page.waitForSelector(".sheet");

  const rest = await page.locator(".sheet").boundingBox();
  assert.equal(await page.locator(".reports").count(), 0, "reports showed at rest");

  await page.locator(".sheet-grab").click();
  await page.waitForTimeout(400);
  const tall = await page.locator(".sheet").boundingBox();
  assert.ok(tall.height > rest.height + 100, `sheet did not grow: ${rest.height} -> ${tall.height}`);
  assert.ok(await page.locator(".reports h3").count() > 0, "no skier reports section");

  // The summary Brian added under the bars — tall sheet only, same three
  // highlighted clauses the trip page uses minus the resort's own name.
  await page.waitForSelector(".rs-summary");
  const sum = await page.locator(".rs-summary").innerText();
  assert.match(sum, /^Looking like .+ of snow over \d+ days\. /);
  assert.match(sum, /(Temps look .+, and winds are |It's spring, baby! Winds are )/);
  assert.ok(!/Overall/.test(sum), "the resort summary should not carry the trip page's closing line");
  assert.equal(await page.locator(".rs-summary b").count(), 3,
    "expected three highlighted clauses in the resort summary");

  // The NWS strip. Six columns running the full 402 — it is the one block in
  // the sheet that breaks out of the 22 padding, and the scroller used to
  // clip it back to 358 with no scrollbar to explain where it went.
  await page.waitForSelector(".wx-row");
  const cols = await page.locator(".wx-day").count();
  assert.ok(cols >= 3 && cols <= 6, `expected 3-6 forecast columns, got ${cols}`);
  const row = await page.locator(".wx-row").boundingBox();
  const sheetBox = await page.locator(".sheet").boundingBox();
  assert.ok(Math.abs(row.width - sheetBox.width) < 2,
    `the weather strip is ${row.width} inside a ${sheetBox.width} sheet — it is being clipped again`);
  // Every column has an icon with real path data in it.
  assert.equal(await page.locator(".wx-icon svg path").count() >= cols, true, "a column has no icon");
  assert.equal(await page.locator(".wx-lo").count(), cols);
  assert.equal(await page.locator(".wx-hi").count(), cols);

  /* The measured rhythm, checked against what rendered rather than against
     the stylesheet. Brian caught the first pass on exactly this — "the
     margins and bottom rule should be specific to the text, not a box size"
     — so the gaps between the boxes are the assertion. Every number is an
     ink measurement off his export at 4x. */
  const wxBox = async (sel) => page.locator(sel).first().boundingBox();
  const [sumBox, wx, head, icon, name, cond, lo, hi] = await Promise.all(
    [".rs-summary", ".wx", ".wx h3", ".wx-icon", ".wx-name", ".wx-cond", ".wx-lo", ".wx-hi"].map(wxBox));
  const near = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 1.5, `${what}: ${got.toFixed(2)}, expected ~${want}`);
  near(head.y - (wx.y + 1), 17, "rule to the Weather heading");
  near(icon.y - (head.y + head.height), 35.5, "heading to icons");
  near(name.y - (icon.y + icon.height), 19.4, "icons to day names");
  near(cond.y - (name.y + name.height), 14.7, "day names to conditions");
  near(lo.y - (cond.y + cond.height), 13, "conditions to the low");
  near(hi.y - (lo.y + lo.height), 0, "the two temperatures stack");
  near((wx.y + wx.height - 1) - (hi.y + hi.height), 22, "the high to the closing rule");
  near(wx.y - (sumBox.y + sumBox.height), 17, "the summary to the weather rule");
  // Both new sections are inset 15, not the sheet's 22 — a deliberate
  // difference in his export from the title, the bars and Skier reports.
  const sheet = await wxBox(".sheet");
  near(sumBox.x - sheet.x, 15, "summary inset");
  near(head.x - sheet.x, 15, "Weather heading inset");

  // The action row must stay pinned — the whole point of scrolling the middle.
  const closeBefore = await page.locator(".sheet-close").boundingBox();
  const scrolled = await page.evaluate(() => {
    const b = document.querySelector(".sheet-body");
    b.scrollTop = 400;
    return b.scrollTop;
  });
  assert.ok(scrolled > 100, "the sheet body did not scroll");
  const closeAfter = await page.locator(".sheet-close").boundingBox();
  assert.ok(Math.abs(closeAfter.y - closeBefore.y) < 2, "Close moved while scrolling");

  // The handle must FOLLOW the finger, not jump on release — Brian: "the
  // grabber ... currently doesn't slide to expand". Drag it down by hand and
  // check the sheet is actually shorter mid-gesture, before any release.
  await page.locator(".sheet-grab").click();          // back to rest
  await page.waitForTimeout(400);
  const box = await page.locator(".sheet-grab").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 60, { steps: 6 });
  const midDrag = (await page.locator(".sheet").boundingBox()).height;
  assert.ok(midDrag > rest.height + 40,
    `the sheet did not follow the drag: ${rest.height} -> ${midDrag}`);
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".sheet.max").count(), 1, "the drag did not stick");

  // Brian: "the grabber on the resort sheet should never close the resort
  // sheet. That's what the close button is for." Drag it hard in both
  // directions, well past the sheet's own edges, and it must still be open.
  for (const dy of [-500, 500, -900]) {
    const g = await page.locator(".sheet-grab").boundingBox();
    assert.ok(g, "the sheet closed during a handle drag");
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + dy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    assert.equal(await page.locator(".sheet").count(), 1,
      `a ${dy > 0 ? "downward" : "upward"} drag of ${Math.abs(dy)} closed the sheet`);
  }
  // The backdrop still dismisses — but only for a press that began on it.
  await page.mouse.click(201, 12);
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".sheet").count(), 0, "the backdrop stopped closing the sheet");
  await page.locator(".t-row", { hasText: "Snowbird" }).first().click();
  await page.waitForSelector(".sheet");
  if (await page.locator(".sheet.max").count() === 0) {
    await page.locator(".sheet-grab").click();
    await page.waitForTimeout(400);
  }

  // And back down, with the scroll reset so the resting sheet is intact.
  await page.locator(".sheet-grab").click();
  await page.waitForTimeout(400);
  const back = await page.locator(".sheet").boundingBox();
  assert.ok(Math.abs(back.height - rest.height) < 2, "the sheet did not shrink back");
  assert.equal(
    await page.evaluate(() => document.querySelector(".sheet-body").scrollTop),
    0,
    "restored while still scrolled",
  );
  await page.locator(".sheet-close").click();
  /* Reaching the Snowbird row scrolled the results behind the sheet. Put it
     back: the next check measures the pill against the top of the frame. */
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.scrollingElement.scrollTop = 0;
    document.querySelectorAll(".body, .phone").forEach((e) => { e.scrollTop = 0; });
  });
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
  assert.match(await page.locator(".trips").textContent(), /Set ya faves/);
  // Brian's no-faves export keeps the Edit link and drops the window subtitle.
  assert.equal(await page.locator(".fav-edit").count(), 1, "Edit is drawn even when empty");
  assert.equal(await page.locator(".trips.empty .fav-head p").count(), 0,
    "the empty state should not claim a window it has nothing to show for");
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

  // The panel slides; the action row must NOT — Brian was explicit that the
  // calendar icon and Close stay put while the content slides in from the left.
  const before = await page.evaluate(() => {
    const c = document.querySelector(".sheet-close").getBoundingClientRect();
    const a = document.querySelector(".sheet-add").getBoundingClientRect();
    return [+c.x.toFixed(1), +c.y.toFixed(1), +a.x.toFixed(1), +a.y.toFixed(1)];
  });
  assert.match(
    await page.evaluate(() => getComputedStyle(document.querySelector(".addtrip")).animationName),
    /at-in/, "the panel does not slide in");

  // Naming: New trip becomes an input, ring check until there is something to
  // save, filled once there is, Enter commits.
  await page.locator(".at-new").click();
  await page.waitForSelector(".at-field");
  assert.equal(await page.evaluate(() => document.activeElement?.className), "at-field",
    "the field did not take focus");
  assert.equal(await page.locator(".at-check svg path").count(), 2, "expected the ring check");
  assert.equal(await page.locator(".at-check").isDisabled(), true, "empty name is saveable");

  await page.locator(".at-field").type("Powder week");
  assert.equal(await page.locator(".at-check svg path").count(), 1, "check did not fill");
  assert.equal(await page.locator(".at-check").isDisabled(), false, "a typed name is not saveable");

  const after = await page.evaluate(() => {
    const c = document.querySelector(".sheet-close").getBoundingClientRect();
    const a = document.querySelector(".sheet-add").getBoundingClientRect();
    return [+c.x.toFixed(1), +c.y.toFixed(1), +a.x.toFixed(1), +a.y.toFixed(1)];
  });
  assert.deepEqual(after, before, "Close or the calendar icon moved with the panel");

  await page.locator(".at-field").press("Enter");
  assert.equal(await page.locator(".addtrip").count(), 0, "the panel stayed open");
  await page.locator(".sheet-close").click();

  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".tp-row");
  assert.ok(await page.locator(".tp-name").count() >= 2, "no trip row and New trip row");
  const named = await page.locator(".tp-name").allTextContents();
  assert.ok(named.includes("Powder week"), `the typed name was not saved: ${named.join(", ")}`);

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

await check("a finger over the big numerals can still scroll the page", async () => {
  // Brian: "the page will not scroll, leaving users with a very small window
  // at the bottom". touch-action: pan-x ALONE forbids the vertical gesture
  // instead of passing it to the page; both axes have to be named.
  await page.getByRole("button", { name: /mountains/ }).click();
  const ta = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".wheel")).touchAction);
  assert.ok(/pan-x/.test(ta) && /pan-y/.test(ta),
    `.wheel touch-action is "${ta}" — vertical gestures cannot reach the page`);
});

await check("the Trips screen names a new trip the way the sheet does", async () => {
  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".trip-list");
  const before = await page.locator(".trip-list .tp-row").count();

  await page.locator(".tp-new").click();
  await page.waitForSelector(".tp-field");
  // Ring while empty, filled once there is something to save — same two states
  // as the resort sheet's naming row.
  const paths = () => page.locator(".tp-check svg path").count();
  assert.equal(await paths(), 2, "empty field should show the ring check");
  await page.locator(".tp-field").fill("Powder week");
  assert.equal(await paths(), 1, "typing should fill the check");

  await page.locator(".tp-field").press("Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".tp-field").count(), 0, "the field stayed open");
  assert.equal(await page.locator(".trip-list .tp-row").count(), before + 1,
    "no trip row was added");
  assert.ok(
    (await page.locator(".trip-list .tp-name").allTextContents()).includes("Powder week"),
    "the typed name was not saved",
  );
});

await check("a trip can be renamed, dated and removed", async () => {
  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".trip-list");

  // The New trip row's ghost and its + must share a baseline — a <button>
  // centres its content and put them 20 apart once already.
  const geo = await page.evaluate(() => {
    const n = document.querySelector(".tp-new .tp-name").getBoundingClientRect();
    const p = document.querySelector(".tp-plus").getBoundingClientRect();
    return { nameTop: n.top, base: n.top + 3.22 + 17.08, plusBottom: p.bottom };
  });
  assert.ok(Math.abs(geo.plusBottom - geo.base) < 2,
    `the + foot is ${(geo.plusBottom - geo.base).toFixed(1)} off the text baseline`);

  // Earlier checks have already made trips, so count relative to what is here.
  await page.locator(".tp-new").click();
  await page.locator(".tp-field").fill("VSC trip 2027");
  await page.locator(".tp-field").press("Enter");
  await page.waitForTimeout(250);
  const nTrips = await page.locator(".tp-wrap").count();
  assert.equal(await page.locator(".tp-edit").count(), nTrips,
    "every named trip needs its Edit link");

  // Edit slides the calendar in; picking a range and confirming slides it back.
  await page.locator(".tp-edit").first().click();
  await page.waitForSelector(".tripedit");
  assert.ok(await page.locator(".te-grid .cal-d").count() >= 28, "no month grid");
  const days = page.locator(".te-grid .cal-d");
  await days.nth(6).click();
  await days.nth(10).click();
  assert.ok(await page.locator(".te-grid .cal-d.in").count() >= 4, "no range selected");
  // Deleting from inside the editor asks first, in a system alert.
  await page.locator(".te-trash").click();
  await page.waitForSelector(".ios-alert");
  assert.match(await page.locator(".ios-alert-title").innerText(), /Delete .+ permanently\?/);
  assert.equal(await page.locator(".ios-alert-btn").count(), 2, "expected two actions");
  // The backdrop must dim the whole phone, not just this screen — a
  // transformed ancestor would make it the containing block for position:fixed.
  const dim = await page.evaluate(() => {
    const r = document.querySelector(".ios-scrim").getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             vw: window.innerWidth, vh: window.innerHeight };
  });
  assert.equal(dim.w, dim.vw, "the alert backdrop is not the full width");
  assert.equal(dim.h, dim.vh, "the alert backdrop is not the full height");
  // "No" leaves everything alone.
  await page.locator(".ios-alert-btn").nth(1).click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".ios-alert").count(), 0, "the alert stayed open");
  assert.equal(await page.locator(".tripedit").count(), 1, "No closed the editor");

  await page.locator(".te-check").click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".tripedit").count(), 0, "the editor did not close");
  assert.ok((await page.locator(".tp-when").first().innerText()).length > 0,
    "the trip kept no date label");

  // Tapping the row opens the trip itself.
  await page.locator(".tp-row").first().click();
  await page.waitForSelector(".tripdetail");
  assert.match(await page.locator(".td-head h2").innerText(), /\S/, "the trip has no title");
  // The verdict sentence, with the computed clauses inked and the prose quiet.
  const verdict = await page.locator(".td-verdict").innerText();
  assert.match(verdict, /^Your best bet is looking like /);
  // Two shapes: the usual "Temps look X, and winds are Y", or the spring case,
  // which ends the sentence and starts a new one for the wind.
  assert.match(verdict, /(Temps look .+, and winds are |It's spring, baby! Winds are )/);
  const inked = await page.locator(".td-verdict b").allTextContents();
  assert.equal(inked.length, 4, `expected 4 highlighted clauses, got ${inked.length}`);
  assert.ok(!inked.some((t) => /days/.test(t)), "the day count should stay in the prose");
  // The trips tab is the way back — the design gives the screen no back control.
  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".tripdetail").count(), 0, "the trip screen did not close");
  await page.waitForSelector(".trip-list");

  // Swipe left to uncover the bin, then remove.
  const row = await page.locator(".tp-wrap").first().boundingBox();
  await page.mouse.move(row.x + 300, row.y + 30);
  await page.mouse.down();
  await page.mouse.move(row.x + 160, row.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".tp-wrap.swiped").count(), 1, "the row did not swipe");
  await page.locator(".tp-bin").first().click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".tp-wrap").count(), nTrips - 1, "the trip was not removed");
});

await check("Edit on the Trips screen opens the favourites picker", async () => {
  await page.getByRole("button", { name: /trips/ }).click();
  await page.waitForSelector(".trips");
  const edit = page.getByRole("button", { name: "Edit", exact: true }).first();
  await edit.click();
  await page.waitForSelector(".fs-bar");

  // While picking, the screen is the search bar and nothing else.
  assert.equal(await page.locator(".trip-list").count(), 0, "the trip list stayed up");
  assert.equal(await page.locator(".fav-empty").count(), 0, "the empty copy stayed up");
  assert.equal(await page.locator(".fs-row").count(), 0, "an empty query listed resorts");

  await page.locator(".fs-field").fill("ja");
  await page.waitForTimeout(200);
  const names = await page.locator(".fs-name").allInnerTexts();
  assert.ok(names.length > 0, "nothing matched 'ja'");
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "results are not alphabetical");

  // The star is the control; tapping the row toggles it both ways.
  // Edit toggles back out too — check that before using the check button.
  await edit.click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".fs-bar").count(), 0, "Edit did not close the picker");
  await edit.click();
  await page.waitForSelector(".fs-bar");
  await page.locator(".fs-field").fill("ja");
  await page.waitForTimeout(200);

  const lit = await page.locator(".fs-star.on").count();
  await page.locator(".fs-row").first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".fs-star.on").count(), lit + 1, "the star did not light");
  await page.locator(".fs-row").first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".fs-star.on").count(), lit, "the star did not clear");
  await page.locator(".fs-row").first().click();
  await page.waitForTimeout(150);

  // The check is the way out, and it is there whether or not anything matched.
  assert.equal(await page.locator(".fs-check").count(), 1, "no way out of the picker");
  const check = await page.locator(".fs-check").boundingBox();
  const tabs = await page.locator(".tabs").boundingBox();
  assert.ok(check.y + check.height < tabs.y, "the check overlaps the tab bar");
  assert.ok(tabs.y - (check.y + check.height) < 140, "the check floated away from the tab bar");

  // It confirms the way the trip editor's does: fills, holds, then leaves.
  const picked = names[0];
  await page.locator(".fs-check").click();
  await page.waitForTimeout(80);
  assert.equal(await page.locator(".fs-check.on").count(), 1, "the check did not fill");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".fs-bar").count(), 0, "the picker stayed open");
  await page.waitForSelector(".trips .table");
  const favNames = await page.locator(".trips .t-row").allInnerTexts();
  assert.ok(favNames.some((t) => t.includes(picked)), `${picked} is not in the favourites table`);
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
