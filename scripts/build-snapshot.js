#!/usr/bin/env node
/* Bundles the built app plus a dataset into ONE self-contained HTML file.
 * No fetch, no relative assets — it runs from a single file anywhere.
 * Used to publish a shareable snapshot; the deployed app is unaffected. */

import { readFile, writeFile, readdir } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dataPath = process.argv[2] ?? `${root}public/forecast.json`;
const histPath = process.argv[3] ?? `${root}public/history.json`;
const out = process.argv[4] ?? `${root}snapshot.html`;
const reportsPath = process.argv[5] ?? `${root}public/reports.json`;
/* Optional 6th argument: a map of report id -> { w, h, src(data URI) }.
 * Report photos live on OnTheSnow's CDN, which is right for the deployed app
 * — zero repo weight, and the browser fetches them lazily. It is wrong for a
 * published snapshot, which must run with NO network at all, and wrong for an
 * artifact, whose CSP refuses every external host outright. So the snapshot
 * swaps the URLs for inlined bytes at build time and the repo keeps the URLs. */
const photosPath = process.argv[6] ?? null;

const assets = await readdir(`${root}dist/assets`);
const js = await readFile(`${root}dist/assets/${assets.find((f) => f.endsWith(".js"))}`, "utf8");
let css = await readFile(`${root}dist/assets/${assets.find((f) => f.endsWith(".css"))}`, "utf8");

/* Inline the self-hosted fonts so the file works with no network at all.
 *
 * Drop the .woff fallback FIRST, taking its leading comma with it. Removing
 * the url() alone leaves `src:url(...) format("woff2"),}` — a trailing comma
 * that invalidates the @font-face and, in Chrome, swallows every rule after
 * it. That failure looks exactly like "the CSS did not load". */
css = css.replace(/,\s*url\([^)]*\.woff\)\s*format\("woff"\)/g, "");
for (const f of assets.filter((f) => f.endsWith(".woff2"))) {
  const b64 = (await readFile(`${root}dist/assets/${f}`)).toString("base64");
  css = css.split(`/assets/${f}`).join(`data:font/woff2;base64,${b64}`);
}
if (/\/assets\/[^)"']*\.(woff2?|png|svg)/.test(css)) {
  throw new Error("an asset URL survived inlining — the snapshot would not be self-contained");
}
/* A dangling comma or unbalanced brace makes Chrome discard every rule after
   it, which presents as "the stylesheet never loaded" rather than as a parse
   error. Cheap to check, and it shipped once. */
for (const bad of [",}", ",;", "()", "url()"]) {
  if (css.includes(bad)) throw new Error(`malformed CSS: found "${bad}" after inlining`);
}
const braces = (css.match(/{/g) || []).length - (css.match(/}/g) || []).length;
if (braces !== 0) throw new Error(`malformed CSS: ${braces} unbalanced brace(s)`);
const ruleCount = (css.match(/}/g) || []).length;
if (ruleCount < 50) throw new Error(`only ${ruleCount} CSS blocks — the stylesheet looks truncated`);
console.error(`css ok: ${ruleCount} blocks, ${(css.length / 1024) | 0}KB, fonts inlined`);
const forecast = JSON.parse(await readFile(dataPath, "utf8"));
const history = JSON.parse(await readFile(histPath, "utf8"));
/* Optional: a snapshot with no reports file still runs, it just shows the
   empty state. The photos are already data URIs inside this JSON, which is
   why the file is large and why it needs no assets alongside it. */
const reports = await readFile(reportsPath, "utf8").then(JSON.parse, () => ({ resorts: {} }));
/* Optional like the reports: a build with no weather.json is a valid build,
   and every resort simply renders without the strip. */
const weatherPath = process.argv[7] ?? `${root}public/weather.json`;
const weather = await readFile(weatherPath, "utf8").then(JSON.parse, () => ({ resorts: {} }));
if (photosPath) {
  const photos = JSON.parse(await readFile(photosPath, "utf8"));
  let swapped = 0, dropped = 0;
  for (const [id, list] of Object.entries(reports.resorts ?? {})) {
    reports.resorts[id] = list.filter((r) => {
      if (!r.photo) return true;
      const p = photos[r.id];
      if (p) { r.photo = p; swapped++; return true; }
      /* No local copy, and a remote URL cannot load here. Drop the photo
         rather than ship a card that renders an empty frame. */
      delete r.photo; dropped++; return true;
    });
  }
  console.error(`photos: ${swapped} inlined, ${dropped} left without one`);
}

// </script> inside embedded JSON would close the tag early.
const safe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

/* No font <link>: Inter is inlined above. A remote stylesheet here would
   also be the only network request the file makes. */
await writeFile(out, `<title>Tabulator</title>
<style>${css}</style>
<div id="root"></div>
<script>
window.__TABULATOR_FORECAST__ = ${safe(forecast)};
window.__TABULATOR_HISTORY__ = ${safe(history)};
window.__TABULATOR_REPORTS__ = ${safe(reports)};
window.__TABULATOR_WEATHER__ = ${safe(weather)};
</script>
<script type="module">${js}</script>
`);
console.error(`wrote ${out}`);
