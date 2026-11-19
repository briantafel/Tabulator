"""One resort, snow by terrain: the ski area alone on white plaster relief.
(Ski area outline, lifts and runs: OpenSkiMap GeoJSON exports, OpenStreetMap contributors, ODbL.)

  python3 resort_map.py OUTDIR RESORT_ID [--px 1800]

1. Ski area outline, lifts and downhill runs from OpenStreetMap (Overpass), picked by
   the resort's point and name. Crop = the outline's bounds plus a margin, made square.
2. Snow: the NBM terrain downscale (sketch.downscale) computed over a wide box around
   the resort (it needs neighbouring cells to learn snow vs height), then resampled to
   the crop. Same caveats: NBM only, not yet scored.
3. Relief: USGS 3DEP 10 m (Copernicus 30 m outside the US), plaster style.
4. Colour only inside the ski area: snow bands + labelled lines; outside it the plaster
   stays plain plaster (no veil). The "area" is the skiable terrain traced from the
   resort's own mapped runs, not a legal permit boundary. Base / top values are read at the lowest and highest
   lift terminals.
Writes RESORT_ID.png and RESORT_ID.svg (vector layers over the relief image).
"""
import argparse, base64, io, json, math, os, sys, urllib.parse, urllib.request
from datetime import timedelta
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.enums import Resampling
from scipy.interpolate import RegularGridInterpolator
from scipy.ndimage import gaussian_filter
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import sketch as sk  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OVERPASS = "https://overpass-api.de/api/interpreter"
UA = {"User-Agent": "tabulator/1.0 (+https://github.com/briantafel/tabulator)"}


def resort(rid):
    for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]:
        if r["id"] == rid:
            return r
    sys.exit(f"no resort {rid}")


OSM_GEOJSON = "https://tiles.openskimap.org/geojson/{}.geojson"


def stream_features(kind):
    """Stream OpenSkiMap features (ski_areas / lifts / runs) without loading the file whole."""
    import ijson
    local = os.environ.get("OSM_DIR") and Path(os.environ["OSM_DIR"]) / f"{kind}.geojson"
    if local and local.exists():
        with open(local, "rb") as f:
            yield from ijson.items(f, "features.item", use_float=True)
        return
    req = urllib.request.Request(OSM_GEOJSON.format(kind), headers=UA)
    with urllib.request.urlopen(req, timeout=600) as f:
        yield from ijson.items(f, "features.item", use_float=True)


def rings_of(geom):
    """GeoJSON geometry -> list of [(lat, lon), ...] (polygon outer rings and lines)."""
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return [[(y, x) for x, y, *_ in c[0]]]
    if t == "MultiPolygon":
        return [[(y, x) for x, y, *_ in poly[0]] for poly in c]
    if t == "LineString":
        return [[(y, x) for x, y, *_ in c]]
    if t == "MultiLineString":
        return [[(y, x) for x, y, *_ in line] for line in c]
    return []


def ski_area(r, osm_id):
    """The resort's OpenSkiMap ski area (id from resort-elevations.json): outline rings."""
    if not osm_id:
        sys.exit(f"{r['id']}: no OpenSkiMap id in resort-elevations.json")
    for f in stream_features("ski_areas"):
        if f["properties"].get("id") == osm_id:
            rings = [ring for ring in rings_of(f["geometry"]) if len(ring) > 2]
            if not rings:
                sys.exit(f"{r['id']}: OpenSkiMap area {osm_id} has no outline ({f['geometry']['type']})")
            name = f["properties"].get("name")
            print(f"ski area: '{name}' ({len(rings)} rings)")
            return rings, name
    sys.exit(f"{r['id']}: OpenSkiMap area {osm_id} not found")


def member_of(p, osm_id):
    for a in p.get("skiAreas") or []:
        aid = a.get("properties", {}).get("id") if isinstance(a, dict) else a
        if aid == osm_id:
            return True
    return False


