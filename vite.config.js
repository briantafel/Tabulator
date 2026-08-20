import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project repo from /<repo>/, so the bundle needs that
// base path. Local dev and any root-hosted deploy keep "/".
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  plugins: [react()],
  server: { port: 5173 },
});
