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

TITLE = {"ifs": "5-day snow · ECMWF IFS (raw, 0.25°)", "nbm": "5-day snow · NOAA NBM (2.5 km)"}
SLR_NOTE = {"ifs": f"placeholder {SLR}:1 snow ratio", "nbm": "NBM's own snow ratio"}
CREDIT = {"ifs": "Forecast © ECMWF, CC BY 4.0", "nbm": "Forecast: NOAA National Blend of Models"}
BLUE, BROWN, GREY, INK = "#1f5fbf", "#9a5a2e", "#8a8f96", "#2b2f33"
# Single blue ramp, more snow = deeper and more saturated. Starts clearly off-white.
FILL = ["#c9dcf2", "#9fc0ea", "#6f9fe0", "#3f7bd6", "#1d5ccc", "#0d3fb0", "#06268a"]
FILL_OP = 0.55
FILL_FROM_IN = 6      # below this, lines only: color only where it matters


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


EXAG = 2.0          # vertical exaggeration, for effect and legibility
SUN_AZ, SUN_ALT = 315, 24   # low raking key light from the NW, for cast shadows
TERRACE_M = 500 / 3.28084   # terraced style: one step per 500 ft contour


def cast_shadow(z, dy, dx):
    """1 where the terrain toward the sun rises above the sun's ray, else 0."""
    a, t = math.radians(SUN_AZ), math.tan(math.radians(SUN_ALT))
    dr, dc = -math.cos(a), math.sin(a)          # rows run south, columns east
    step_m = math.hypot(dr * dy, dc * dx)
    rise = z.max() - z.min()
    n = int(rise / (step_m * t)) + 2
    H, Wd = z.shape
    pad = n + 2
    zp = np.full((H + 2 * pad, Wd + 2 * pad), -1e9, dtype=z.dtype)
    zp[pad:pad + H, pad:pad + Wd] = z
    shadow = np.zeros(z.shape, bool)
    for k in range(1, n):
        r, c = int(round(k * dr)), int(round(k * dc))
        shadow |= zp[pad + r:pad + r + H, pad + c:pad + c + Wd] > z + k * step_m * t
    return shadow.astype("float32")


def relief(dem, style="plaster", seed=7):
    """White plaster model: soft multi-direction light, exaggerated relief, soft cast
    shadows, ambient occlusion in the folds, and a fine plaster grain."""
    dy = (N - S) / H_PX * 111320.0
    dx = (E - W) / W_PX * 111320.0 * math.cos(math.radians(LAT0))
    z = gaussian_filter(dem, 0.8)
    if style == "terraced":
        # stacked layers like a laser-cut model; keep a little slope so faces still shade
        z = np.floor(z / TERRACE_M) * TERRACE_M * 0.85 + z * 0.15
    z = z * EXAG
    gy, gx = np.gradient(z, dy, dx)
    gy = -gy
    nx, ny, nz = -gx, -gy, np.ones_like(z)
    nn = np.sqrt(nx * nx + ny * ny + 1)
    nx, ny, nz = nx / nn, ny / nn, nz / nn
    lights = [(SUN_AZ, SUN_ALT + 16, 0.5), (270, 50, 0.18), (360, 50, 0.17), (200, 65, 0.15)]
    shade = np.zeros_like(z)
    for az, alt, w in lights:
        a, b = math.radians(az), math.radians(alt)
        lx, ly, lz = math.sin(a) * math.cos(b), math.cos(a) * math.cos(b), math.sin(b)
        shade += w * np.clip(nx * lx + ny * ly + nz * lz, 0, 1)
    flat = sum(w * math.sin(math.radians(alt)) for _, alt, w in lights)
    tone = 0.965 + (shade - flat) * 0.62
    # soft cast shadows, as if lit by a big window: blur the hard shadow mask
    sh = cast_shadow(z, dy, dx)
    tone -= 0.11 * gaussian_filter(sh, 4) + 0.04 * gaussian_filter(sh, 22)
    # ambient occlusion, two scales: tight creases and broad valleys
    tone -= np.clip((gaussian_filter(z, 4) - z) / (300.0 * EXAG), 0, 0.06)
    tone -= np.clip((gaussian_filter(z, 30) - z) / (1800.0 * EXAG), 0, 0.05)
    # plaster: a fine grain plus faint mottling, multiplied in so it shows on flats too
    rng = np.random.default_rng(seed)
    grain = gaussian_filter(rng.normal(0, 1, z.shape), 0.7)
    mottle = gaussian_filter(rng.normal(0, 1, z.shape), 9)
    tone *= 1 + 0.021 * grain / grain.std() + 0.009 * mottle / mottle.std()
    tone = np.clip(tone, 0.58, 1.0)
    rgb = np.stack([tone * 0.992, tone * 0.996, tone], -1)   # a breath of cool
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
        lo1 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        if eccodes.codes_get(h, "gridType") != "regular_ll" or round(ni * eccodes.codes_get(h, "iDirectionIncrementInDegrees")) != 360:
            raise SystemExit("expected a global regular lat-lon grid")
        v = eccodes.codes_get_values(h).reshape(nj, ni)
        units = eccodes.codes_get(h, "units")
        eccodes.codes_release(h)
    lats = np.linspace(la1, la2, nj)
    # The grid can start at 180 and wrap (last point 179.75); build data-order longitudes
    # from the step, then fold into [-180, 180) and sort columns to match.
    lons = (lo1 + np.arange(ni) * (360.0 / ni) + 180.0) % 360.0 - 180.0
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


