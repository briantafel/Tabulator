#!/usr/bin/env node
/* Bundles the built app plus a dataset into ONE self-contained HTML file.
 * No fetch, no relative assets — it runs from a single file anywhere.
 * Used to publish a shareable snapshot; the deployed app is unaffected. */

import { readFile, writeFile, readdir } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const dataPath = process.argv[2] ?? `${root}public/forecast.json`;
const histPath = process.argv[3] ?? `${root}public/history.json`;
const out = process.argv[4] ?? `${root}snapshot.html`;

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
</script>
<script type="module">${js}</script>
`);
console.error(`wrote ${out}`);
