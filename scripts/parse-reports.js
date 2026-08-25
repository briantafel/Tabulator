/* ------------------------------------------------------------------ *
 * OnTheSnow first-hand reports, out of the page's __NEXT_DATA__.
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

const BLOB = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/** Pulls the Next.js payload out of a page. Throws loudly: a reports page
 *  with no blob means the site changed shape, and a scraper that returns
 *  [] in that case looks exactly like a resort with no reports. */
export function nextData(html) {
  const m = BLOB.exec(String(html));
  if (!m) throw new Error("no __NEXT_DATA__ blob — the page is not the one we think it is");
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`__NEXT_DATA__ is not valid JSON: ${e.message}`);
  }
}

const clean = (s) => (typeof s === "string" ? s.trim() : "");

/** One resort's reports, newest first, in Tabulator's own shape.
 *
 *  Anything without a body is dropped: a photo with no words is not a
 *  report, and the card has nothing to say. Anything without a usable date
 *  is dropped too — it could not be windowed, and an undateable report in
 *  a "last 5 days" section is a lie. */
export function parseReportsPage(html, { resortId } = {}) {
  const data = nextData(html);
  const rr = data?.props?.pageProps?.resortReports;
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
