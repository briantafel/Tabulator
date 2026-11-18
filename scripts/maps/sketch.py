"""Map style sketch: white relief base + vector line work + raw ECMWF 5-day snow.

One-off design sketch (claude/maps-sketch.md), not part of the app. Writes to OUT:
  base.png            white multi-direction relief only (raster)
  layers.svg          everything, editable: relief embedded as a locked image layer,
                      contours, snow line split, snow fill, snow lines, resorts, caption
  sketch-fill.png     relief + snow as a blue fill
  sketch-lines.png    relief + snow as labelled blue lines
  meta.json           run, bounds, sources, placeholders

Data: Copernicus GLO-30 DEM (AWS open data, (c) ESA/Copernicus), ECMWF IFS open data
(CC-BY-4.0). Raw model, 0.25 deg: the snow will look blobby; that's the point of the sketch.
Placeholders, stated in the caption: one snow line elevation, one snow-to-liquid ratio.
"""
import argparse, base64, io, json, math, os, sys, urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter
from scipy.interpolate import RegularGridInterpolator
from PIL import Image
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Wasatch: Ogden (Powder Mtn, Snowbasin) to the Cottonwoods and Park City.
W, S, E, N = -112.15, 40.45, -111.35, 41.45
H_PX = 2400
LAT0 = (S + N) / 2
W_PX = int(round(H_PX * (E - W) * math.cos(math.radians(LAT0)) / (N - S)))

RESORTS = [  # nws points from src/data/resorts.json
    ("Powder Mountain", 41.375, -111.775), ("Snowbasin", 41.205, -111.87),
    ("Solitude", 40.612, -111.598), ("Brighton", 40.592, -111.585),
    ("Alta", 40.58, -111.63), ("Snowbird", 40.582, -111.6562), ("Park City", 40.638, -111.528),
]
CITIES = [("Salt Lake City", 40.7608, -111.8910), ("Ogden", 41.223, -111.9738)]

SNOW_LINE_FT = 6500     # placeholder: one snow line for the whole map
SLR = 12                # placeholder: 12:1 everywhere
CONTOUR_FT = 500
INDEX_FT = 2500
SNOW_LEVELS_IN = [1, 3, 6, 12, 18, 24, 36]

BLUE, BROWN, GREY, INK = "#1f5fbf", "#9a5a2e", "#8a8f96", "#2b2f33"
# Single blue ramp, more snow = deeper and more saturated. Starts clearly off-white.
FILL = ["#c9dcf2", "#9fc0ea", "#6f9fe0", "#3f7bd6", "#1d5ccc", "#0d3fb0", "#06268a"]
FILL_OP = 0.55


def px(lon, lat):
    return (lon - W) / (E - W) * W_PX, (N - lat) / (N - S) * H_PX