# ---------------------------------------------------------------- NBM (2.5 km, own SLR)
def newest_nbm_cycle(hours=120):
    """The newest 00z/12z NBM cycle whose 6 h snow is posted out to `hours`, or None (same rule as latest_nbm_snow)."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "archive"))
    import nbm
    now = datetime.now(timezone.utc)
    for back in range(0, 4):
        c = (now - timedelta(hours=3 + 12 * back)).replace(minute=0, second=0, microsecond=0)
        cycle = c.replace(hour=0 if c.hour < 12 else 12)
        leads = nbm.list_leads(cycle)
        if all(l in leads for l in range(6, hours + 1, 6)):
            return cycle
    return None


def latest_nbm_snow(hours=120):
    """Sum of NBM 6 h ASNOW blocks over `hours` from the newest 00z/12z cycle that has them."""
    global NBM_NX
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "archive"))
    import nbm
    import eccodes
    now = datetime.now(timezone.utc)
    for back in range(0, 4):
        c = (now - timedelta(hours=3 + 12 * back)).replace(minute=0, second=0, microsecond=0)
        cycle = c.replace(hour=0 if c.hour < 12 else 12)
        leads = nbm.list_leads(cycle)
        need = list(range(6, hours + 1, 6))
        if not all(l in leads for l in need):
            print(f"NBM {cycle:%Y-%m-%d %HZ}: leads not all posted yet", file=sys.stderr)
            continue
        cdir = os.environ.get("NBM_CACHE")      # a batch of resorts in one job downloads the national field once
        cfile = os.path.join(cdir, f"nbm-{cycle:%Y%m%d%H}-{hours}.npz") if cdir else None
        if cfile and os.path.exists(cfile):
            z = np.load(cfile)
            NBM_NX = int(z["nx"])
            print(f"NBM {cycle:%Y-%m-%d %HZ}: national field from the job cache", file=sys.stderr)
            return cycle, z["lat"], z["lon"], z["total"], []
        total, lat, lon, blocks = None, None, None, []
        for l in need:
            key = leads[l]
            idx = nbm.parse_idx(nbm.http(f"{nbm.BUCKET_URL}/{key}.idx").decode())
            rng = nbm.pick(idx, "ASNOW", "surface", f"{l - 6}-{l} hour acc fcst")
            if rng is None:
                raise SystemExit(f"NBM {cycle:%Y-%m-%d %HZ} f{l:03d}: no 6 h ASNOW in the .idx")
            raw = nbm.http(f"{nbm.BUCKET_URL}/{key}", headers={"Range": f"bytes={rng[0]}-{rng[1]}"})
            gid = eccodes.codes_new_from_message(raw)
            from regional_eps import natural_order
            vals = np.asarray(natural_order(gid, eccodes.codes_get_values(gid)), dtype="float64")
            missing = eccodes.codes_get(gid, "missingValue")
            if lat is None:
                NBM_NX = eccodes.codes_get(gid, "Nx")
                lat = np.asarray(eccodes.codes_get_array(gid, "latitudes"))
                lon = np.asarray(eccodes.codes_get_array(gid, "longitudes"))
                lon = np.where(lon > 180, lon - 360, lon)
            eccodes.codes_release(gid)
            vals[vals == missing] = np.nan
            total = vals if total is None else total + vals
            blocks.append((l, vals))
        if cfile:
            os.makedirs(cdir, exist_ok=True)
            np.savez_compressed(cfile, lat=lat, lon=lon, total=total, nx=NBM_NX)
        return cycle, lat, lon, total, blocks
    raise SystemExit("No NBM cycle with 6 h snow out to 120 h in the last 2 days")


def nbm_interp(lat, lon, pad=0.1, min_pts=100):
    """Returns f(values_m) -> inches on the map's pixel grid (triangulation built once).
    pad / min_pts: wider pad and fewer points for coarse (0.25 deg IFS) grids, terrain pilot."""
    from scipy.interpolate import LinearNDInterpolator
    from scipy.spatial import Delaunay
    box = (lat > S - pad) & (lat < N + pad) & (lon > W - pad) & (lon < E + pad)
    if box.sum() < min_pts:
        raise SystemExit(f"NBM grid has only {box.sum()} points in the map box")
    k = math.cos(math.radians(LAT0)) * 111.32
    tri = Delaunay(np.column_stack([lon[box] * k, lat[box] * 111.32]), qhull_options="QJ")
    LA, LO = np.meshgrid(np.linspace(N, S, H_PX), np.linspace(W, E, W_PX), indexing="ij")
    q = (LO * k, LA * 111.32)

    def f(values_m):
        v = values_m[box]
        if np.isnan(v).mean() > 0.01:
            raise SystemExit(f"NBM snow missing at {np.isnan(v).mean():.1%} of points; not drawing zeros")
        out = LinearNDInterpolator(tri, v)(*q)
        if np.isnan(out).any():
            raise SystemExit("NBM interpolation left gaps inside the map")
        return np.clip(out, 0, None) * 39.3701
    return f


def nbm_inches(lat, lon, total_m):
    from scipy.interpolate import griddata
    box = (lat > S - 0.1) & (lat < N + 0.1) & (lon > W - 0.1) & (lon < E + 0.1)
    if box.sum() < 100:
        raise SystemExit(f"NBM grid has only {box.sum()} points in the map box")
    v = total_m[box]
    if np.isnan(v).mean() > 0.01:
        raise SystemExit(f"NBM snow missing at {np.isnan(v).mean():.1%} of points; not drawing zeros")
    yy = np.linspace(N, S, H_PX)
    xx = np.linspace(W, E, W_PX)
    LA, LO = np.meshgrid(yy, xx, indexing="ij")
    from scipy.interpolate import LinearNDInterpolator
    from scipy.spatial import Delaunay
    k = math.cos(math.radians(LAT0)) * 111.32
    pts = np.column_stack([lon[box] * k, lat[box] * 111.32])
    tri = Delaunay(pts, qhull_options="QJ")   # joggle: the NBM grid is near-regular
    out = LinearNDInterpolator(tri, v)(LO * k, LA * 111.32)
    if np.isnan(out).any():
        raise SystemExit("NBM interpolation left gaps inside the map")
    inches = np.clip(out, 0, None) * 39.3701
    if inches.max() > 200:
        raise SystemExit(f"implausible NBM snow: max {inches.max():.1f} in")
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


def snow_shapes(field_in, levels, smooth=6, min_pts=4):
    """(lines, fill) contours of one snow field at the given inch levels."""
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    sm = gaussian_filter(field_in, smooth)
    lv = [l for l in levels if l < sm.max()]
    lines, fill = [], []
    if lv:
        lines = paths_from_contour(ax.contour(sm, levels=lv), min_pts=min_pts)
        csf = ax.contourf(sm, levels=lv + [1e6])
        for i, level in enumerate(lv):
            ds = []
            for poly in csf.get_paths()[i].to_polygons(closed_only=True):
                if len(poly) >= 3:
                    ds.append("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in poly) + " Z")
            fill.append((level, " ".join(ds)))
    plt.close(fig)
    return lines, fill


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


def svg(base_png, dem_ft, terrain, snow_lines, fill, run, mode, source="ifs", fill_from=FILL_FROM_IN, caption=None,
        extra=None, hide_snow=False):
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
                        f'stroke-opacity="{0.7 if idx else 0.42}" stroke-width="{1.3 if idx else 0.7}" '
                        f'stroke-linejoin="round" data-ft="{int(level)}"/>')
        return body

    layer(f"contours above snow line ({SNOW_LINE_FT} ft)", terrain_group(True))
    layer("contours below snow line", terrain_group(False))

    fill_body = [f'<path d="{d}" fill="{FILL[min(i + 1, len(FILL)-1)]}" fill-opacity="{FILL_OP}" '
                 f'fill-rule="evenodd" stroke="none" data-in="{lv}"/>' for i, (lv, d) in enumerate(fill) if d and lv >= fill_from]
    layer("snow fill", fill_body, hidden=(mode == "lines" or hide_snow))

    line_body = []
    for i, (lv, ds) in enumerate(snow_lines):
        if ds:
            line_body.append(f'<path d="{" ".join(ds)}" fill="none" stroke="{FILL[min(i + 2, len(FILL)-1)]}" '
                             f'stroke-width="{1.4 + 0.5 * i:.1f}" stroke-linejoin="round" data-in="{lv}"/>')
    for lv, (x, y) in label_points(snow_lines):
        line_body += halo_text(x, y, f'{lv:g}"', f'font-size="22" font-weight="600" fill="{FILL[5]}" '
                               f'text-anchor="middle" dominant-baseline="middle"')
    layer("snow lines", line_body, hidden=(mode == "fill" or hide_snow))
    for name, body in (extra or []):
        layer(name, body)

    mk = []
    for name, la, lo in RESORTS:
        x, y = px(lo, la)
        if not (0 <= x <= W_PX and 0 <= y <= H_PX):
            continue
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="9" fill="#ffffff" stroke="{INK}" stroke-width="1.6"/>')
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{INK}"/>')
        dx = -16 if name in ("Snowbird", "Alta") else 16
        anchor = "end" if dx < 0 else "start"
        dy = {"Alta": 18, "Brighton": 6, "Solitude": -10}.get(name, 0)
        label = f"{name}  {RANGE_LABELS[name]}" if name in RANGE_LABELS else name
        mk += halo_text(x + dx, y + dy, label, f'font-size="24" font-weight="500" fill="{INK}" '
                        f'text-anchor="{anchor}" dominant-baseline="middle"')
    for name, la, lo in CITIES:
        x, y = px(lo, la)
        if not (0 <= x <= W_PX and 0 <= y <= H_PX):
            continue
        mk.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{GREY}"/>')
        mk += halo_text(x + 10, y, name, f'font-size="21" fill="{GREY}" dominant-baseline="middle"')
    layer("places", mk)

    valid = run + timedelta(hours=120)
    t1, t2 = caption or (TITLE[source], f"Run {run:%a %b %-d %HZ} → {valid:%a %b %-d %HZ} · "
                         f"{SLR_NOTE[source]}, sketch snow line {SNOW_LINE_FT:,} ft · contours {CONTOUR_FT} ft")
    cap = [f'<rect x="0" y="{H_PX - 118}" width="{W_PX}" height="118" fill="#ffffff" fill-opacity="0.92"/>',
           f'<text x="36" y="{H_PX - 76}" font-size="28" font-weight="600" fill="{INK}">{t1}</text>',
           f'<text x="36" y="{H_PX - 42}" font-size="19" fill="{GREY}">{t2}</text>',
           f'<text x="36" y="{H_PX - 16}" font-size="15" fill="{GREY}">Elevation © ESA Copernicus GLO-30 · {CREDIT[source]}</text>']
    layer("caption", cap)
    L.append("</svg>")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--dem-cache")
    ap.add_argument("--fake-snow", action="store_true", help="test without ECMWF")
    ap.add_argument("--source", choices=["ifs", "nbm"], default="ifs")
    ap.add_argument("--style", choices=["plaster", "terraced"], default="plaster")
    ap.add_argument("--animate", action="store_true", help="NBM only: one frame per 6 h block + an MP4")
    ap.add_argument("--bbox", help="W,S,E,N (default: the Wasatch)")
    ap.add_argument("--width", type=int, default=0, help="px width for --bbox")
    ap.add_argument("--cells", action="store_true", help="NBM only: draw the raw 2.5 km cells with values")
    ap.add_argument("--downscale", action="store_true", help="NBM only: terrain-downscaled sketch")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.bbox:
        global W, S, E, N, LAT0, W_PX, H_PX
        W, S, E, N = map(float, a.bbox.split(","))
        LAT0 = (S + N) / 2
        W_PX = a.width or 1800
        H_PX = int(round(W_PX * (N - S) / ((E - W) * math.cos(math.radians(LAT0)))))

    dem = load_dem(a.dem_cache)
    print(f"DEM {dem.shape}, {dem.min():.0f}–{dem.max():.0f} m")
    rgb = relief(dem, a.style)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "PNG", optimize=True)
    base_png = buf.getvalue()
    open(os.path.join(a.out, "base.png"), "wb").write(base_png)

    if a.fake_snow:
        run, src = datetime(2026, 11, 18, 0, tzinfo=timezone.utc), "fake"
        yy, xx = np.mgrid[0:H_PX, 0:W_PX]
        snow = 22 * np.exp(-(((xx - W_PX * .6) / 300) ** 2 + ((yy - H_PX * .75) / 500) ** 2))
    elif a.source == "nbm":
        run, lat, lon, total, blocks = latest_nbm_snow()
        to_in = nbm_interp(lat, lon)
        snow, src = to_in(total), "aws"
    else:
        run, path, src = latest_ifs_snow(a.out)
        snow = snow_inches(path)
        os.remove(path)
    print(f"{a.source.upper()} {run:%Y-%m-%d %HZ} via {src}: snow max {snow.max():.1f} in")

    dem_ft = dem * 3.28084
    terrain, snow_lines, fill = contour_sets(dem_ft, snow)

    import cairosvg
    for mode, name in [("all", "layers.svg"), ("fill", "sketch-fill"), ("lines", "sketch-lines")]:
        s = svg(base_png, dem_ft, terrain, snow_lines, fill, run, mode, a.source)
        if mode == "all":
            open(os.path.join(a.out, name), "w").write(s)
        else:
            cairosvg.svg2png(bytestring=s.encode(), write_to=os.path.join(a.out, name + ".png"))
    json.dump({"bounds": [W, S, E, N], "px": [W_PX, H_PX], "source": a.source, "run": run.isoformat(), "fetched_via": src,
               "snow_max_in": round(float(snow.max()), 1), "slr": SLR if a.source == "ifs" else "nbm",
               "snow_line_ft_placeholder": SNOW_LINE_FT},
              open(os.path.join(a.out, "meta.json"), "w"), indent=2)
    if a.cells:
        if a.source != "nbm":
            raise SystemExit("--cells needs --source nbm")
        cap = ("5-day snow · NOAA NBM, each 2.5 km cell as issued",
               f"Run {run:%a %b %-d %HZ} → {run + timedelta(hours=120):%a %b %-d %HZ} · inches per cell, NBM's own snow ratio · "
               f"no smoothing · contours {CONTOUR_FT} ft")
        sv = svg(base_png, dem_ft, terrain, [], [], run, "all", "nbm", caption=cap,
                 extra=nbm_cells_layer(lat, lon, total), hide_snow=True)
        open(os.path.join(a.out, "cells.svg"), "w").write(sv)
        cairosvg.svg2png(bytestring=sv.encode(), write_to=os.path.join(a.out, "cells.png"))
    if a.downscale:
        if a.source != "nbm":
            raise SystemExit("--downscale needs --source nbm")
        fine, _ = downscale(dem, lat, lon, total, to_in)
        lines, fill = snow_shapes(fine, [3, 6, 12, 18, 24, 30, 36], smooth=1.2, min_pts=6)
        cap = ("5-day snow · NBM downscaled by elevation (sketch, not yet scored)",
               f"NOAA NBM {run:%b %-d %HZ} 2.5 km cells, split by 30 m terrain using each area's own snow-vs-height "
               f"slope · rings: range within 1.5 km")
        sv = svg(base_png, dem_ft, terrain, lines, fill, run, "all", "nbm", fill_from=3, caption=cap,
                 extra=downscale_layers(fine))
        open(os.path.join(a.out, "downscaled.svg"), "w").write(sv)
        cairosvg.svg2png(bytestring=sv.encode(), write_to=os.path.join(a.out, "downscaled.png"))
        np.save(os.path.join(a.out, "fine.npy"), fine.astype("float32")) if os.environ.get("KEEP_NPY") else None
    if a.animate:
        if a.source != "nbm":
            raise SystemExit("--animate needs --source nbm (6 h blocks)")
        animate(a.out, base_png, dem_ft, terrain, run, blocks, to_in)
    print("wrote", sorted(os.listdir(a.out)))


def nbm_cells_layer(lat, lon, total_m):
    """NBM's own 2.5 km cells, unsmoothed: each one filled by its 5-day total and labelled.
    Corners = mean of the four surrounding grid points (Lambert grid, so cells are tilted)."""
    nx = NBM_NX
    LAT, LON, V = lat.reshape(-1, nx), lon.reshape(-1, nx), total_m.reshape(-1, nx) * 39.3701
    rows, cols = np.where((LAT > S - 0.05) & (LAT < N + 0.05) & (LON > W - 0.07) & (LON < E + 0.07))
    r0, r1, c0, c1 = rows.min() - 1, rows.max() + 2, cols.min() - 1, cols.max() + 2
    la, lo, v = LAT[r0:r1 + 1, c0:c1 + 1], LON[r0:r1 + 1, c0:c1 + 1], V[r0:r1 + 1, c0:c1 + 1]
    cla = (la[:-1, :-1] + la[1:, :-1] + la[:-1, 1:] + la[1:, 1:]) / 4
    clo = (lo[:-1, :-1] + lo[1:, :-1] + lo[:-1, 1:] + lo[1:, 1:]) / 4
    edges = [0, 1, 3, 6, 12, 18, 24, 36, 1e9]
    shapes, labels = [], []
    for j in range(1, v.shape[0] - 1):
        for i in range(1, v.shape[1] - 1):
            val = v[j, i]
            corners = [px(clo[a, b], cla[a, b]) for a, b in ((j - 1, i - 1), (j - 1, i), (j, i), (j, i - 1))]
            d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in corners) + " Z"
            k = int(np.searchsorted(edges, val, side="right")) - 1
            if val >= 1:
                shapes.append(f'<path d="{d}" fill="{FILL[min(k, len(FILL) - 1)]}" fill-opacity="0.5" '
                              f'stroke="#ffffff" stroke-opacity="0.7" stroke-width="1"/>')
            else:
                shapes.append(f'<path d="{d}" fill="none" stroke="{GREY}" stroke-opacity="0.35" stroke-width="0.8"/>')
            x, y = px(lo[j, i], la[j, i])
            if 0 < x < W_PX and 0 < y < H_PX - 120:
                txt = f"{val:.0f}" if val >= 1 else ("" if val < 0.05 else f"{val:.1f}".lstrip("0"))
                if txt:
                    labels += halo_text(x, y, txt, f'font-size="19" font-weight="600" fill="{INK}" '
                                                  f'text-anchor="middle" dominant-baseline="middle"')
    return [("nbm cells (2.5 km, 5-day in.)", shapes), ("cell values (in.)", labels)]


def downscale(dem_m, lat, lon, total_m, to_in, radius_km=10.0, margin=(0.15, 0.2), min_cnt=50, min_nb=8):
    """Sketch of terrain downscaling, from NBM alone (no PRISM yet, not yet scored).

    1. Assign every map pixel to its nearest NBM cell; a cell's terrain height = mean of
       the 30 m DEM over its footprint (stands in for the model's smoothed terrain).
    2. For each cell, fit snow vs cell height over the cells within `radius_km`
       (weighted least squares): the local "inches per 1,000 ft". Never negative.
    3. Fine snow = smooth NBM field + gradient x (pixel height - smoothed cell height).
       The added term averages ~0 over a cell, so cell totals are kept.
    Returns (inches per pixel, gradient in in/1000 ft per pixel)."""
    from scipy.spatial import cKDTree
    k = math.cos(math.radians(LAT0)) * 111.32
    box = (lat > S - margin[0]) & (lat < N + margin[0]) & (lon > W - margin[1]) & (lon < E + margin[1])
    clat, clon, cval = lat[box], lon[box], total_m[box] * 39.3701
    tree = cKDTree(np.column_stack([clon * k, clat * 111.32]))
    LA, LO = np.meshgrid(np.linspace(N, S, H_PX), np.linspace(W, E, W_PX), indexing="ij")
    _, owner = tree.query(np.column_stack([LO.ravel() * k, LA.ravel() * 111.32]))
    zft = dem_m.ravel() * 3.28084
    cnt = np.bincount(owner, minlength=len(clat))
    zbar = np.bincount(owner, weights=zft, minlength=len(clat)) / np.maximum(cnt, 1)
    if (cnt == 0).any():                              # cells just off the map: borrow the nearest
        inside = np.where(cnt > 0)[0]                 # cell's height so edges aren't pulled to 0 ft
        _, nn = cKDTree(np.column_stack([clon[inside] * k, clat[inside] * 111.32])).query(
            np.column_stack([clon[cnt == 0] * k, clat[cnt == 0] * 111.32]))
        zbar[cnt == 0] = zbar[inside[nn]]
    seen = cnt > min_cnt                              # cells mostly inside the map
    pts = np.column_stack([clon * k, clat * 111.32])
    grad = np.full(len(clat), np.nan)
    for c in np.where(seen)[0]:
        nb = [j for j in tree.query_ball_point(pts[c], radius_km) if seen[j] and cval[j] >= 0.5]
        if len(nb) < min_nb:
            continue
        x, y = zbar[nb] / 1000.0, cval[nb]
        w = np.exp(-np.sum((pts[nb] - pts[c]) ** 2, 1) / (2 * (radius_km / 2) ** 2))
        xm, ym = np.average(x, weights=w), np.average(y, weights=w)
        vx = np.average((x - xm) ** 2, weights=w)
        if vx < 0.05:                                 # flat neighbourhood: no gradient to learn
            continue
        grad[c] = max(0.0, np.average((x - xm) * (y - ym), weights=w) / vx)
    grad = np.where(np.isnan(grad), 0.0, grad)
    # smooth both cell fields onto the pixels (same triangulation as the base field)
    full = np.zeros_like(total_m, dtype=float)
    full[np.where(box)[0]] = zbar / 39.3701
    zbar_px = to_in(full)
    full[np.where(box)[0]] = grad / 39.3701
    grad_px = to_in(full)
    base = to_in(total_m)
    fine = np.clip(base + grad_px * (dem_m * 3.28084 - zbar_px) / 1000.0, 0, None)
    print(f"  downscale: gradient median {np.median(grad[seen & (grad > 0)]):.1f} in/1000 ft, "
          f"max {grad.max():.1f}; fine max {fine.max():.1f} in vs cell max {cval.max():.1f}")
    return fine, grad_px


RANGE_LABELS = {}   # resort name -> "lo–hi"" shown beside its name


def downscale_layers(fine):
    """Resort labels: the range of downscaled snow within 1.5 km (base-to-top proxy)."""
    body = []
    r_px = 1.5 / ((E - W) * 111.32 * math.cos(math.radians(LAT0)) / W_PX)
    yy, xx = np.mgrid[0:H_PX, 0:W_PX]
    for name, la, lo in RESORTS:
        x, y = px(lo, la)
        if not (0 <= x <= W_PX and 0 <= y <= H_PX):
            continue
        m = (xx - x) ** 2 + (yy - y) ** 2 <= r_px ** 2
        lo_in, hi_in = np.percentile(fine[m], [5, 95])
        body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r_px:.1f}" fill="none" stroke="{INK}" '
                    f'stroke-opacity="0.45" stroke-width="1.2" stroke-dasharray="3 5"/>')
        RANGE_LABELS[name] = f'{lo_in:.0f}–{hi_in:.0f}"'
    return [("snow range within 1.5 km (in.)", body)]


SIX_H_LEVELS_IN = [0.5, 1, 2, 4, 8]   # snow in this 6 h block: the fill


def animate(out, base_png, dem_ft, terrain, run, blocks, to_in):
    """Frame per 6 h block: fill = snow falling in that block, lines = running total."""
    import cairosvg, subprocess
    from zoneinfo import ZoneInfo
    mt = ZoneInfo("America/Denver")
    fdir = os.path.join(out, "frames")
    os.makedirs(fdir, exist_ok=True)
    running = np.zeros((H_PX, W_PX))
    for n, (lead, vals) in enumerate(blocks):
        six = to_in(vals)
        running = running + six
        lines, _ = snow_shapes(running, SNOW_LEVELS_IN)
        _, fill = snow_shapes(six, SIX_H_LEVELS_IN, smooth=4)
        end = (run + timedelta(hours=lead)).astimezone(mt)
        start = (run + timedelta(hours=lead - 6)).astimezone(mt)
        t1 = (f"{start:%a %b %-d %-I %p} – " + (f"{end:%-I %p}" if end.date() == start.date() else f"{end:%a %-I %p}")
              + " MT").replace("AM", "am").replace("PM", "pm")
        t2 = (f"Fill: snow in these 6 hours · lines: total so far (max {running.max():.0f} in) · "
              f"NOAA NBM {run:%b %-d %HZ}, 2.5 km, NBM's own snow ratio")
        sv = svg(base_png, dem_ft, terrain, lines, fill, run, "all", "nbm", fill_from=0, caption=(t1, t2))
        cairosvg.svg2png(bytestring=sv.encode(), write_to=os.path.join(fdir, f"f{n:02d}.png"),
                         output_width=W_PX // 2, output_height=H_PX // 2)
        print(f"  frame {n:02d} f{lead:03d}: 6 h max {six.max():.1f} in, total max {running.max():.1f} in")
    # 3 fps; hold the last frame ~2 s. H.264, veryfast, even dimensions.
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "3", "-i", os.path.join(fdir, "f%02d.png"),
                        "-vf", "tpad=stop_mode=clone:stop_duration=2,scale=trunc(iw/2)*2:trunc(ih/2)*2",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                        "-movflags", "+faststart", os.path.join(out, "nbm-5day.mp4")], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"ffmpeg failed: {r.stderr[-800:]}")


if __name__ == "__main__":
    main()
