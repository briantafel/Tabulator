"""Base / summit elevation for every resort, from OpenSkiMap (OpenStreetMap ski data, ODbL).

For each resort in src/data/resorts.json (latlon or nws point), find the OpenSkiMap ski
area whose geometry comes within MAX_KM of the point, preferring the best name match.
Elevations come from OpenSkiMap's per-area statistics (lift and run min/max, metres).

Writes OUT/resort-elevations.json and OUT/report.txt. Fails loudly if fewer than
MIN_MATCHED of the resorts match, so a format change can't produce a quiet partial table.
Review the report before copying the JSON into src/data/.
"""
import difflib, json, math, re, sys, urllib.request
from pathlib import Path

URL = "https://tiles.openskimap.org/geojson/ski_areas.geojson"
ROOT = Path(__file__).resolve().parents[2]
MAX_KM = 6.0
MIN_MATCHED = 0.8
# Resorts the nearest/name rule gets wrong (first run 2026-11-19): search these OSM names
# within OVERRIDE_KM instead and take the match with the largest vertical.
OVERRIDE_KM = 25.0
OVERRIDES = {
    "tremblant": ["tremblant"], "verbier": ["verbier", "4 vallées", "quatre vallées"],
    "chamonix": ["grands montets"], "st-moritz": ["corviglia"], "tetnuldi": ["tetnuldi"],
    "niseko": ["niseko united", "grand hirafu", "hirafu"], "myoko-akakura": ["akakura"],
    "marmot": ["marmot"], "blue-mountain": ["blue mountain"], "chapelco": ["chapelco"],
}


def norm(s):
    s = s.lower()
    s = re.sub(r"\b(ski|resort|area|mountain|mtn|the|station|de|la|le|les|alpine|village)\b", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def km(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2)
    d = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(d))


def coords(geom):
    def walk(c):
        if isinstance(c[0], (int, float)):
            yield c[1], c[0]
        else:
            for x in c:
                yield from walk(x)
    if geom["type"] == "GeometryCollection":
        for g in geom["geometries"]:
            yield from coords(g)
    else:
        yield from walk(geom["coordinates"])


def stat(st, *path):
    for p in path:
        st = st.get(p) if isinstance(st, dict) else None
    return st if isinstance(st, (int, float)) else None


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": "tabulator/1.0 (+https://github.com/briantafel/tabulator)"})
    data = json.load(urllib.request.urlopen(req, timeout=300))
    feats = data["features"]
    print(f"OpenSkiMap: {len(feats)} ski areas")
    print("sample statistics keys:", json.dumps(feats[0]["properties"].get("statistics", {}))[:400])
    # index by a coarse 1-degree bucket for speed
    buckets = {}
    for f in feats:
        if not f.get("geometry"):
            continue
        pts = list(coords(f["geometry"]))
        if not pts:
            continue
        if len(pts) > 400:
            pts = pts[:: len(pts) // 400]
        f["_pts"] = pts
        la, lo = pts[0]
        buckets.setdefault((int(la // 1), int(lo // 1)), []).append(f)

    resorts = json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]
    table, lines, matched = {}, [], 0
    for r in resorts:
        pt = r.get("latlon") or r.get("nws")
        if not pt:
            lines.append(f"{r['id']:28s} NO POINT")
            continue
        la, lo = pt
        if r["id"] in OVERRIDES:
            subs = OVERRIDES[r["id"]]
            best = None
            for f in feats:
                name = (f["properties"].get("name") or "")
                if "_pts" not in f or not any(x in name.lower() for x in subs):
                    continue
                d = min(km((la, lo), q) for q in f["_pts"])
                st = f["properties"].get("statistics") or {}
                lows = [v for v in (stat(st, "lifts", "minElevation"), stat(st, "runs", "minElevation")) if v is not None]
                highs = [v for v in (stat(st, "lifts", "maxElevation"), stat(st, "runs", "maxElevation")) if v is not None]
                if d <= OVERRIDE_KM and lows and highs and (best is None or max(highs) - min(lows) > best[0]):
                    best = (max(highs) - min(lows), f, d, name, round(min(lows)), round(max(highs)), st)
            if best:
                _, f, d, name, base, top, st = best
                table[r["id"]] = {"base_m": base, "top_m": top, "vertical_m": top - base,
                                  "lift_base_m": stat(st, "lifts", "minElevation"), "lift_top_m": stat(st, "lifts", "maxElevation"),
                                  "source": "openskimap", "osm_name": name, "osm_id": f["properties"].get("id"),
                                  "match_km": round(d, 2), "name_similarity": None, "matched_by": "override:" + "|".join(subs)}
                matched += 1
                lines.append(f"{r['id']:28s} {base:5d}–{top:5d} m  '{name}' {d:.1f} km  OVERRIDE")
                continue
            lines.append(f"{r['id']:28s} OVERRIDE {subs} found nothing with elevations; trying nearest")
        cands = []
        for dla in (-1, 0, 1):
            for dlo in (-1, 0, 1):
                for f in buckets.get((int(la // 1) + dla, int(lo // 1) + dlo), []):
                    d = min(km((la, lo), p) for p in f["_pts"])
                    if d <= MAX_KM:
                        name = f["properties"].get("name") or ""
                        sim = difflib.SequenceMatcher(None, norm(r["name"]), norm(name)).ratio()
                        cands.append((sim, -d, f, d, name))
        if not cands:
            lines.append(f"{r['id']:28s} NO SKI AREA within {MAX_KM} km")
            continue
        cands.sort(key=lambda c: (round(c[0], 1), c[1]), reverse=True)
        sim, _, f, d, name = cands[0]
        st = f["properties"].get("statistics") or {}
        lows = [v for v in (stat(st, "lifts", "minElevation"), stat(st, "runs", "minElevation")) if v is not None]
        highs = [v for v in (stat(st, "lifts", "maxElevation"), stat(st, "runs", "maxElevation")) if v is not None]
        if not lows or not highs:
            lines.append(f"{r['id']:28s} matched '{name}' ({d:.1f} km) but NO ELEVATION STATS")
            continue
        base, top = round(min(lows)), round(max(highs))
        flag = "  CHECK NAME" if sim < 0.5 else ""
        if top - base < 150:
            flag += "  CHECK VERTICAL"
        table[r["id"]] = {"base_m": base, "top_m": top, "vertical_m": top - base,
                          "lift_base_m": stat(st, "lifts", "minElevation"), "lift_top_m": stat(st, "lifts", "maxElevation"),
                          "source": "openskimap", "osm_name": name, "osm_id": f["properties"].get("id"),
                          "match_km": round(d, 2), "name_similarity": round(sim, 2)}
        matched += 1
        lines.append(f"{r['id']:28s} {base:5d}–{top:5d} m  '{name}' {d:.1f} km sim {sim:.2f}{flag}")
    rep = "\n".join(lines)
    print(rep)
    (out / "report.txt").write_text(rep + "\n")
    (out / "resort-elevations.json").write_text(json.dumps(
        {"_source": "OpenSkiMap ski_areas.geojson (OpenStreetMap contributors, ODbL); lift/run min-max elevation, m",
         "resorts": table}, indent=1, ensure_ascii=False) + "\n")
    frac = matched / len(resorts)
    print(f"matched {matched}/{len(resorts)} ({frac:.0%})")
    if frac < MIN_MATCHED:
        sys.exit(f"only {frac:.0%} matched; refusing to publish a partial table")


if __name__ == "__main__":
    main(sys.argv[1])
