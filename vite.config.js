import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile } from "node:fs/promises";

/* One identifier per build, shown in Settings and used as the service
   worker's cache name. The commit SHA in CI, a timestamp locally — either
   way it changes when the build changes, which is the only property that
   matters. */
const BUILD = (process.env.GITHUB_SHA || "").slice(0, 7) ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/* public/ is copied verbatim, so the worker's version has to be written in
   afterwards. Without this every deploy would reuse one cache name and the
   worker would never notice it had been replaced — the exact bug it exists
   to fix, one level down. */
const stampServiceWorker = () => ({
  name: "stamp-service-worker",
  apply: "build",
  async closeBundle() {
    const out = new URL("./dist/sw.js", import.meta.url).pathname;
    try {
      const src = await readFile(out, "utf8");
      await writeFile(out, src.replace("__BUILD__", BUILD));
    } catch {
      throw new Error("dist/sw.js is missing — the service worker did not ship");
    }
  },
});

// GitHub Pages serves a project repo from /<repo>/, so the bundle needs that
// base path. Local dev and any root-hosted deploy keep "/".
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [react(), stampServiceWorker()],
  define: { "import.meta.env.VITE_BUILD": JSON.stringify(BUILD) },
  server: { port: 5173 },
});
