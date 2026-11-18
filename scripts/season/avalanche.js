/* ------------------------------------------------------------------ *
 * Avalanche danger near each resort, for Shaping up
 * (claude/calendar-shaping-up-plan.md).
 *
 *   US      avalanche.org public v2 API (no key): the map layer gives every
 *           forecast zone's polygon; the resort's point picks its zone; the
 *           zone's current forecast product gives danger by elevation band
 *           and the avalanche problems listed.
 *   Canada  Avalanche Canada (avcan-services-api.prod.avalanche.ca), the
 *           point endpoint: the forecast product for the resort's point.
 *
 * Danger is 1–5 (Low…Extreme); null means no rating (off season, or the
 * center has not issued one). Never 0: "no rating" is not "low".
 *
 * These ratings are for the backcountry. Ski patrol controls terrain inside
 * the resort; the app says so wherever it shows them.
 * ------------------------------------------------------------------ */


const CA_RATING = { low: 1, moderate: 2, considerable: 3, high: 4, extreme: 5 };
const level = (v) => (typeof v === "number" && v >= 1 && v <= 5 ? v : null);

/** Ray casting on [lon, lat] rings. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inGeometry(pt, g) {
  if (!g) return false;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some(([outer, ...holes]) => inRing(pt, outer) && !holes.some((h) => inRing(pt, h)));
}

/** The avalanche.org zone a point falls in, from the map layer. */
export function zoneFor([lat, lon], layer) {
  const f = (layer?.features ?? []).find((x) => inGeometry([lon, lat], x.geometry));
  if (!f) return null;
  const p = f.properties ?? {};
  return {
    zoneId: f.id ?? null, zone: p.name ?? null, centerId: p.center_id ?? null, center: p.center ?? null,
    link: p.link ?? p.center_link ?? null, offSeason: !!p.off_season, mapLevel: level(p.danger_level),
  };
}

const PERSISTENT = /persistent/i;

/** avalanche.org forecast product → bands, problems. Shape documented by
 *  the National Avalanche Center: danger[] of {lower, middle, upper,
 *  valid_day}, forecast_avalanche_problems[] of {name, likelihood, size,
 *  location}. Empty arrays (off season) give nulls. */
export function parseAvorgProduct(p) {
  const today = (p?.danger ?? []).find((d) => d.valid_day === "current") ?? p?.danger?.[0] ?? null;
  const bands = today ? { upper: level(today.upper), middle: level(today.middle), lower: level(today.lower) } : null;
  const problems = (p?.forecast_avalanche_problems ?? [])
    .slice().sort((a, b) => (a.rank ?? 9) - (b.rank ?? 9))
    .map((x) => x.name).filter(Boolean);
  return {
    issued: p?.published_time ?? null, expires: p?.expires_time ?? null,
    bands, problems, persistent: problems.some((n) => PERSISTENT.test(n)),
  };
}

/** Avalanche Canada point product → the same shape. */
export function parseAvcanProduct(p) {
  const r = p?.report ?? {};
  const first = (r.dangerRatings ?? [])[0];
  const v = (k) => CA_RATING[String(first?.ratings?.[k]?.rating?.value ?? "").toLowerCase()] ?? null;
  const bands = first ? { upper: v("alp"), middle: v("tln"), lower: v("btl") } : null;
  const problems = (r.problems ?? []).map((x) => x?.type?.display ?? x?.header ?? x?.name ?? null).filter(Boolean);
  return {
    issued: r.dateIssued ?? null, expires: r.validUntil ?? null,
    bands, problems, persistent: problems.some((n) => PERSISTENT.test(n)),
    zone: p?.area?.name ?? null, link: p?.url ?? null, center: "Avalanche Canada",
  };
}

export const maxBand = (b) => {
  const xs = b ? [b.upper, b.middle, b.lower].filter((x) => typeof x === "number") : [];
  return xs.length ? Math.max(...xs) : null;
};

/** Carry the last 14 days of the highest danger forward from the previous
 *  file, so the app can draw a trend without an archive read. */
export function withHistory(prevEntry, today, max) {
  const hist = (prevEntry?.history ?? []).filter(([d]) => d !== today);
  hist.push([today, max]);
  return hist.slice(-14);
}

/* Utah Avalanche Center (2026-11-18). UAC's zones come through avalanche.org's
 * map layer with an overall level only; its product there has no danger, so
 * the elevation chart was empty. UAC publishes its own documented feed:
 * https://utahavalanchecenter.org/docs/api/forecast →
 * https://utahavalanchecenter.org/forecast/<region>/json, with
 * `overall_danger_rose`: 24 values, 3 elevation rings × 8 aspects, starting
 * at the HIGHEST ring, north, clockwise. 0 none, 1 pockets of Low, 2 Low,
 * 3 pockets of Moderate, 4 Moderate … 9 pockets of Extreme, 10 Extreme.
 * A ring's band is its worst aspect; "pockets of X" counts as X (rounding up,
 * the safe direction). */
export const uacSlug = (link) => (link ?? "").match(/utahavalanchecenter\.org\/forecast\/([a-z-]+)/)?.[1] ?? null;

function findKey(o, key, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return undefined;
  if (key in o) return o[key];
  for (const v of Object.values(o)) {
    const r = findKey(v, key, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function parseUacForecast(json) {
  const raw = findKey(json, "overall_danger_rose");
  const rose = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/)).map(Number).filter((n) => Number.isFinite(n));
  if (rose.length !== 24) return null;
  const ring = (i) => {
    const m = Math.max(...rose.slice(i * 8, i * 8 + 8));
    return m > 0 ? Math.min(5, Math.ceil(m / 2)) : null;
  };
  const bands = { upper: ring(0), middle: ring(1), lower: ring(2) };
  return Object.values(bands).some((v) => v != null) ? { bands, issued: findKey(json, "date_issued") ?? null } : null;
}