def lifts_runs(bbox, osm_id=None):
    """Lifts and downhill runs in the crop; when OpenSkiMap tags them with ski areas,
    only this resort's (so a neighbour's runs don't widen the outline)."""
    W, S, E, N = bbox

    def near(g):
        return any(W <= lo <= E and S <= la <= N for la, lo in g)
    out = {}
    for kind in ("lifts", "runs"):
        got = []
        for f in stream_features(kind):
            p = f.get("properties") or {}
            if kind == "runs" and "downhill" not in (p.get("uses") or []):
                continue
            geom = f.get("geometry") or {"type": "", "coordinates": []}
            area = geom["type"] in ("Polygon", "MultiPolygon")
            for g in rings_of(geom):
                if len(g) >= 2 and near(g):
                    got.append((p, g, area))
        mine = [x for x in got if osm_id and member_of(x[0], osm_id)]
        print(f"{kind}: {len(got)} in crop, {len(mine)} tagged to this ski area")
        out[kind] = mine if mine else got
    print(f"lifts {len(out['lifts'])}, runs {len(out['runs'])}")
    if not out["lifts"]:
        sys.exit("no lifts found in the crop; refusing to draw base/top")
    return out["lifts"], out["runs"]


def load_dem_fine(bbox, wpx, hpx):
    W, S, E, N = bbox
    res = ((E - W) / wpx, (N - S) / hpx)
    usgs, cop = [], []
    for la in range(math.floor(S), math.floor(N) + 1):
        for lo in range(math.floor(W), math.floor(E) + 1):
            name = f"n{la + 1:02d}w{-lo:03d}"
            usgs.append(f"/vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{name}/USGS_13_{name}.tif")
            ns = f"N{la:02d}" if la >= 0 else f"S{-la:02d}"
            ew = f"W{-lo:03d}" if lo < 0 else f"E{lo:03d}"
            k = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
            cop.append(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{k}/{k}.tif")
    for label, tiles in (("usgs-3dep-10m", usgs), ("copernicus-30m", cop)):
        try:
            arr, _ = merge([rasterio.open(u) for u in tiles], bounds=bbox, res=res,
                           resampling=Resampling.bilinear, nodata=-9999)
            z = arr[0][:hpx, :wpx].astype("float32")
            if z.shape != (hpx, wpx) or (z < -500).mean() > 0.001:
                raise RuntimeError(f"shape {z.shape}, nodata {(z < -500).mean():.1%}")
            print(f"DEM {label} {z.shape} {z.min():.0f}–{z.max():.0f} m")
            return z, label
        except Exception as e:
            print(f"{label}: {e}", file=sys.stderr)
    sys.exit("no DEM for the crop")


def set_box(bbox, wpx):
    sk.W, sk.S, sk.E, sk.N = bbox
    sk.LAT0 = (sk.S + sk.N) / 2
    sk.W_PX = wpx
    sk.H_PX = int(round(wpx * (sk.N - sk.S) / ((sk.E - sk.W) * math.cos(math.radians(sk.LAT0)))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("resort")
    ap.add_argument("--px", type=int, default=1800)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    r = resort(a.resort)
    elev = json.loads((ROOT / "src/data/resort-elevations.json").read_text())["resorts"].get(a.resort, {})
    rings, area_name = ski_area(r, elev.get("osm_id"))
    pts = np.array([p for ring in rings for p in ring])
    la0, la1, lo0, lo1 = pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()
    lat_c, lon_c = (la0 + la1) / 2, (lo0 + lo1) / 2
    k = math.cos(math.radians(lat_c))
    half_km = max((la1 - la0) * 111.32, (lo1 - lo0) * 111.32 * k) / 2 + 0.45
    crop = (lon_c - half_km / (111.32 * k), lat_c - half_km / 111.32, lon_c + half_km / (111.32 * k), lat_c + half_km / 111.32)
    print(f"crop ±{half_km:.2f} km around {lat_c:.4f},{lon_c:.4f}")

    # --- snow: downscale over a wide box, then resample to the crop
    wide = (crop[0] - 0.16, crop[1] - 0.12, crop[2] + 0.16, crop[3] + 0.12)
    set_box(wide, 1400)
    dem_w = sk.load_dem(None)
    run, lat, lon, total, _ = sk.latest_nbm_snow()
    to_in = sk.nbm_interp(lat, lon)
    fine_w, grad_w = sk.downscale(dem_w, lat, lon, total, to_in)
    ys = np.linspace(sk.N, sk.S, sk.H_PX); xs = np.linspace(sk.W, sk.E, sk.W_PX)
    f_wide = RegularGridInterpolator((ys[::-1], xs), fine_w[::-1], bounds_error=True)
    nbm_cell = RegularGridInterpolator((ys[::-1], xs), to_in(total)[::-1], bounds_error=True)

    set_box(crop, a.px)
    dem, dem_src = load_dem_fine(crop, sk.W_PX, sk.H_PX)
    LA, LO = np.meshgrid(np.linspace(sk.N, sk.S, sk.H_PX), np.linspace(sk.W, sk.E, sk.W_PX), indexing="ij")
    coarse = f_wide(np.stack([LA, LO], -1))
    # The wide field carries the height term at ~30 m. Re-apply the same local rate
    # (in/1000 ft) to the 10 m terrain's departure from the 30 m terrain, so the snow
    # follows ridges and gullies the coarse DEM can't see. Cell totals are unchanged
    # in expectation (the departure averages ~0).
    q = np.stack([LA, LO], -1)
    dem_w_i = RegularGridInterpolator((ys[::-1], xs), dem_w[::-1])(q)
    grad_i = RegularGridInterpolator((ys[::-1], xs), grad_w[::-1])(q)
    snow = np.clip(coarse + grad_i * (dem - dem_w_i) * 3.28084 / 1000.0, 0, None)
    snow = gaussian_filter(snow, 1.5)
    print(f"crop: wide-field {coarse.min():.1f}–{coarse.max():.1f} in -> 10 m {snow.min():.1f}–{snow.max():.1f} in; "
          f"NBM cells here {nbm_cell(q).min():.1f}–{nbm_cell(q).max():.1f} in")

    # --- relief: Blender top-down render when BLENDER is set (cached per resort), else the numpy shader
    LIGHTS = [  # name, azimuth, elevation, strength, sun angle (softness), sky
        ["crisp", 315, 24, 4.2, 3, 0.22, [135, 35, 0.9]],
        ["soft", 315, 34, 3.4, 12, 0.32, [135, 40, 0.8]],
    ]
    rgbs = {}
    blender = os.environ.get("BLENDER")
    if blender:
        import subprocess
        work = out / "relief"; work.mkdir(exist_ok=True)
        step = max(1, int(round(sk.W_PX / 900)))
        np.save(work / f"{a.resort}.npy", dem[::step, ::step])
        w_m = (crop[2] - crop[0]) * 111320.0 * math.cos(math.radians(sk.LAT0)); h_m = (crop[3] - crop[1]) * 111320.0
        json.dump({"width_m": w_m, "height_m": h_m, "px": [sk.W_PX, sk.H_PX], "exag": 2.0, "light": LIGHTS},
                  open(work / f"{a.resort}.json", "w"))
        cmd = [blender, "-b", "-P", str(Path(__file__).with_name("relief_ortho.py")), "--",
               str(work / f"{a.resort}.npy"), str(work / f"{a.resort}.json"), str(work / a.resort)]
        r_ = subprocess.run(cmd, capture_output=True, text=True)
        print("\n".join(l for l in r_.stdout.splitlines() if "rendered" in l or "Error" in l))
        if r_.returncode:
            sys.exit(f"Blender failed: {r_.stderr[-1500:]}")
        for name, *_ in LIGHTS:
            rgbs[name] = np.asarray(Image.open(work / f"{a.resort}-{name}.png").convert("RGB"))
    else:
        rgbs["numpy"] = sk.relief(dem)
    rgb = next(iter(rgbs.values()))
    buf = io.BytesIO(); Image.fromarray(rgb).save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()

    def P(la, lo):
        return sk.px(lo, la)

    def path(seq, close=False):
        s = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in (P(la, lo) for la, lo in seq))
        return s + (" Z" if close else "")

    lifts, runs = lifts_runs(crop, elev.get("osm_id"))

    # Skiable-terrain outline: the resort's runs (areas filled, lines given a ~45 m width),
    # joined across the gaps between neighbouring runs (closing ~110 m), holes filled.
    # This follows the terrain people ski, not a legal permit line.
    from PIL import ImageDraw
    from scipy.ndimage import distance_transform_edt, binary_fill_holes
    m_px = (crop[3] - crop[1]) * 111320.0 / sk.H_PX
    canvas = Image.new("L", (sk.W_PX, sk.H_PX), 0)
    dr = ImageDraw.Draw(canvas)
    for _, g, area in runs:
        xy = [P(la, lo) for la, lo in g]
        if area and len(xy) > 2:
            dr.polygon(xy, fill=255)
        else:
            dr.line(xy, fill=255, width=max(2, int(round(45 / m_px))), joint="curve")
    raw = np.asarray(canvas) > 0
    r_close = 110 / m_px
    grown = distance_transform_edt(~raw) <= r_close
    mask = binary_fill_holes(distance_transform_edt(grown) > r_close * 0.85)
    if mask.mean() < 0.02:
        sys.exit("skiable-terrain mask is nearly empty (no runs mapped?); refusing to draw")
    acres = mask.sum() * m_px * m_px / 4046.86
    print(f"skiable-terrain outline: {acres:,.0f} acres from {len(runs)} runs")
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure(); ax = fig.add_axes([0, 0, 1, 1])
    cs = ax.contour(mask.astype(float), levels=[0.5])
    area_d = " ".join("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in seg) + " Z" for seg in cs.allsegs[0] if len(seg) > 8)
    plt.close(fig)
    inside = snow[mask]
    lo_in, hi_in = np.floor(inside.min()), np.ceil(inside.max())
    step = 2 if hi_in - lo_in <= 16 else 3
    levels = list(np.arange(math.floor(lo_in / step) * step + step, hi_in, step))
    lines, _ = sk.snow_shapes(snow, levels, smooth=1, min_pts=8)
    # fill bands start at the area's lowest value, so no part of the area reads as "no snow"
    _, fill = sk.snow_shapes(snow, [float(math.floor(lo_in))] + levels, smooth=1, min_pts=8)

    # base / top at lift terminals
    terms = []
    for tags, g, _ in lifts:
        for la_, lo_ in (g[0], g[-1]):
            x, y = P(la_, lo_)
            if 0 <= x < sk.W_PX and 0 <= y < sk.H_PX and mask[int(y), int(x)]:
                terms.append((float(dem[int(y), int(x)]), x, y, float(snow[int(y), int(x)])))
    terms.sort()
    marks = [("Base", terms[0]), ("Top", terms[-1])] if len(terms) >= 2 else []

    ramp = ["#c9dcf2", "#9fc0ea", "#6f9fe0", "#3f7bd6", "#1d5ccc", "#0d3fb0", "#06268a"]
    L = [f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
         f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="{sk.W_PX}" height="{sk.H_PX}" '
         f'viewBox="0 0 {sk.W_PX} {sk.H_PX}" font-family="Inter, Helvetica, Arial, sans-serif">',
         f'<defs><clipPath id="area"><path d="{area_d}" clip-rule="evenodd"/></clipPath></defs>']

    def layer(name, body):
        L.append(f'<g id="{name}" inkscape:groupmode="layer" inkscape:label="{name}">'); L.extend(body); L.append("</g>")

    layer("relief (raster)", [f'<image width="{sk.W_PX}" height="{sk.H_PX}" xlink:href="data:image/png;base64,{b64}"/>'])
    relief_line = len(L) - 2
    fill_start = len(L)
    n = max(1, len(fill))
    fill_paths = [f'<path d="{d}" fill="{ramp[min(len(ramp) - 1, int(i * (len(ramp) - 1) / max(1, n - 1)))]}" '
                  f'fill-rule="evenodd" clip-path="url(#area)"/>' for i, (lv, d) in enumerate(fill) if d]
    layer("snow fill (multiply)", [f'<g style="mix-blend-mode:multiply" opacity="0.85">'] + fill_paths + ["</g>"])
    fill_end = len(L)
    body = []
    for lv, ds in lines:
        if ds:
            body.append(f'<path d="{" ".join(ds)}" fill="none" stroke="#0d3fb0" stroke-opacity="0.75" stroke-width="1.6" '
                        f'stroke-linejoin="round" clip-path="url(#area)"/>')
    layer("snow lines", body)
    layer("runs", [f'<path d="{path(g)}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2.2" '
                   f'stroke-linecap="round" clip-path="url(#area)"/>' for _, g, _a in runs])
    lb = []
    for tags, g, _ in lifts:
        lb.append(f'<path d="{path([g[0], g[-1]])}" fill="none" stroke="{sk.INK}" stroke-width="1.6" clip-path="url(#area)"/>')
        for la_, lo_ in (g[0], g[-1]):
            x, y = P(la_, lo_)
            if 0 <= x < sk.W_PX and 0 <= y < sk.H_PX and mask[int(y), int(x)]:
                lb.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.2" fill="{sk.INK}"/>')
    layer("lifts", lb)
    layer("skiable terrain outline (from runs)", [f'<path d="{area_d}" fill="none" stroke="{sk.INK}" stroke-opacity="0.55" '
                                f'stroke-width="1.4" stroke-dasharray="6 6"/>'])
    lab = []
    for lv, (x, y) in sk.label_points(lines):
        if 0 < y < sk.H_PX and mask[int(min(y, sk.H_PX - 1)), int(min(x, sk.W_PX - 1))]:
            lab += sk.halo_text(x, y, f'{lv:g}"', 'font-size="26" font-weight="600" fill="#0d3fb0" text-anchor="middle" dominant-baseline="middle"')
    for word, (z, x, y, s) in marks:
        lab.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="11" fill="#ffffff" stroke="{sk.INK}" stroke-width="2"/>')
        lab.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{sk.INK}"/>')
        lab += sk.halo_text(x + 18, y, f'{word} {s:.0f}"  ·  {z * 3.28084:,.0f} ft',
                            f'font-size="30" font-weight="700" fill="{sk.INK}" dominant-baseline="middle"')
    layer("labels", lab)
    L.append("</svg>")
    svg = "\n".join(L)
    (out / f"{a.resort}.svg").write_text(svg)   # editable: plain relief + multiply fill layer
    import cairosvg
    # PNG: cairo ignores blend modes, so tint the relief in raster (multiply), then draw the rest.
    fill_svg = "\n".join(L[:2] + L[fill_start:fill_end] + ["</svg>"])
    fpng = cairosvg.svg2png(bytestring=fill_svg.encode(), output_width=sk.W_PX, output_height=sk.H_PX)
    F = np.asarray(Image.open(io.BytesIO(fpng)).convert("RGBA")).astype("float32") / 255.0
    k = 0.85 * F[..., 3:4]
    for name, base in rgbs.items():
        comp = base.astype("float32") / 255.0 * (1 - k + k * F[..., :3])
        bb = io.BytesIO(); Image.fromarray((comp * 255).clip(0, 255).astype("uint8")).save(bb, "PNG")
        L2 = list(L)
        L2[relief_line] = (f'<image width="{sk.W_PX}" height="{sk.H_PX}" '
                           f'xlink:href="data:image/png;base64,{base64.b64encode(bb.getvalue()).decode()}"/>')
        del L2[fill_start:fill_end]
        suffix = "" if len(rgbs) == 1 else f"-{name}"
        cairosvg.svg2png(bytestring="\n".join(L2).encode(), write_to=str(out / f"{a.resort}{suffix}.png"))
        Image.fromarray(base).save(out / f"{a.resort}{suffix}-relief.png")
    json.dump({"resort": a.resort, "ski_area": area_name, "crop": crop, "dem": dem_src, "nbm_run": run.isoformat(),
               "inside_range_in": [round(float(inside.min()), 1), round(float(inside.max()), 1)],
               "levels_in": [float(x) for x in levels],
               "base": marks[0][1][:1] + marks[0][1][3:] if marks else None,
               "top": marks[1][1][:1] + marks[1][1][3:] if marks else None,
               "lifts": len(lifts), "runs": len(runs), "outline": "skiable terrain from runs", "outline_acres": round(float(acres))}, open(out / f"{a.resort}.json", "w"), indent=1, default=float)
    print(f"{a.resort}: inside {inside.min():.1f}–{inside.max():.1f} in; marks {[(w, round(m[0]), round(m[3], 1)) for w, m in marks]}")


if __name__ == "__main__":
    main()
