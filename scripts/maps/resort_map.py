"""One resort, snow by terrain: the ski area alone on white plaster relief.

  python3 resort_map.py OUTDIR RESORT_ID [--px 1800]

1. Ski area outline, lifts and downhill runs from OpenStreetMap (Overpass), picked by
   the resort's point and name. Crop = the outline's bounds plus a margin, made square.
2. Snow: the NBM terrain downscale (sketch.downscale) computed over a wide box around
   the resort (it needs neighbouring cells to learn snow vs height), then resampled to
   the crop. Same caveats: NBM only, not yet scored.
3. Relief: USGS 3DEP 10 m (Copernicus 30 m outside the US), plaster style.
4. Colour only inside the ski area: snow bands + labelled lines; outside it the plaster
   shows through a white veil. Base / top values are read at the lowest and highest
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


def overpass(q):
    import time
    data = urllib.parse.urlencode({"data": q}).encode()
    urls = (OVERPASS, "https://overpass.private.coffee/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
    for attempt in range(3):
        for url in urls:
            try:
                return json.load(urllib.request.urlopen(urllib.request.Request(url, data=data, headers=UA), timeout=240))
            except Exception as e:
                print(f"overpass {url} (try {attempt + 1}): {e}", file=sys.stderr, flush=True)
        time.sleep(30 * (attempt + 1))
    sys.exit("Overpass unreachable after 3 rounds of 4 servers")


def lines_of(el):
    """Overpass element (out geom) -> list of [(lat, lon), ...] rings/lines."""
    if el["type"] == "way":
        return [[(p["lat"], p["lon"]) for p in el.get("geometry", [])]]
    if el["type"] == "relation":
        return [[(p["lat"], p["lon"]) for p in m.get("geometry", [])] for m in el.get("members", [])
                if m.get("role") in ("outer", "") and m.get("geometry")]
    return []


def ski_area(r, osm_name):
    lat, lon = r.get("latlon") or r.get("nws")
    q = f"""[out:json][timeout:120];
(way["landuse"="winter_sports"](around:4000,{lat},{lon});
 relation["landuse"="winter_sports"](around:4000,{lat},{lon});
 relation["site"="piste"](around:4000,{lat},{lon}););
out geom;"""
    els = overpass(q)["elements"]
    want = {n.lower() for n in (r["name"], osm_name or "") if n}

    def score(el):
        name = (el.get("tags", {}).get("name") or "").lower()
        rings = [ring for ring in lines_of(el) if len(ring) > 2]
        if not rings:
            return None
        pts = np.array([p for ring in rings for p in ring])
        d = np.min(np.hypot(pts[:, 0] - lat, (pts[:, 1] - lon) * math.cos(math.radians(lat)))) * 111.32
        named = any(w and (w in name or name in w) for w in want) if name else False
        return (0 if named else 1, d), rings, name
    cands = [s for s in (score(e) for e in els) if s]
    if not cands:
        sys.exit(f"{r['id']}: no ski-area outline in OpenStreetMap near the resort point")
    cands.sort(key=lambda c: c[0])
    key, rings, name = cands[0]
    print(f"ski area: '{name}' ({len(rings)} rings), name match {key[0] == 0}, {key[1]:.2f} km")
    return rings, name


def lifts_runs(bbox):
    W, S, E, N = bbox
    q = f"""[out:json][timeout:120];
(way["aerialway"~"chair_lift|gondola|cable_car|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet"]({S},{W},{N},{E});
 way["piste:type"="downhill"]({S},{W},{N},{E}););
