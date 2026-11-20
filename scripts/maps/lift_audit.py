"""Audit of OpenSkiMap lifts for the terrain-pilot resorts: which lifts have terminals on no run terrain, and why.
Writes <out>/lift-audit.md and .json. Not part of the render."""
import json, math, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
import resort_map as rm  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def main(out, ids):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    md, allj = [], {}
    for rid in ids:
        r = rm.resort(rid)
        elev = json.loads((ROOT / "src/data/resort-elevations.json").read_text())["resorts"].get(rid, {})
        oid = elev.get("osm_id")
        rings, name = rm.ski_area(r, oid)
        pts = np.array([p for ring in rings for p in ring])
        la0, la1, lo0, lo1 = pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()
        latc, lonc = (la0 + la1) / 2, (lo0 + lo1) / 2
        k = math.cos(math.radians(latc))
        half = max((la1 - la0) * 111.32, (lo1 - lo0) * 111.32 * k) / 2 + 0.45
        crop = (lonc - half / (111.32 * k), latc - half / 111.32, lonc + half / (111.32 * k), latc + half / 111.32)
        lifts, runs = rm.lifts_runs(crop, oid)
        rp = np.array([p for _, g, _a in runs for p in g])

        def dist(la, lo):
            d = np.hypot((rp[:, 0] - la) * 111320, (rp[:, 1] - lo) * 111320 * k)
            return float(d.min())
        rows = []
        for p, g, area in lifts:
            a, b = g[0], g[-1]
            L = sum(math.hypot((g[i + 1][0] - g[i][0]) * 111320, (g[i + 1][1] - g[i][1]) * 111320 * k) for i in range(len(g) - 1))
            chord = math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * k)
            rows.append(dict(id=p.get("id"), name=p.get("name"), type=p.get("liftType") or p.get("aerialway") or p.get("type"),
                             status=p.get("status"), tagged=rm.member_of(p, oid), area=area, verts=len(g),
                             length_m=round(L), chord_m=round(chord), d_start=round(dist(*a)), d_end=round(dist(*b)),
                             props=sorted(p.keys())))
        allj[rid] = rows
        md.append(f"## {rid}: {len(rows)} lifts ({sum(x['tagged'] for x in rows)} tagged to the ski area), {len(runs)} runs\n")
        md.append("| id | name | type | tagged | verts | length m | chord m | start→run m | end→run m |\n|---|---|---|---|---|---|---|---|---|")
        for x in sorted(rows, key=lambda x: -max(x["d_start"], x["d_end"])):
            md.append(f"| {str(x['id'])[:8]} | {x['name']} | {x['type']} | {x['tagged']} | {x['verts']} | {x['length_m']} | {x['chord_m']} | {x['d_start']} | {x['d_end']} |")
        md.append("")
        md.append(f"property keys: {rows[0]['props'] if rows else None}\n")
    (out / "lift-audit.md").write_text("\n".join(md))
    (out / "lift-audit.json").write_text(json.dumps(allj, indent=1, default=str))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
