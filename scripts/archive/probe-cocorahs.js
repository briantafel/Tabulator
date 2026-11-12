/* Temporary probe (2026-11-12): what do the Canadian CoCoRaHS range queries return? Delete after use. */
import { reportsUrl } from "./cocorahs.js";
export async function collect({ log }) {
  for (const st of ["UT", "BC", "AB", "QC", "ON"]) {
    const t0 = Date.now();
    const r = await fetch(reportsUrl(st, "StartDate=1/1/2025&EndDate=1/3/2025"), { signal: AbortSignal.timeout(300e3) });
    const t = await r.text();
    const lines = t.trim().split("\n").slice(1);
    const dates = new Set(lines.map((l) => l.split(",")[0]));
    const pre = {};
    for (const l of lines) { const p = (l.split(",")[3] ?? "").trim().split("-").slice(0, 2).join("-"); pre[p] = (pre[p] || 0) + 1; }
    const top = Object.entries(pre).sort((a, b) => b[1] - a[1]).slice(0, 6);
    log(`${st}: HTTP ${r.status} ${(t.length / 1e6).toFixed(1)} MB ${lines.length} rows, ${dates.size} dates ${[...dates].sort()[0]}..${[...dates].sort().pop()} ${(Date.now() - t0) / 1000}s top ${JSON.stringify(top)}`);
  }
  return { ok: true };
}
