/* global window, document, DOMParser */
/* ------------------------------------------------------------------ *
 * Snow-Forecast hindcast pull — runs INSIDE Brian's own Chrome tab on
 * snow-forecast.com, using his existing login. Not run by Node.
 *
 * The hindcast pages are subscriber-only, so the GitHub Action cannot
 * fetch them, and his password must never go into a script. This runs in
 * a logged-in tab instead: one page at a time, slowly, keeping only the
 * hindcast table (stripped of styling and scripts) plus its date range.
 *
 *   __hc.start({ slugs, dates, tier })   begin (returns at once; runs in the background)
 *   __hc.status()                        progress
 *   __hc.stop()                          pause after the current page
 *   __hc.exportFile(name)                download everything so far as .ndjson.gz
 *
 * Stops by itself if the session logs out (a login redirect) or if pages
 * keep failing, so it can never quietly fill a file with login screens.
 * The file goes to the private R2 bucket only — subscriber data is never
 * committed to the public repo.
 * ------------------------------------------------------------------ */

(() => {
  const KEEP = new Set(["class", "colspan", "alt", "data-speed", "transform"]);
  const st = { lines: [], done: 0, total: 0, skipped: [], errors: [], running: false, stopReason: null, startedAt: null };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function strip(table) {
    table.querySelectorAll("tr.flgraph, script, style").forEach((e) => e.remove());
    table.querySelectorAll("*").forEach((e) => {
      for (const a of [...e.attributes]) if (!KEEP.has(a.name)) e.removeAttribute(a.name);
    });
    return table.outerHTML.replace(/\s+/g, " ");
  }

  async function one(slug, date, tier) {
    const res = await fetch(`/resorts/${slug}/hindcasts/${date}/${tier}`, { credentials: "include" });
    const url = res.url;
    if (/\/login/.test(url)) return { kind: "logout" };
    if (!/\/hindcasts\//.test(url)) return { kind: "skip" }; // not a window start: redirected to the resort page
    if (!res.ok) return { kind: "error", msg: `HTTP ${res.status}` };
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const table = doc.querySelector("table.forecasts");
    if (!table) return { kind: "error", msg: "no table.forecasts" };
    const range = (doc.body.textContent.match(/periods\s+(\d{4}-\d{2}-\d{2})\s+through\s+(\d{4}-\d{2}-\d{2})/) || []);
    if (!range[1]) return { kind: "error", msg: "no date range on page" };
    return {
      kind: "ok",
      line: JSON.stringify({
        slug, tier, requested: date, from: range[1], through: range[2],
        title: doc.title, fetchedAt: new Date().toISOString(), table: strip(table),
      }),
    };
  }

  async function loop({ slugs, dates, tier = "mid", delayMs = 2500 }) {
    const seen = new Set(st.lines.map((l) => { const o = JSON.parse(l); return `${o.slug}|${o.requested}|${o.tier}`; }));
    const jobs = slugs.flatMap((s) => dates.map((d) => [s, d])).filter(([s, d]) => !seen.has(`${s}|${d}|${tier}`));
    st.total = st.done + jobs.length;
    st.running = true;
    st.stopReason = null;
    st.startedAt ??= new Date().toISOString();
    let failsInARow = 0;
    for (const [slug, date] of jobs) {
      if (!st.running) { st.stopReason ??= "stopped by request"; break; }
      let r;
      try { r = await one(slug, date, tier); } catch (e) { r = { kind: "error", msg: e.message }; }
      if (r.kind === "logout") { st.stopReason = "logged out — log in again, then start() resumes where it left off"; break; }
      if (r.kind === "ok") { st.lines.push(r.line); failsInARow = 0; }
      if (r.kind === "skip") st.skipped.push(`${slug} ${date}`);
      if (r.kind === "error") {
        st.errors.push(`${slug} ${date}: ${r.msg}`);
        if (++failsInARow >= 5) { st.stopReason = "5 failures in a row — paused"; break; }
      }
      st.done++;
      await sleep(delayMs + Math.random() * 1000);
    }
    st.running = false;
    st.stopReason ??= "finished";
  }

  window.__hc = {
    start(cfg) { if (!st.running) loop(cfg); return this.status(); },
    stop() { st.running = false; return "stopping after the current page"; },
    status() {
      const bytes = st.lines.reduce((a, l) => a + l.length, 0);
      return { running: st.running, done: st.done, total: st.total, pages: st.lines.length,
        skipped: st.skipped.length, errors: st.errors.slice(-5), errorCount: st.errors.length,
        stopReason: st.stopReason, megabytes: +(bytes / 1e6).toFixed(1), startedAt: st.startedAt };
    },
    async exportFile(name = "sf-hindcast.ndjson.gz") {
      const blob = new Blob([st.lines.join("\n") + "\n"]);
      const gz = await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(gz), download: name });
      document.body.appendChild(a); a.click(); a.remove();
      return { file: name, pages: st.lines.length, megabytes: +(gz.size / 1e6).toFixed(1) };
    },
  };
  return "hindcast runner loaded";
})();
