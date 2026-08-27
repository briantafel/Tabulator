import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")
);

test("the page declares itself installable on iOS", () => {
  for (const tag of [
    'name="apple-mobile-web-app-capable" content="yes"',
    'name="apple-mobile-web-app-title" content="Tabulator"',
    'rel="apple-touch-icon"',
    'rel="manifest"',
  ]) {
    assert.ok(html.includes(tag), `index.html is missing ${tag}`);
  }
});

test("viewport-fit is cover, so the design frame maps to the whole screen", () => {
  // The design is drawn at 402x874 — the full device screen, status bar and
  // home indicator included. Without viewport-fit=cover the standalone app
  // gets letterboxed and every measured offset is wrong.
  assert.match(html, /viewport-fit=cover/);
});

test("asset paths go through Vite's base, so a subpath deploy still resolves", () => {
  // GitHub Pages serves this from /Tabulator/, not the root.
  for (const m of html.match(/(href|src)="([^"]*)"/g) ?? []) {
    if (/manifest|icon-/.test(m)) assert.match(m, /%BASE_URL%/, `${m} is not base-relative`);
  }
});

test("the manifest is standalone, portrait, and carries both icon sizes", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait");
  // Relative, so they resolve under whatever base the manifest is served from.
  for (const i of manifest.icons) assert.ok(!i.src.startsWith("/"), `${i.src} must be relative`);
  const sizes = manifest.icons.map((i) => i.sizes);
  for (const s of ["192x192", "512x512"]) assert.ok(sizes.includes(s), `no ${s} icon`);
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "no maskable icon");
});

/* ------------------------------------------------------------------
 * The service worker. Brian, 2026-08-27: "the mobile version i have isn't
 * refreshing on iOS." The deploy was live and correct; the phone was holding
 * a cached index.html and therefore loading an old hashed bundle.
 * ------------------------------------------------------------------ */

test("the worker ships, and ships stamped", async () => {
  const src = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(src, /__BUILD__/, "the placeholder must be in the source for the plugin to replace");

  // And must NOT survive the build: an unstamped worker reuses one cache name
  // for every deploy and never notices it has been replaced — the same bug it
  // exists to fix, one level down.
  const built = await readFile(new URL("../dist/sw.js", import.meta.url), "utf8").catch(() => null);
  if (built) {
    assert.ok(!built.includes("__BUILD__"), "dist/sw.js was never stamped with a build id");
    assert.match(built, /const VERSION = "[^"]+"/);
  }
});

test("the document and the data are network-first, not cache-first", async () => {
  const src = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  // Only content-hashed asset URLs may be served from cache without asking.
  assert.match(src, /isHashed/, "no hashed-asset test — everything would be treated alike");
  const hashLine = src.split("\n").find((l) => l.includes("const isHashed"));
  assert.ok(hashLine && hashLine.includes("assets") && /\{8,\}/.test(hashLine),
    `isHashed must match a content-hashed asset path, got: ${hashLine}`);
  // The fallback path is the failure path, not the happy path.
  const fetchBlock = src.slice(src.indexOf("Everything else"));
  assert.ok(
    fetchBlock.indexOf("await fetch(request") < fetchBlock.indexOf("caches.match"),
    "the worker reaches for the cache before the network — that is offline-first, and a "
    + "silently stale forecast is worse than a spinner in a trip-planning app",
  );
  assert.match(src, /skipWaiting/, "a new worker would wait for every tab to close, i.e. forever");
  assert.match(src, /clients\.claim/);
});

test("old caches are dropped, not accumulated", async () => {
  const src = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(src, /caches\.keys\(\)/);
  assert.match(src, /caches\.delete/);
});