out geom;"""
    lifts, runs = [], []
    for el in overpass(q)["elements"]:
        g = [(p["lat"], p["lon"]) for p in el.get("geometry", [])]
        if len(g) < 2:
            continue
        (lifts if "aerialway" in el.get("tags", {}) else runs).append((el.get("tags", {}), g))
    print(f"lifts {len(lifts)}, runs {len(runs)}")
    return lifts, runs


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
    rings, area_name = ski_area(r, elev.get("osm_name"))
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

    # --- relief
    rgb = sk.relief(dem)
    buf = io.BytesIO(); Image.fromarray(rgb).save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()

    def P(la, lo):
        return sk.px(lo, la)

    def path(seq, close=False):
        s = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in (P(la, lo) for la, lo in seq))
        return s + (" Z" if close else "")

    area_d = " ".join(path(ring, True) for ring in rings)
    lifts, runs = lifts_runs(crop)

    # inside-area mask for stats
    from matplotlib.path import Path as MPath
    mask = np.zeros(snow.shape, bool)
    yy, xx = np.mgrid[0:sk.H_PX, 0:sk.W_PX]
    pts_px = np.column_stack([xx.ravel(), yy.ravel()])
    for ring in rings:
        mask |= MPath(np.array([P(la, lo) for la, lo in ring])).contains_points(pts_px).reshape(snow.shape)
    if mask.mean() < 0.02:
        sys.exit("ski-area mask is nearly empty; refusing to draw")
    inside = snow[mask]
    lo_in, hi_in = np.floor(inside.min()), np.ceil(inside.max())
    step = 2 if hi_in - lo_in <= 16 else 3
    levels = list(np.arange(math.floor(lo_in / step) * step + step, hi_in, step))
    lines, fill = sk.snow_shapes(snow, levels, smooth=1, min_pts=8)

    # base / top at lift terminals
    terms = []
    for tags, g in lifts:
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
    layer("outside the ski area (veil)", [f'<path d="M0,0 H{sk.W_PX} V{sk.H_PX} H0 Z {area_d}" fill="#ffffff" '
                                          f'fill-opacity="0.55" fill-rule="evenodd"/>'])
    n = max(1, len(fill))
    layer("snow fill (inside area)", [f'<path d="{d}" fill="{ramp[min(len(ramp) - 1, int(i * (len(ramp) - 1) / max(1, n - 1)))]}" '
                                      f'fill-opacity="0.5" fill-rule="evenodd" clip-path="url(#area)"/>'
                                      for i, (lv, d) in enumerate(fill) if d])
    body = []
    for lv, ds in lines:
        if ds:
            body.append(f'<path d="{" ".join(ds)}" fill="none" stroke="#0d3fb0" stroke-opacity="0.75" stroke-width="1.6" '
                        f'stroke-linejoin="round" clip-path="url(#area)"/>')
    layer("snow lines", body)
    layer("runs", [f'<path d="{path(g)}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2.2" '
                   f'stroke-linecap="round"/>' for _, g in runs])
    lb = []
    for tags, g in lifts:
        lb.append(f'<path d="{path([g[0], g[-1]])}" fill="none" stroke="{sk.INK}" stroke-width="1.6"/>')
        for la_, lo_ in (g[0], g[-1]):
            x, y = P(la_, lo_); lb.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.2" fill="{sk.INK}"/>')
    layer("lifts", lb)
    layer("ski area boundary", [f'<path d="{area_d}" fill="none" stroke="{sk.INK}" stroke-opacity="0.55" '
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
    (out / f"{a.resort}.svg").write_text(svg)
    import cairosvg
    cairosvg.svg2png(bytestring=svg.encode(), write_to=str(out / f"{a.resort}.png"))
    json.dump({"resort": a.resort, "ski_area": area_name, "crop": crop, "dem": dem_src, "nbm_run": run.isoformat(),
               "inside_range_in": [round(float(inside.min()), 1), round(float(inside.max()), 1)],
               "levels_in": [float(x) for x in levels],
               "base": marks[0][1][:1] + marks[0][1][3:] if marks else None,
               "top": marks[1][1][:1] + marks[1][1][3:] if marks else None,
               "lifts": len(lifts), "runs": len(runs)}, open(out / f"{a.resort}.json", "w"), indent=1, default=float)
    print(f"{a.resort}: inside {inside.min():.1f}–{inside.max():.1f} in; marks {[(w, round(m[0]), round(m[3], 1)) for w, m in marks]}")


if __name__ == "__main__":
    main()
