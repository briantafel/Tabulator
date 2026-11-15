/* Resort search by name AND by place (Brian, 2026-11-15): country, area,
 * state/province, range, subrange and other names, from
 * src/data/resort-meta.json. "Colorado", "San Juans", "Wasatch", "Japan",
 * "Kootenays" or "JHMR" all find resorts now.
 *
 * Rules:
 *  - Accents, case and punctuation are ignored ("val disere" finds Val d'Isère).
 *  - The name keeps Brian's contains rule: "Ja" finds Jackson Hole and Jay Peak.
 *  - Place words: each typed word must match. A word of 1–2 letters must equal
 *    a whole place word ("CO", "BC", "US"), so "co" doesn't pull in every
 *    "Cottonwood"; a longer word may be the start of one ("rock" → Rockies).
 *  - Order: name matches first, then place matches; alphabetical within each.
 */
import META from "../data/resort-meta.json" with { type: "json" };

export const fold = (s) =>
  String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const placeWords = new Map(); // id -> Set of folded words
const placeText = new Map(); // id -> folded phrases, for multi-word matches
for (const [id, m] of Object.entries(META)) {
  const phrases = Object.values(m).flat().map(fold);
  placeText.set(id, phrases);
  placeWords.set(id, new Set(phrases.flatMap((p) => p.split(" "))));
}

export function placeMatch(resort, query) {
  const q = fold(query);
  if (!q) return false;
  const words = placeWords.get(resort.id);
  if (!words) return false;
  const nameWords = fold(resort.name).split(" ");
  return q.split(" ").every((t) => {
    const pool = [...words, ...nameWords];
    return t.length <= 2 ? pool.includes(t) : pool.some((w) => w.startsWith(t));
  });
}

export function nameMatch(resort, query) {
  const q = fold(query);
  return !!q && fold(resort.name).includes(q);
}

export function searchResorts(resorts, query) {
  if (!fold(query)) return [];
  const byName = (x, y) => x.name.localeCompare(y.name);
  const names = resorts.filter((r) => nameMatch(r, query)).sort(byName);
  const seen = new Set(names.map((r) => r.id));
  const places = resorts.filter((r) => !seen.has(r.id) && placeMatch(r, query)).sort(byName);
  return [...names, ...places];
}

export const metaFor = (id) => META[id] ?? null;
