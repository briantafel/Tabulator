/* ------------------------------------------------------------------ *
 * OnTheSnow first-hand reports, out of the page's Next.js payload.
 *
 * The site is Next.js and server-renders the whole reports list into a
 * <script id="__NEXT_DATA__"> JSON blob. That is a far better target than
 * the markup: no class names to chase when they restyle, and it carries
 * the three fields the rendered HTML makes hardest to get — the
 * reporter's name, a full ISO timestamp, and the photo URL.
 *
 * Shape, verified against a live Snowbird page on 2026-08-25:
 *   props.pageProps.resortReports = {
 *     pagination: { count, limit, page, orderBy, direction },
 *     reportsList: [{ uuid, title, image, largeImage, name, viewCount,
 *                     date, resortUuid, body, translated }]
 *   }
 *
 * `name` and `image` are BOTH nullable — anonymous and photo-less reports
 * are ordinary on the site, not an artefact of how we fetch. The card was
 * already built to degrade for both.
 * ------------------------------------------------------------------ */

/* 2026-10-28: OnTheSnow moved to the Next.js App Router. There is no
 * __NEXT_DATA__ blob any more; the same records now arrive in the React
 * Server Components stream — a series of
 *   self.__next_f.push([1, "<chunk>"])
 * scripts whose decoded chunks join into lines of `<hex id>:<json>`. Objects
 * point at each other with "$<hex id>" strings, so resortReports is
 *   21:{"pagination":"$22","reportsList":"$23"}
 * and has to be put back together before it reads like the old blob. The
 * record shape itself did not change.
 *
 * Both forms are accepted, old first, so a rollback on their side cannot
 * break us either. */

const BLOB = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const FLIGHT = /self\.__next_f\.push\(\[\d+,("(?:[^"\\]|\\.)*")\]\)/g;

/** The old Pages Router payload. Returns null when absent. */
export function nextData(html) {
  const m = BLOB.exec(String(html));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`__NEXT_DATA__ is not valid JSON: ${e.message}`);
  }
}

/** The App Router payload: every row of the RSC stream that parses as JSON,
 *  keyed by its hex id. Returns null when the page has no stream at all. */
export function flightRows(html) {
  let stream = "";
  let m;
  FLIGHT.lastIndex = 0;
  while ((m = FLIGHT.exec(String(html)))) stream += JSON.parse(m[1]);
  if (!stream) return null;
  const rows = new Map();
  for (const line of stream.split("\n")) {
    const id = /^([0-9a-f]+):/.exec(line);
    if (!id) continue;
    try { rows.set(id[1], JSON.parse(line.slice(id[0].length))); } catch { /* not a JSON row */ }
  }
  return rows;
}

/** Follow "$<id>" references back into real values. "$$…" is the stream's
 *  escape for a string that genuinely starts with "$". */
function resolve(rows, v, depth = 0) {
  if (depth > 40) return v;
  if (typeof v === "string") {
    if (v.startsWith("$$")) return v.slice(1);
    const ref = /^\$([0-9a-f]+)$/.exec(v);
    return ref && rows.has(ref[1]) ? resolve(rows, rows.get(ref[1]), depth + 1) : v;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(rows, x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(rows, x, depth + 1)]));
  }
  return v;
}

/** resortReports from whichever form the page is in. Throws loudly: a
 *  reports page we cannot read must never look like a resort with no
 *  reports. */
export function resortReports(html) {
  const data = nextData(html);
  if (data) return data?.props?.pageProps?.resortReports;
  const rows = flightRows(html);
  if (!rows) throw new Error("neither __NEXT_DATA__ nor an RSC stream — the page is not the one we think it is");
  for (const v of rows.values()) {
    if (v && typeof v === "object" && !Array.isArray(v) && "reportsList" in v) return resolve(rows, v);
  }
  return null;
}

const clean = (s) => (typeof s === "string" ? s.trim() : "");

/** One resort's reports, newest first, in Tabulator's own shape.
 *
 *  Anything without a body is dropped: a photo with no words is not a
 *  report, and the card has nothing to say. Anything without a usable date
 *  is dropped too — it could not be windowed, and an undateable report in
 *  a "last 7 days" section is a lie. */
export function parseReportsPage(html, { resortId } = {}) {
  const rr = resortReports(html);
  if (!rr || !Array.isArray(rr.reportsList)) {
    throw new Error("no resortReports.reportsList — wrong page, or the shape moved");
  }

  const out = [];
  for (const r of rr.reportsList) {
    const body = clean(r.body) || clean(r.translated);
    const at = new Date(r.date);
    if (!body || Number.isNaN(+at)) continue;

    const rec = {
      id: r.uuid ? `ots-${r.uuid}` : `${resortId ?? "r"}-${at.toISOString().slice(0, 10)}`,
      at: at.toISOString(),
      text: body,
    };
    // Both optional on the source. Omit rather than carry null, so the
    // fixture says what it has instead of what it lacks.
    const name = clean(r.name);
    if (name) rec.author = name;
    const src = clean(r.image) || clean(r.largeImage);
    if (src) rec.photo = { src };
    out.push(rec);
  }

  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { total: rr.pagination?.count ?? out.length, reports: out };
}
