import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