# ---------------------------------------------------------------- terrain
def dem_tiles():
    names = []
    for lat in range(math.floor(S), math.floor(N - 1e-9) + 1):
        for lon in range(math.floor(W), math.floor(E - 1e-9) + 1):
            ns = f"N{lat:02d}" if lat >= 0 else f"S{-lat:02d}"
            ew = f"W{-lon:03d}" if lon < 0 else f"E{lon:03d}"
            t = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
            names.append(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{t}/{t}.tif")
    return names


def load_dem(cache):
    if cache and os.path.exists(cache):
        return np.load(cache)
    srcs = [rasterio.open(u) for u in dem_tiles()]
    res = ((E - W) / W_PX, (N - S) / H_PX)
    arr, _ = merge(srcs, bounds=(W, S, E, N), res=res, resampling=Resampling.average, nodata=-9999)
    dem = arr[0].astype("float32")[:H_PX, :W_PX]
    if dem.shape != (H_PX, W_PX):
        raise SystemExit(f"DEM shape {dem.shape}, expected {(H_PX, W_PX)}")
    bad = dem <= -1000
    if bad.mean() > 0.01:
        raise SystemExit(f"DEM has {bad.mean():.1%} nodata; refusing to draw a wrong map")
    dem[bad] = np.nanmedian(dem[~bad])
    if cache:
        np.save(cache, dem)
    return dem


def relief(dem):
    """Soft multi-direction light, near-white flats, ambient occlusion in the folds."""
    dy = (N - S) / H_PX * 111320.0
    dx = (E - W) / W_PX * 111320.0 * math.cos(math.radians(LAT0))
    z = gaussian_filter(dem, 0.8) * 1.4                       # mild exaggeration
    gy, gx = np.gradient(z, dy, dx)
    gy = -gy                                                  # rows run north to south
    nx, ny, nz = -gx, -gy, np.ones_like(z)
    n = np.sqrt(nx * nx + ny * ny + 1)
    nx, ny, nz = nx / n, ny / n, nz / n
    shade = np.zeros_like(z)
    # azimuth (deg from north, clockwise), altitude, weight: NW key light, softer fills
    for az, alt, w in [(315, 45, 0.45), (270, 50, 0.2), (360, 50, 0.2), (225, 60, 0.15)]:
        a, b = math.radians(az), math.radians(alt)
        lx, ly, lz = math.sin(a) * math.cos(b), math.cos(a) * math.cos(b), math.sin(b)
        shade += w * np.clip(nx * lx + ny * ly + nz * lz, 0, 1)
    flat = sum(w * math.sin(math.radians(alt)) for _, alt, w in
               [(315, 45, 0.45), (270, 50, 0.2), (360, 50, 0.2), (225, 60, 0.15)])
    tone = 0.965 + (shade - flat) * 0.85
    # ambient occlusion: darken where the ground sits below its surroundings
    occ = gaussian_filter(dem, 18) - dem
    tone -= np.clip(occ / 600.0, 0, 0.12)
    tone = np.clip(tone, 0.52, 1.0)
    rgb = np.stack([tone * 0.995, tone, tone * 1.0], -1)    # a breath of cool
    return (rgb * 255).astype("uint8")


# ---------------------------------------------------------------- snow
def latest_ifs_snow(work):
    """5-day IFS snowfall (m water equivalent, accumulated from step 0) at step 120."""
    from ecmwf.opendata import Client
    now = datetime.now(timezone.utc)
    last = None
    for back in range(0, 4):
        run = (now - timedelta(hours=8 + 12 * back)).replace(minute=0, second=0, microsecond=0)
        run = run.replace(hour=0 if run.hour < 12 else 12)
        target = os.path.join(work, "ifs_sf.grib2")
        for src in ("aws", "google", "ecmwf"):
            try:
                Client(source=src).retrieve(date=run.strftime("%Y%m%d"), time=run.hour,
                                            type="fc", step=120, param="sf", target=target)
                return run, target, src
            except Exception as e:  # loud in the log; the run fails below if nothing works
                last = e
                print(f"IFS {run:%Y-%m-%d %HZ} via {src}: {e}", file=sys.stderr)
    raise SystemExit(f"No IFS snowfall file found: {last}")


def read_grib_ll(path):
    import eccodes
    with open(path, "rb") as f:
        h = eccodes.codes_grib_new_from_file(f)
        if h is None:
            raise SystemExit("empty GRIB")
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        la1, la2 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"), eccodes.codes_get(h, "latitudeOfLastGridPointInDegrees")
        lo1, lo2 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees"), eccodes.codes_get(h, "longitudeOfLastGridPointInDegrees")
        v = eccodes.codes_get_values(h).reshape(nj, ni)
        units = eccodes.codes_get(h, "units")
        eccodes.codes_release(h)
    lats = np.linspace(la1, la2, nj)
    lons = np.linspace(lo1, lo2, ni)
    lons = np.where(lons > 180, lons - 360, lons)
    order = np.argsort(lons)
    return lats, lons[order], v[:, order], units


def snow_inches(path):
    lats, lons, v, units = read_grib_ll(path)
    if lats[0] > lats[-1]:
        lats, v = lats[::-1], v[::-1]
    f = RegularGridInterpolator((lats, lons), v, bounds_error=True)
    yy = np.linspace(N, S, H_PX)
    xx = np.linspace(W, E, W_PX)
    LA, LO = np.meshgrid(yy, xx, indexing="ij")
    swe_m = f(np.stack([LA, LO], -1))
    if "kg" in units:  # some encodings give kg m-2 (= mm)
        swe_m = swe_m / 1000.0
    inches = np.clip(swe_m, 0, None) * 39.3701 * SLR
    if not np.isfinite(inches).all() or inches.max() > 200:
        raise SystemExit(f"implausible snow field: max {np.nanmax(inches):.1f} in")
    return inches


# ---------------------------------------------------------------- vectors
def paths_from_contour(cs, min_pts=12):
    out = []  # (level, [d strings])
    for level, segs in zip(cs.levels, cs.allsegs):
        ds = []
        for seg in segs:
            if len(seg) < min_pts:
                continue
            ds.append("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in seg))
        out.append((level, ds))
    return out


def contour_sets(dem_ft, snow_in):
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    zs = gaussian_filter(dem_ft, 3)
    lo = math.ceil(zs.min() / CONTOUR_FT) * CONTOUR_FT
    hi = math.floor(zs.max() / CONTOUR_FT) * CONTOUR_FT
    terrain = paths_from_contour(ax.contour(zs, levels=np.arange(lo, hi + 1, CONTOUR_FT)))
    sm = gaussian_filter(snow_in, 6)
    lv = [l for l in SNOW_LEVELS_IN if l < sm.max()]
    snow_lines = paths_from_contour(ax.contour(sm, levels=lv), min_pts=4) if lv else []
    fill = []
    if lv:
        csf = ax.contourf(sm, levels=lv + [1e6])
        for i, level in enumerate(lv):
            p = csf.get_paths()[i] if hasattr(csf, "get_paths") else None
            if p is None:
                continue
            ds = []
            for poly in p.to_polygons(closed_only=True):
                if len(poly) < 3:
                    continue
                ds.append("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in poly) + " Z")
            fill.append((level, " ".join(ds)))
    plt.close(fig)
    return terrain, snow_lines, fill


def label_points(snow_lines):
    """One label per snow contour, at its longest segment's midpoint."""
    labels = []
    for level, ds in snow_lines:
        if not ds:
            continue
        d = max(ds, key=len)
        pts = [tuple(map(float, p.strip("ML ").split(","))) for p in d.split(" L")]
        labels.append((level, pts[len(pts) // 2]))
    return labels


def halo_text(x, y, txt, attrs):
    """Halo as its own element underneath (cairo ignores paint-order)."""
    import re
    bare = re.sub(r'\s*fill="[^"]*"', "", attrs)
    return [f'<text x="{x:.1f}" y="{y:.1f}" {bare} fill="#ffffff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round">{txt}</text>',
            f'<text x="{x:.1f}" y="{y:.1f}" {attrs}>{txt}</text>']


def svg(base_png, dem_ft, terrain, snow_lines, fill, run, mode):
    """mode: 'all' (editable master), 'fill', 'lines'."""
    b64 = base64.b64encode(base_png).decode()
    L = []
    L.append(f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
             f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
             f'width="{W_PX}" height="{H_PX}" viewBox="0 0 {W_PX} {H_PX}" '
             f'font-family="Inter, Helvetica, Arial, sans-serif">')

    def layer(name, body, hidden=False):
        style = ' style="display:none"' if hidden else ""
        L.append(f'<g id="{name}" inkscape:groupmode="layer" inkscape:label="{name}"{style}>')
        L.extend(body)
        L.append("</g>")

    layer("relief (raster)", [f'<image width="{W_PX}" height="{H_PX}" xlink:href="data:image/png;base64,{b64}"/>'])

    def terrain_group(above):
        body = []
        for level, ds in terrain:
            if (level >= SNOW_LINE_FT) != above or not ds:
                continue
            idx = level % INDEX_FT == 0
            col = BLUE if above else BROWN
            body.append(f'<path d="{" ".join(ds)}" fill="none" stroke="{col}" '
                        f'stroke-opacity="{0.55 if idx else 0.28}" stroke-width="{1.1 if idx else 0.55}" '
                        f'stroke-linejoin="round" data-ft="{int(level)}"/>')
        return body

    layer(f"contours above snow line ({SNOW_LINE_FT} ft)", terrain_group(True))
    layer("contours below snow line", terrain_group(False))

    fill_body = [f'<path d="{d}" fill="{FILL[min(i, len(FILL)-1)]}" fill-opacity="{FILL_OP}" '
                 f'fill-rule="evenodd" stroke="none" data-in="{lv}"/>' for i, (lv, d) in enumerate(fill) if d]
    layer("snow fill", fill_body, hidden=(mode == "lines"))

    line_body = []
    for i, (lv, ds) in enumerate(snow_lines):
        if ds:
            line_body.append(f'<path d="{" ".join(ds)}" fill="none" stroke="{FILL[min(i + 2, len(FILL)-1)]}" '
                             f'stroke-width="{1.4 + 0.5 * i:.1f}" stroke-linejoin="round" data-in="{lv}"/>')
    for lv, (x, y) in label_points(snow_lines):
        line_body += halo_text(x, y, f'{lv:g}"', f'font-size="22" font-weight="600" fill="{FILL[5]}" '
                               f'text-anchor="middle" dominant-baseline="middle"')
    layer("snow lines", line_body, hidden=(mode == "fill"))

    mk = []
    for name, la, lo in RESORTS:
        x, y = px(lo, la)
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="9" fill="#ffffff" stroke="{INK}" stroke-width="1.6"/>')
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{INK}"/>')
        dx = -16 if name in ("Snowbird", "Alta") else 16
        anchor = "end" if dx < 0 else "start"
        dy = {"Alta": 18, "Brighton": 6, "Solitude": -10}.get(name, 0)
        mk += halo_text(x + dx, y + dy, name, f'font-size="24" font-weight="500" fill="{INK}" '
                        f'text-anchor="{anchor}" dominant-baseline="middle"')
    for name, la, lo in CITIES:
        x, y = px(lo, la)
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{GREY}"/>')
        mk += halo_text(x + 10, y, name, f'font-size="21" fill="{GREY}" dominant-baseline="middle"')
    layer("places", mk)

    valid = run + timedelta(hours=120)
    cap = [f'<rect x="0" y="{H_PX - 118}" width="{W_PX}" height="118" fill="#ffffff" fill-opacity="0.92"/>',
           f'<text x="36" y="{H_PX - 76}" font-size="28" font-weight="600" fill="{INK}">5-day snow · ECMWF IFS (raw, 0.25°)</text>',
           f'<text x="36" y="{H_PX - 42}" font-size="19" fill="{GREY}">Run {run:%a %b %-d %HZ} → {valid:%a %b %-d %HZ} · '
           f'sketch placeholders: {SLR}:1 snow ratio, snow line {SNOW_LINE_FT:,} ft · contours {CONTOUR_FT} ft</text>',
           f'<text x="36" y="{H_PX - 16}" font-size="15" fill="{GREY}">Elevation © ESA Copernicus GLO-30 · Forecast © ECMWF, CC BY 4.0</text>']
    layer("caption", cap)
    L.append("</svg>")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--dem-cache")
    ap.add_argument("--fake-snow", action="store_true", help="test without ECMWF")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    dem = load_dem(a.dem_cache)
    print(f"DEM {dem.shape}, {dem.min():.0f}–{dem.max():.0f} m")
    rgb = relief(dem)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "PNG", optimize=True)
    base_png = buf.getvalue()
    open(os.path.join(a.out, "base.png"), "wb").write(base_png)

    if a.fake_snow:
        run, src = datetime(2026, 11, 18, 0, tzinfo=timezone.utc), "fake"
        yy, xx = np.mgrid[0:H_PX, 0:W_PX]
        snow = 22 * np.exp(-(((xx - W_PX * .6) / 300) ** 2 + ((yy - H_PX * .75) / 500) ** 2))
    else:
        run, path, src = latest_ifs_snow(a.out)
        snow = snow_inches(path)
        os.remove(path)
    print(f"IFS {run:%Y-%m-%d %HZ} via {src}: snow max {snow.max():.1f} in")

    dem_ft = dem * 3.28084
    terrain, snow_lines, fill = contour_sets(dem_ft, snow)

    import cairosvg
    for mode, name in [("all", "layers.svg"), ("fill", "sketch-fill"), ("lines", "sketch-lines")]:
        s = svg(base_png, dem_ft, terrain, snow_lines, fill, run, mode)
        if mode == "all":
            open(os.path.join(a.out, name), "w").write(s)
        else:
            cairosvg.svg2png(bytestring=s.encode(), write_to=os.path.join(a.out, name + ".png"))
    json.dump({"bounds": [W, S, E, N], "px": [W_PX, H_PX], "ifs_run": run.isoformat(), "ifs_source": src,
               "snow_max_in": round(float(snow.max()), 1), "slr_placeholder": SLR,
               "snow_line_ft_placeholder": SNOW_LINE_FT},
              open(os.path.join(a.out, "meta.json"), "w"), indent=2)
    print("wrote", sorted(os.listdir(a.out)))


if __name__ == "__main__":
    main()
