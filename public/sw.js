/* Why this exists.
 *
 * Brian, 2026-08-27: "the mobile version i have isn't refreshing on iOS."
 *
 * The deploy was fine — weather.json from that build was already live. What
 * was stale was index.html. Vite hashes the JS and CSS filenames, so those
 * can never go stale on their own; the ONLY thing that tells the browser
 * which hash to load is the document. GitHub Pages serves it with a ten
 * minute max-age and no way to change that, and an iOS home-screen app holds
 * the document far longer than that — so the phone kept loading last week's
 * bundle from a perfectly up-to-date server.
 *
 * The fix is network-first for the document and for the data, cache-first for
 * the hashed assets. That inverts the usual offline-first advice on purpose:
 * this app is a decision tool for a trip, and a silently stale forecast is
 * worse than a spinner. The cache exists so it still opens on a chairlift
 * with no signal, not so it can serve yesterday's snow.
 *
 * SKIP_WAITING + clients.claim: a new worker takes over on the next launch
 * rather than waiting for every tab to close, which on a home-screen app is
 * "never".
 */

const VERSION = "__BUILD__";
const CACHE = `tabulator-${VERSION}`;

/* Anything with a content hash in its name is safe to serve from cache
   forever — a new build has a different name. */
const isHashed = (url) => /\/assets\/.*-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg)$/.test(url);

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // One cache per build; drop every older one rather than growing forever.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isHashed(url.pathname)) {
    // Cache-first: the name IS the version, so a hit is always correct.
    e.respondWith((async () => {
      const hit = await caches.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    })());
    return;
  }

  /* Everything else — the document, the manifest, the four JSON feeds —
     network first, falling back to the cache only when the network actually
     fails. That is the whole fix: a reachable server always wins. */
  e.respondWith((async () => {
    try {
      const res = await fetch(request, { cache: "no-store" });
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(request);
      if (hit) return hit;
      throw err;
    }
  })());
});
