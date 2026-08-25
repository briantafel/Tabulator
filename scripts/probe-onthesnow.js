#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * A one-shot look at an OnTheSnow reports page, from a network that can
 * actually reach it.
 *
 * Why this exists: the dev sandbox gets a 403 at its proxy for
 * onthesnow.com, and the one fetcher that does reach the site converts
 * the page to markdown — which drops every <img> and every byline. So
 * the report TEXT could be harvested but the photos and reporter names
 * could not, and no parser can be written against markdown.
 *
 * GitHub's runners have no such proxy. This script fetches the page the
 * way the real scraper would, writes the bytes to disk for download, and
 * prints enough structure to the log that the parser can be written from
 * the log alone if the artifact download is inconvenient.
 *
 * It answers one question above all: IS THE REPORT LIST IN THE HTML AT
 * ALL, or does the page load it client-side? If it is not there, HTML
 * scraping is a dead end and the embedded JSON blob is the way in.
 *
 *   node scripts/probe-onthesnow.js [url] [outfile]
 * ------------------------------------------------------------------ */

import { writeFile } from "node:fs/promises";

const URL_ = process.argv[2]
  ?? "https://www.onthesnow.com/utah/snowbird/ski-report-reviews";
const OUT = process.argv[3] ?? "onthesnow-page.html";
const UA = "Tabulator/1.0 (personal ski-trip planner; low volume; one-off probe)";

/* A phrase known to be on the live page. If it is missing from the HTML,
   the reports are client-rendered and the scraper needs the JSON, not the
   markup. Overridable so the probe stays useful on other resorts. */
const CANARY = process.env.PROBE_CANARY ?? "Nuff seen";

const res = await fetch(URL_, {
  headers: { "User-Agent": UA, "Accept-Language": "en", Accept: "text/html" },
});
const html = await res.text();
await writeFile(OUT, html);

const say = (...a) => console.log(...a);
say(`GET ${URL_}`);
say(`  status   ${res.status} ${res.statusText}`);
say(`  type     ${res.headers.get("content-type")}`);
say(`  bytes    ${html.length}`);
say("");

/* --- is the content server-rendered? ------------------------------- */
say(`canary "${CANARY}" in HTML: ${html.includes(CANARY) ? "YES" : "NO"}`);
if (!html.includes(CANARY)) {
  say("  -> the reports are NOT in the served HTML. Look at the JSON blobs");
  say("     below, or at whatever XHR the page makes, not at the markup.");
}
say("");

/* --- embedded JSON, which is usually the easier target ------------- */
for (const id of ["__NEXT_DATA__", "__NUXT__", "__APOLLO_STATE__"]) {
  const at = html.indexOf(id);
  say(`${id}: ${at === -1 ? "absent" : `present at ${at}`}`);
}
const ldjson = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
say(`ld+json blocks: ${ldjson.length}`);
for (const [, body] of ldjson.slice(0, 3)) {
  try {
    const j = JSON.parse(body.trim());
    say(`  @type ${JSON.stringify(j["@type"] ?? Object.keys(j).slice(0, 6))}`);
  } catch { say("  (unparseable)"); }
}
say("");

/* --- images, which is what this is all for ------------------------- */
const srcs = new Set();
for (const m of html.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi)) srcs.add(m[1]);
for (const m of html.matchAll(/["'](https?:\/\/[^"']*?\.(?:jpe?g|png|webp|avif)(?:\?[^"']*)?)["']/gi)) {
  srcs.add(m[1]);
}
const list = [...srcs];
say(`image URLs found: ${list.length}`);
const host = (u) => { try { return new (globalThis.URL)(u, URL_).host; } catch { return "?"; } };
const byHost = {};
for (const u of list) byHost[host(u)] = (byHost[host(u)] ?? 0) + 1;
for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1])) say(`  ${n.toString().padStart(4)}  ${h}`);
say("  first 25:");
for (const u of list.slice(0, 25)) say(`    ${u}`);
say("");

/* --- candidate containers ------------------------------------------ */
const attrs = new Map();
for (const m of html.matchAll(/\b(?:class|data-testid|data-cy|id)=["']([^"']+)["']/gi)) {
  for (const tok of m[1].split(/\s+/)) {
    if (/review|report|firsthand|first-hand|comment|photo|card|user/i.test(tok)) {
      attrs.set(tok, (attrs.get(tok) ?? 0) + 1);
    }
  }
}
say(`attribute tokens that look like a report card (${attrs.size}):`);
for (const [tok, n] of [...attrs].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  say(`  ${n.toString().padStart(4)}  ${tok}`);
}
say("");
say(`wrote ${OUT} — download it from the run's Artifacts and send it over.`);

/* Loud on failure, same rule as the scraper. A 403 that exits zero reads as
   "probed successfully, found nothing", which is the opposite of the truth.
   The workflow uploads the artifact with if: always(), so the bytes survive
   the non-zero exit and the error page itself is worth reading. */
if (!res.ok) {
  console.error(`\nFAILED: HTTP ${res.status}. The body is in ${OUT} — if it is a`);
  console.error("challenge or consent page, the scraper needs to deal with that first.");
  process.exit(1);
}
