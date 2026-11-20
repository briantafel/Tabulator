"""Terrain pilot: one resort's snow-by-terrain map at 4K, plus a Blender file.

  python3 terrain_pilot.py OUTDIR RESORT_ID [--px 4096]      (BLENDER=/path/to/blender required)

Builds on resort_map.py (outline from the resort's own runs, lifts, runs, snow bands, labels) and
relief_ortho.py (plaster relief). Settled look unchanged: same lighting ("even"), levels step, crop rule
(run-traced outline + 150 m, square), outline, colours, label content. What is new (claude/state-2026-11-19-terrain-pilot.md):

  * relief rendered at PX x PX for the square frame, from a 16-bit heightmap on the native DEM grid
    (USGS 3DEP 10 m in the US, Copernicus GLO-30 elsewhere), displaced in Blender at render time
  * snow from NBM where it covers the resort, else ECMWF IFS open data (same terrain step)
  * every vector (snow lines, outline, lifts, runs, labels) is written in SVG at the PX frame size, with
    line widths and font sizes scaled so they read the same at phone width as the old 1800 px maps
  * <id>.blend: terrain from the packed heightmap, plaster, lights, camera, render settings

Outputs (OUTDIR): <id>.png <id>.svg <id>-vectors.svg <id>-relief.png <id>-heightmap16.png <id>.blend <id>.json
and preview/<id>-1024.png, preview/<id>-crop1to1.png. Failures are loud: a FAILED.txt is written and the exit code is non-zero.
(Ski area outline, lifts and runs: OpenSkiMap / OpenStreetMap contributors, ODbL.)
"""
import argparse, base64, io, json, math, os, subprocess, sys, time, traceback
from datetime import timedelta
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from PIL import Image, ImageDraw
from scipy.interpolate import RectBivariateSpline, RegularGridInterpolator
from scipy.ndimage import (binary_fill_holes, distance_transform_edt, gaussian_filter,
                           label as cc_label, uniform_filter)

sys.path.insert(0, os.path.dirname(__file__))
import sketch as sk  # noqa: E402
import resort_map as rm  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
ROOT = rm.ROOT
OLD_PX = 1800                 # width in px of the render grid resort_map.py used for the crop
PAD_M = 150.0                 # frame = outline + 150 m (settled)
MARGIN_M = 300.0              # extra terrain around the frame in the heightmap (shading context)
EXAG = 2.0
HIRES_HM = 4096               # heightmap samples per side in hires mode (= the mesh: 256 x 2^4)
EXPOSURE = -0.9
LIGHTS = [["even", 315, 45, 2.3, 18, 0.42, [135, 40, 0.9]]]      # settled 2026-11-19
LEVELS = dict(p_lo=0.5, p_hi=99.7, out_lo=0.52, out_hi=0.975, gamma=0.85)   # settled levels step
RAMP = ["#c9dcf2", "#9fc0ea", "#6f9fe0", "#3f7bd6", "#1d5ccc", "#0d3fb0", "#06268a"]
SLR_IFS = 12.0                # placeholder snow-to-liquid ratio for IFS (same as sketch.SLR)
CAPTION = {"nbm": "NOAA NBM • Tabulator terrain-adjusted", "ifs": "ECMWF IFS • Tabulator terrain-adjusted"}
FT = 3.28084
# App layout (Brian 2026-11-20): one render serves the resort sheet (square) and the full-screen map (pan/zoom).
# Reference phone 402 x 874; full-screen band between the header and the legend, 15 px side margins.
REF_W, REF_H = 402.0, 874.0
SIDE_PX = 10.0                      # outline to screen side at the fit view (Brian 2026-11-20)
BAND_TOP, BAND_BOT = 64.0, 118.0    # header row + gap above; legend card + margins below
BAND_H = REF_H - BAND_TOP - BAND_BOT
BAND_CY = BAND_TOP + BAND_H / 2     # 410: where the outline's centre sits
OVERSCAN = 17.0                     # extra terrain each side of the reference width, so other phone shapes still get covered


def log(*a):
    print(*a, flush=True)


def retry(fn, what, tries=3, wait=20):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001  (loud in the log, re-raised after the last try)
            last = e
            log(f"{what}: attempt {i + 1}/{tries} failed: {e}")
            time.sleep(wait)
    raise RuntimeError(f"{what} failed after {tries} tries: {last}")


class Grid:
    """Linear lon/lat -> pixel map (the same equirectangular crop resort_map.py uses)."""
    def __init__(self, bbox, w, h):
        self.W, self.S, self.E, self.N = bbox
        self.w, self.h = w, h

    def P(self, la, lo):
        return (lo - self.W) / (self.E - self.W) * self.w, (self.N - la) / (self.N - self.S) * self.h


# ---------------------------------------------------------------- DEM
def tiles_usgs(b):
    W, S, E, N = b
    out = []
    for la in range(math.floor(S), math.floor(N) + 1):
        for lo in range(math.floor(W), math.floor(E) + 1):
            n = f"n{la + 1:02d}w{-lo:03d}"
            out.append(f"/vsicurl/https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{n}/USGS_13_{n}.tif")
    return out


def tiles_cop(b):
    W, S, E, N = b
    out = []
    for la in range(math.floor(S), math.floor(N) + 1):
        for lo in range(math.floor(W), math.floor(E) + 1):
            ns = f"N{la:02d}" if la >= 0 else f"S{-la:02d}"
            ew = f"W{-lo:03d}" if lo < 0 else f"E{lo:03d}"
            k = f"Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM"
            out.append(f"/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/{k}/{k}.tif")
    return out


FILLED_VOIDS = []


def merge_tiles(urls, bbox, res, resampling, tolerate_missing):
    srcs, missing = [], []
    for u in urls:
        try:
            srcs.append(rasterio.open(u))
        except Exception as e:  # noqa: BLE001
            missing.append((u, str(e)[:120]))
    if not srcs:
        raise RuntimeError(f"no DEM tiles could be opened, e.g. {missing[:1]}")
    if missing and not tolerate_missing:
        raise RuntimeError(f"{len(missing)} of {len(urls)} DEM tiles missing: {missing[:2]}")
    arr, _ = merge(srcs, bounds=bbox, res=(res, res), resampling=resampling, nodata=-9999)
    z = arr[0].astype("float32")
    bad = z < -500
    if missing:
        log(f"  WARNING {len(missing)} Copernicus tiles absent (open sea): {bad.mean():.1%} of the box filled with 0 m")
        z[bad] = 0.0
    elif bad.mean() > 0.01:
        raise RuntimeError(f"DEM has {bad.mean():.2%} nodata (more than 1%: refusing to fill)")
    elif bad.any():
        # small scattered voids (Copernicus water/void cells): fill from the nearest valid cell, and say so
        idx = distance_transform_edt(bad, return_distances=False, return_indices=True)
        z = z[tuple(idx)]
        log(f"  WARNING DEM voids filled from nearest valid cell: {bad.mean():.2%} of the box")
        FILLED_VOIDS.append(float(bad.mean()))
    return z


def tiles_usgs_1m(b):
    """USGS 3DEP 1 m lidar DEMs over bbox, newest first (TNM Access API). Projects overlap; merge fills from the next."""
    import urllib.parse
    import urllib.request
    W, S, E, N = b
    q = urllib.parse.urlencode({"datasets": "Digital Elevation Model (DEM) 1 meter", "bbox": f"{W:.5f},{S:.5f},{E:.5f},{N:.5f}",
                                "max": "100", "outputFormat": "JSON"})

    def go():
        with urllib.request.urlopen("https://tnmaccess.nationalmap.gov/api/v1/products?" + q, timeout=90) as r:
            return json.load(r)
    items = retry(go, "TNM Access 1 m DEM query").get("items", [])
    items = [i for i in items if i.get("downloadURL", "").endswith(".tif")]
    items.sort(key=lambda i: i.get("publicationDate", ""), reverse=True)
    log(f"  3DEP 1 m: {len(items)} tiles: " + "; ".join(f"{i['title']} ({i.get('publicationDate')})" for i in items[:6]))
    return ["/vsicurl/" + i["downloadURL"] for i in items]


def merge_1m(urls, bbox, res):
    """1 m UTM tiles -> one lon/lat grid at `res` deg, first (newest) tile wins, nodata (-9999) where none covers."""
    from rasterio.vrt import WarpedVRT
    srcs = []
    for u in urls:
        try:
            src = rasterio.open(u)
            srcs.append(WarpedVRT(src, crs="EPSG:4326", resampling=Resampling.bilinear, src_nodata=src.nodata, nodata=-9999))
        except Exception as e:  # noqa: BLE001
            log(f"  1 m tile skipped: {u.split('/')[-1]}: {str(e)[:100]}")
    if not srcs:
        raise RuntimeError("no 1 m tile could be opened")
    arr, _ = merge(srcs, bounds=bbox, res=(res, res), resampling=Resampling.bilinear, nodata=-9999)
    return arr[0].astype("float32")


NON_US = False     # set from the resort's region ("Canada"): the 49th parallel cannot tell Ontario from New York


def is_us(lat, lon):
    if NON_US:
        return False
    return 24.0 < lat < 49.0 and -125.0 < lon < -66.0   # 49th parallel is the border; Red Mountain (49.1) must not count as US


def load_dem_1m(bbox, lat_c, lon_c):
    """3DEP 1 m lidar (about 1.0 x 0.76 m cells), holes filled from the 10 m 3DEP and said so. None if there is no 1 m coverage."""
    res = 1 / 111320.0
    urls = tiles_usgs_1m(bbox)
    if not urls:
        return None
    z = retry(lambda: merge_1m(urls, bbox, res), "USGS 3DEP 1 m")
    bad = z < -500
    cover = 1 - bad.mean()
    if cover < 0.5:
        log(f"  WARNING 1 m lidar covers only {cover:.0%} of the box")
        return None
    filled = float(bad.mean())
    if bad.any():
        coarse = retry(lambda: merge_tiles(tiles_usgs(bbox), bbox, res, Resampling.bilinear, False), "USGS 3DEP 10 m (void fill)")
        z[bad] = coarse[bad]
        del coarse
        log(f"  WARNING {filled:.2%} of the 1 m grid had no lidar; filled from the 10 m DEM")
    info = {"source": "USGS 3DEP 1 m lidar DEM" + (f" (+{filled:.1%} from 10 m)" if filled else ""), "native_res_deg": res,
            "native_res_m": [round(res * 111320, 2), round(res * 111320 * math.cos(math.radians(lat_c)), 2)],
            "native_res_m_note": "N-S x E-W", "native_shape": list(z.shape), "voids_filled_fraction": round(filled, 5), "fine": True}
    log(f"DEM {info['source']}: {z.shape}, {z.min():.0f}-{z.max():.0f} m")
    return z, bbox[0], bbox[3], res, info


def load_dem_native(bbox, lat_c, lon_c, fine=False):
    """Native-grid DEM over bbox: USGS 3DEP 1/3 arc-sec (US) or Copernicus GLO-30 (elsewhere).
    Returns (z, lon0, lat1, res_deg, info). A US resort that cannot get 3DEP fails (no silent downgrade)."""
    if fine and is_us(lat_c, lon_c):
        got = load_dem_1m(bbox, lat_c, lon_c)
        if got:
            return got
        log("  WARNING hires asked for but no usable 1 m lidar here: using the 10 m DEM")
    if is_us(lat_c, lon_c):
        res, src = 1 / 10800, "USGS 3DEP 1/3 arc-sec (10 m)"
        z = retry(lambda: merge_tiles(tiles_usgs(bbox), bbox, res, Resampling.bilinear, False), "USGS 3DEP")
    else:
        res, src = 1 / 3600, "Copernicus GLO-30 (30 m DSM)"
        z = retry(lambda: merge_tiles(tiles_cop(bbox), bbox, res, Resampling.bilinear, False), "Copernicus GLO-30")
    info = {"source": src, "native_res_deg": res,
            "native_res_m": [round(res * 111320, 1), round(res * 111320 * math.cos(math.radians(lat_c)), 1)],
            "native_res_m_note": "N-S x E-W", "native_shape": list(z.shape),
            "voids_filled_fraction": round(FILLED_VOIDS[-1], 5) if FILLED_VOIDS else 0.0}
    log(f"DEM {src}: {z.shape}, {z.min():.0f}-{z.max():.0f} m")
    return z, bbox[0], bbox[3], res, info


def dem_wide(bbox, wpx, hpx):
    res = ((bbox[2] - bbox[0]) / wpx, (bbox[3] - bbox[1]) / hpx)
    srcs_urls = tiles_cop(bbox)

    def go():
        srcs, missing = [], 0
        for u in srcs_urls:
            try:
                srcs.append(rasterio.open(u))
            except Exception:  # noqa: BLE001
                missing += 1
        if not srcs:
            raise RuntimeError("no Copernicus tiles for the wide box")
        arr, _ = merge(srcs, bounds=bbox, res=res, resampling=Resampling.average, nodata=-9999)
        z = arr[0].astype("float32")[:hpx, :wpx]
        bad = z < -500
        if bad.mean() > 0.02 and not missing:
            raise RuntimeError(f"wide DEM has {bad.mean():.1%} nodata")
        if bad.any():
            log(f"  wide DEM: {missing} tiles absent / {bad.mean():.1%} nodata filled with 0 m (open sea)")
            z[bad] = 0.0
        if z.shape != (hpx, wpx):
            raise RuntimeError(f"wide DEM shape {z.shape}")
        return z
    return retry(go, "wide DEM")


# ---------------------------------------------------------------- snow
def set_box(bbox, wpx):
    rm.set_box(bbox, wpx)


def ifs_cells(work, box):
    """IFS 5-day snowfall as scattered cells inside box (+3 deg): (run, lat, lon, snow_m at 12:1, spacing deg, source)."""
    run, path, src = sk.latest_ifs_snow(str(work))
    lats, lons, v, units = sk.read_grib_ll(path)
    swe = v / 1000.0 if "kg" in units else v
    if not np.isfinite(swe).all():
        raise SystemExit("IFS snowfall has missing values; not drawing zeros")
    W, S, E, N = box
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    sel = (LA > S - 3) & (LA < N + 3) & (LO > W - 3) & (LO < E + 3)
    spacing = float(abs(lats[1] - lats[0]))
    log(f"IFS {run:%Y-%m-%d %HZ} via {src}: {spacing}° grid ({spacing * 111.32:.0f} km), {int(sel.sum())} cells near the resort; "
        f"max {np.nanmax(swe[sel]) * 1000:.1f} mm water")
    return run, LA[sel], LO[sel], np.clip(swe[sel], 0, None) * SLR_IFS, spacing, src


def build_snow(rid, crop, lat_c, lon_c, work):
    """Returns (sample(LA, LO, dem_m) -> inches on that grid, info). NBM where it covers the resort, else IFS."""
    info = {"nbm_checked": False}
    nominal = 19.0 < lat_c < 56.0 and -140.0 < lon_c < -60.0
    if nominal:
        wide = (crop[0] - 0.16, crop[1] - 0.12, crop[2] + 0.16, crop[3] + 0.12)
        set_box(wide, 1400)
        info["nbm_checked"] = True
        run, lat, lon, total, _ = sk.latest_nbm_snow()
        in_box = (lat > sk.S - 0.1) & (lat < sk.N + 0.1) & (lon > sk.W - 0.1) & (lon < sk.E + 0.1)
        log(f"NBM grid lat {lat.min():.2f}..{lat.max():.2f}, lon {lon.min():.2f}..{lon.max():.2f}; "
            f"{int(in_box.sum())} cells in the {wide[0]:.2f},{wide[1]:.2f},{wide[2]:.2f},{wide[3]:.2f} box")
        reason = None
        try:
            to_in = sk.nbm_interp(lat, lon)
            tin = to_in(total)
        except SystemExit as e:
            reason = str(e.code)
        if reason is None:
            dem_w = dem_wide(wide, sk.W_PX, sk.H_PX)
            ctr = tin[(abs(np.linspace(sk.N, sk.S, sk.H_PX) - lat_c) < 0.02)[:, None] &
                      (abs(np.linspace(sk.W, sk.E, sk.W_PX) - lon_c) < 0.03)[None, :]]
            cross = None
            if lat_c > 47.0:         # near/over the border: confirm NBM carries real values here, not fill
                try:
                    _, ila, ilo, itot, _, _ = ifs_cells(work, wide)
                    near = (abs(ila - lat_c) < 0.2) & (abs(ilo - lon_c) < 0.3)
                    ifs_in = float(itot[near].mean() * 39.3701)
                    cross = {"nbm_in": round(float(ctr.mean()), 1), "ifs_in_12to1": round(ifs_in, 1)}
                    log(f"NBM vs IFS cross-check at the resort: {cross}")
                    if ifs_in >= 3.0 and ctr.mean() < 0.2 * ifs_in:
                        reason = f"NBM looks empty here ({ctr.mean():.1f} in vs IFS {ifs_in:.1f} in)"
                except SystemExit as e:
                    cross = {"error": str(e.code)}
            info["cross_check"] = cross
        if reason is None:
            fine_w, grad_w = sk.downscale(dem_w, lat, lon, total, to_in)
            info.update(source="NBM", caption=CAPTION["nbm"], run=run.isoformat(), grid="NBM 2.5 km",
                        slr="NBM's own snow ratio", nbm_check="inside the NBM grid, values present")
            return _sampler(fine_w, grad_w, dem_w, wide), info
        log(f"NBM does not cover {rid}: {reason} -> using ECMWF IFS")
        info["nbm_check"] = f"not used: {reason}"
    else:
        info["nbm_check"] = "outside the NBM domain (CONUS + southern Canada)"
        log(f"{rid} is outside the NBM domain -> using ECMWF IFS")
    # --- ECMWF IFS open data
    wide = (lon_c - 1.0, lat_c - 0.75, lon_c + 1.0, lat_c + 0.75)
    set_box(wide, 1400)
    run, lat, lon, total, spacing, src = ifs_cells(work, wide)
    pad = 1.2 * spacing
    to_in = sk.nbm_interp(lat, lon, pad=pad, min_pts=12)
    to_in(total)       # raises (loudly) if the triangulation leaves gaps
    dem_w = dem_wide(wide, sk.W_PX, sk.H_PX)
    fine_w, grad_w = sk.downscale(dem_w, lat, lon, total, to_in, radius_km=3.2 * spacing * 111.32,
                                  margin=(pad + 0.05, pad + 0.05), min_cnt=50, min_nb=6)
    info.update(source="IFS", caption=CAPTION["ifs"], run=run.isoformat(), grid=f"IFS {spacing}° ({spacing * 111.32:.0f} km), via {src}",
                slr=f"{SLR_IFS:g}:1 placeholder (no temperature-dependent ratio yet)")
    return _sampler(fine_w, grad_w, dem_w, wide), info


def _sampler(fine_w, grad_w, dem_w, wide):
    ys = np.linspace(wide[3], wide[1], dem_w.shape[0])[::-1]
    xs = np.linspace(wide[0], wide[2], dem_w.shape[1])
    f_f = RegularGridInterpolator((ys, xs), fine_w[::-1], bounds_error=True)
    f_g = RegularGridInterpolator((ys, xs), grad_w[::-1], bounds_error=True)
    f_d = RegularGridInterpolator((ys, xs), dem_w[::-1], bounds_error=True)
    if not np.isfinite(grad_w).all() or float(np.max(grad_w)) <= 0:
        raise SystemExit("terrain step learned no snow-vs-height gradient here; refusing to label the map 'terrain-adjusted'")

    def sample(LA, LO, dem_m):
        q = np.stack([LA, LO], -1)
        coarse, grad, dw = f_f(q), f_g(q), f_d(q)
        # the wide field carries the height term at its own resolution; re-apply the same local rate to the
        # fine terrain's departure from that (same step as resort_map.py)
        return np.clip(coarse + grad * (dem_m - dw) * FT / 1000.0, 0, None)
    return sample


# ---------------------------------------------------------------- outline (resort_map.py's rule, on any grid)
def trace_outline(runs, g, m_px):
    canvas = Image.new("L", (g.w, g.h), 0)
    dr = ImageDraw.Draw(canvas)
    for _, geom, area in runs:
        xy = [g.P(la, lo) for la, lo in geom]
        if area and len(xy) > 2:
            dr.polygon(xy, fill=255)
        else:
            dr.line(xy, fill=255, width=max(2, int(round(45 / m_px))), joint="curve")
    raw = np.asarray(canvas) > 0
    r_close = 110 / m_px
    grown = distance_transform_edt(~raw) <= r_close
    mask = binary_fill_holes(distance_transform_edt(grown) > r_close * 0.85)
    del grown
    r_open = 100 / m_px
    eroded = distance_transform_edt(mask) > r_open
    opened = distance_transform_edt(~eroded) <= r_open
    opened &= mask
    del eroded
    lab_, nlab = cc_label(opened)
    trimmed = 0.0
    if nlab:
        sizes = np.bincount(lab_.ravel())[1:]
        keep = np.isin(lab_, 1 + np.where(sizes >= 0.05 * sizes.max())[0])
        if keep.sum() > 0.5 * mask.sum():
            trimmed = float((mask.sum() - keep.sum()) * m_px * m_px / 4046.86)
            mask = keep
    # every mapped run stays inside the outline: the open/trim steps above only smooth the shape, they must
    # never remove a run (Brian 2026-11-19: lifts ended where runs had been trimmed away)
    mask = mask | (distance_transform_edt(~raw) <= 60 / m_px)
    trimmed = 0.0
    del raw
    if mask.mean() < 0.0005:
        sys.exit("skiable-terrain mask is nearly empty (no runs mapped?); refusing to draw")
    return mask, trimmed



LIFT_NEAR_M = 150.0           # a run cluster belongs to the resort if an operating lift passes within this of it


def prune_runs(runs, lifts, g, m_px):
    """Drop runs whose cluster (the connected piece of the traced outline) has no operating lift within LIFT_NEAR_M:
    OpenSkiMap tags backcountry / out-of-area runs to the resort, and they draw as terrain nothing connects to
    (Brian 2026-11-20, Crystal). Returns (kept runs, dropped list). Never prunes if it would leave under half the
    terrain, or if no lift touches any cluster (then the lift data, not the runs, is what is wrong): says so."""
    mask, _ = trace_outline(runs, g, m_px)
    lab, n = cc_label(mask)
    if n < 2:
        return runs, []
    canvas = Image.new("L", (g.w, g.h), 0)
    dr = ImageDraw.Draw(canvas)
    for _, geom, _a in lifts:
        xy = [g.P(la, lo) for la, lo in geom]
        if len(xy) >= 2:
            dr.line(xy, fill=255, width=2)
    near = distance_transform_edt(np.asarray(canvas) == 0) <= LIFT_NEAR_M / m_px
    keep = set(np.unique(lab[near & (lab > 0)]).tolist())
    if not keep:
        log("WARNING prune_runs: no lift touches any run cluster; keeping all runs")
        return runs, []
    area = np.bincount(lab.ravel(), minlength=n + 1)
    if area[list(keep)].sum() < 0.5 * area[1:].sum():
        log("WARNING prune_runs: lift-served clusters are under half the terrain; keeping all runs")
        return runs, []
    kept, dropped = [], []
    for r in runs:
        pts = [g.P(la, lo) for la, lo in r[1]]
        ids = {int(lab[min(g.h - 1, max(0, int(round(y)))), min(g.w - 1, max(0, int(round(x))))]) for x, y in pts}
        ids.discard(0)
        if not ids or ids & keep:
            kept.append(r)
        else:
            dropped.append({"name": r[0].get("name"), "cluster_acres": round(float(area[next(iter(ids))]) * m_px * m_px / 4046.86)})
    return kept, dropped


# ---------------------------------------------------------------- Blender + levels
def run_blender(hm_png, meta, prefix):
    blender = os.environ.get("BLENDER")
    if not blender:
        sys.exit("BLENDER is not set: the 4K relief needs Blender (no numpy fallback at this size)")
    meta_path = Path(str(prefix) + "-meta.json")
    meta_path.write_text(json.dumps(meta))
    cmd = [blender, "-b", "-P", str(Path(__file__).with_name("relief_heightmap.py")), "--", str(hm_png), str(meta_path), str(prefix)]
    t0 = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    keep = [l for l in r.stdout.splitlines() if l.startswith(("heightmap ", "displacement check", "blend_mb", "rendered"))]
    log("\n".join("  blender: " + l for l in keep))
    if r.returncode or not Path(str(prefix) + "-tiles.json").exists():
        sys.exit(f"Blender failed (exit {r.returncode}): {(r.stdout[-800:] + r.stderr[-1500:])}")
    out = {}
    for l in keep:
        if l.startswith("blend_mb"):
            out["blend_mb"] = float(l.split()[1])
        if l.startswith("rendered"):
            out["render_s"] = float(l.split()[1])
        if l.startswith("displacement check"):
            out["displacement_check"] = l
    out["blender_wall_s"] = round(time.time() - t0)
    return out


def stitch(prefix, px):
    """Kept centres of the Blender tiles -> one px x px RGB array."""
    out = np.zeros((px, px, 3), dtype="uint8")
    for t in json.loads(Path(str(prefix) + "-tiles.json").read_text()):
        a = np.asarray(Image.open(t["file"]).convert("RGB"))
        if a.shape[:2] != (t["y1"] - t["y0"], t["x1"] - t["x0"]):
            sys.exit(f"tile {t['file']} is {a.shape}, expected {(t['y1'] - t['y0'], t['x1'] - t['x0'])}")
        out[t["ky0"]:t["ky1"], t["kx0"]:t["kx1"]] = a[t["ky0"] - t["y0"]:t["ky1"] - t["y0"], t["kx0"] - t["x0"]:t["kx1"] - t["x0"]]
        Path(t["file"]).unlink()
    return out


def level(raw_rgb):
    """The settled levels step: brightest slopes just under white, darkest 0.5% at 0.52, mid-tones lifted."""
    g = raw_rgb.mean(-1)
    lo_, hi_ = np.percentile(g, LEVELS["p_lo"]), np.percentile(g, LEVELS["p_hi"])
    t = np.clip((g - lo_) / max(1.0, hi_ - lo_), 0, 1) ** LEVELS["gamma"]
    v = LEVELS["out_lo"] + t * (LEVELS["out_hi"] - LEVELS["out_lo"])
    scale = (v * 255.0) / np.maximum(g, 1.0)
    out = np.clip(raw_rgb.astype("float32") * scale[..., None], 0, 255).astype("uint8")
    g2 = out.mean(-1)
    stats = {"clipped_pct": round(float((g2 >= 254).mean() * 100), 3),
             "darkest1pct_grey_pct": round(float(np.percentile(g2, 1) / 255 * 100), 1),
             "darkest1pct_value": round(float(np.percentile(g2, 1)), 1),
             "median_value": round(float(np.median(g2)), 1),
             "raw_clipped_pct": round(float((g >= 254).mean() * 100), 3),
             "raw_p_lo": round(float(lo_), 2), "raw_p_hi": round(float(hi_), 2)}
    return out, stats


def halo(x, y, txt, attrs, sw):
    import re
    bare = re.sub(r'\s*fill="[^"]*"', "", attrs)
    return [f'<text x="{x:.1f}" y="{y:.1f}" {bare} fill="#ffffff" stroke="#ffffff" stroke-width="{sw:.1f}" stroke-linejoin="round">{txt}</text>',
            f'<text x="{x:.1f}" y="{y:.1f}" {attrs}>{txt}</text>']


def inside_label_points(lines, mask, px):
    """One label point per contour level, on the contour's longest stretch that lies inside the skiable outline
    (middle of that stretch). A level with no line inside the outline gets no label: never a label on bare ground."""
    out = []
    for level, ds in lines:
        best = []
        for d in ds:
            pts = [tuple(map(float, q.strip("ML ").split(","))) for q in d.split(" L")]
            run = []
            for x, y in pts + [(-1.0, -1.0)]:
                if 0 <= x < px and 0 <= y < px and bool(mask[int(y), int(x)]):
                    run.append((x, y))
                else:
                    if len(run) > len(best):
                        best = run
                    run = []
        if best:
            out.append((level, best[len(best) // 2]))
    return out


def contours(field, levels, sigma, scale, flip=None):
    """(lines, fill): lines = [(level, ['M x,y L ...'])], fill = [(level, 'M ... Z M ...')], in frame px."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    sm = gaussian_filter(field, sigma)
    lv = [l for l in levels if l < sm.max()]
    lines, fill = [], []

    def fmt(seg):
        return "M" + " L".join(f"{(x + 0.5) * scale:.1f},{(y + 0.5) * scale:.1f}" for x, y in seg)
    if lv:
        cs = ax.contour(sm, levels=lv)
        for level_, segs in zip(cs.levels, cs.allsegs):
            lines.append((level_, [fmt(s) for s in segs if len(s) >= 8]))
        csf = ax.contourf(sm, levels=lv + [1e6])
        for i, level_ in enumerate(lv):
            ds = [fmt(p) + " Z" for p in csf.get_paths()[i].to_polygons(closed_only=True) if len(p) >= 3]
            fill.append((level_, " ".join(ds)))
    plt.close(fig)
    return lines, fill


# ---------------------------------------------------------------- main
def run(out, rid, px=4096, work=None, app=False, hires=False):
    t_start = time.time()
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "preview").mkdir(exist_ok=True)
    work = Path(work or out / "work")
    work.mkdir(exist_ok=True)
    timing = {}
    r = rm.resort(rid)
    global NON_US
    NON_US = r.get("region") == "Canada"
    elev = json.loads((ROOT / "src/data/resort-elevations.json").read_text())["resorts"].get(rid, {})
    rings, area_name = rm.ski_area(r, elev.get("osm_id"), elev.get("osm_name"))
    pts = np.array([p for ring in rings for p in ring])
    la0, la1, lo0, lo1 = pts[:, 0].min(), pts[:, 0].max(), pts[:, 1].min(), pts[:, 1].max()
    lat_c, lon_c = (la0 + la1) / 2, (lo0 + lo1) / 2
    k = math.cos(math.radians(lat_c))
    half_km = max((la1 - la0) * 111.32, (lo1 - lo0) * 111.32 * k) / 2 + 0.45
    crop = (lon_c - half_km / (111.32 * k), lat_c - half_km / 111.32, lon_c + half_km / (111.32 * k), lat_c + half_km / 111.32)
    log(f"crop ±{half_km:.2f} km around {lat_c:.4f},{lon_c:.4f}")
    lifts, runs = rm.lifts_runs(crop, elev.get("osm_id"))
    # The OpenSkiMap polygon is often smaller than the terrain (Powder Mountain: runs and lifts spill 10-15% past it).
    # Grow the crop to hold every run and lift fetched, and fetch again, so the frame, the fit view and the picture all
    # see the same outline (a frame cut from the polygon alone left the top lobe and the Base marker off the screen).
    for _pass in range(3):
        allpts = np.array(pts.tolist() + [p for f in (lifts + runs) for p in f[1]])
        a0, a1, o0, o1 = allpts[:, 0].min(), allpts[:, 0].max(), allpts[:, 1].min(), allpts[:, 1].max()
        need = max((a1 - a0) * 111.32, (o1 - o0) * 111.32 * k) / 2 + 0.45
        if need <= half_km * 1.01:
            break
        lat_c, lon_c = (a0 + a1) / 2, (o0 + o1) / 2
        k = math.cos(math.radians(lat_c))
        half_km = need
        crop = (lon_c - half_km / (111.32 * k), lat_c - half_km / 111.32, lon_c + half_km / (111.32 * k), lat_c + half_km / 111.32)
        log(f"crop grown to ±{half_km:.2f} km to hold every run and lift")
        lifts, runs = rm.lifts_runs(crop, elev.get("osm_id"))
    # only lifts that exist today: OpenSkiMap also carries disused / abandoned / proposed / planned ones
    lifts_dropped = []
    keep_l = []
    for l in lifts:
        st_ = l[0].get("status")
        if st_ in (None, "operating"):
            keep_l.append(l)
        else:
            lifts_dropped.append({"name": l[0].get("name"), "type": l[0].get("liftType"), "reason": f"status {st_}"})
    lifts = keep_l

    # --- frame: pass 1 on the old 1800 px crop grid (so the frame rule is exactly the settled one)
    lat0c = (crop[1] + crop[3]) / 2
    h_old = int(round(OLD_PX * (crop[3] - crop[1]) / ((crop[2] - crop[0]) * math.cos(math.radians(lat0c)))))
    g_old = Grid(crop, OLD_PX, h_old)
    m_old = (crop[3] - crop[1]) * 111320.0 / h_old
    runs, runs_dropped = prune_runs(runs, lifts, g_old, m_old)
    if runs_dropped:
        log(f"runs dropped, no operating lift within {LIFT_NEAR_M:.0f} m of their cluster: {len(runs_dropped)}: " + "; ".join(f"{d['name'] or '(unnamed)'} ({d['cluster_acres']} ac)" for d in runs_dropped[:12]))
    mask1, trimmed1 = trace_outline(runs, g_old, m_old)
    rr, cc = np.where(mask1)
    pad = PAD_M / m_old
    x0, x1, y0, y1 = cc.min() - pad, cc.max() + pad, rr.min() - pad, rr.max() + pad
    side_px_old = max(x1 - x0, y1 - y0)
    side_m = side_px_old * m_old
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    f_lon, f_lat = crop[0] + cx / OLD_PX * (crop[2] - crop[0]), crop[3] - cy / h_old * (crop[3] - crop[1])
    app_g = None
    if app:
        # Reference px -> metres: the outline (+150 m each side) must fit the band at the fit view.
        ow, oh = (x1 - x0) * m_old, (y1 - y0) * m_old
        ow_t, oh_t = ow - 2 * PAD_M, oh - 2 * PAD_M              # the outline itself: this is what fills the band
        mu = max(ow_t / (REF_W - 2 * SIDE_PX), oh_t / BAND_H)
        S_sheet = max(ow, oh)                      # the sheet's square frame: the settled rule
        side_m = REF_H * mu                        # the render is a square as tall as the full-screen picture
        f_lat -= (REF_H / 2 - BAND_CY) * mu / 111320.0   # outline centre sits at BAND_CY from the top
        app_g = {"mu": mu, "ow": ow, "oh": oh, "ow_t": ow_t, "oh_t": oh_t, "S_sheet": S_sheet}
        log(f"app layout: {mu:.2f} m per reference px; outline+pad {ow:.0f} x {oh:.0f} m; render {side_m / 1000:.2f} km square")
    kf = math.cos(math.radians(f_lat))

    def box_for(side):
        return (f_lon - side / 2 / (111320 * kf), f_lat - side / 2 / 111320, f_lon + side / 2 / (111320 * kf), f_lat + side / 2 / 111320)
    fbox = box_for(side_m)                     # the 4K frame (W, S, E, N)
    region_m = side_m + 2 * MARGIN_M
    rbox = box_for(region_m)                   # heightmap region
    m_px = side_m / px
    s = px * m_old / side_m                    # old px-size -> new px-size (labels/lines read the same at phone width)
    log(f"frame {side_m / 1000:.2f} km square, {m_px:.2f} m/px at {px} px; sizes x{s:.2f} vs the 1800 px maps")
    timing["setup_s"] = round(time.time() - t_start)

    # --- DEM on the native grid, region = frame + margin
    t0 = time.time()
    dem, dlon0, dlat1, dres, dem_info = load_dem_native(rbox, f_lat, f_lon, fine=hires)
    nr, nc = dem.shape
    lat_nat = dlat1 - (np.arange(nr) + 0.5) * dres
    lon_nat = dlon0 + (np.arange(nc) + 0.5) * dres
    if dem_info.get("fine"):
        # 1 m grid: too big for a bicubic spline. The heightmap is sampled straight from it (bilinear, 1.6 m cells);
        # snow and lifts only need elevation to ~6 m, so they use a block-averaged copy.
        from scipy.ndimage import map_coordinates
        hn = HIRES_HM
        hlat = rbox[3] - (np.arange(hn) + 0.5) * (rbox[3] - rbox[1]) / hn
        hlon = rbox[0] + (np.arange(hn) + 0.5) * (rbox[2] - rbox[0]) / hn
        rows = ((dlat1 - hlat) / dres - 0.5).astype("float32")
        cols = ((hlon - dlon0) / dres - 0.5).astype("float32")
        z = map_coordinates(dem, [np.broadcast_to(rows[:, None], (hn, hn)), np.broadcast_to(cols[None, :], (hn, hn))],
                            order=1, mode="nearest").astype("float64")
        k = 6
        r2, c2 = nr // k * k, nc // k * k
        coarse = dem[:r2, :c2].reshape(r2 // k, k, c2 // k, k).mean((1, 3))
        lat_c_ = lat_nat[:r2].reshape(-1, k).mean(1)
        lon_c_ = lon_nat[:c2].reshape(-1, k).mean(1)
        spl = RectBivariateSpline(lat_c_[::-1], lon_c_, coarse[::-1], kx=3, ky=3, s=0)
        del coarse
    else:
        spl = RectBivariateSpline(lat_nat[::-1], lon_nat, dem[::-1], kx=3, ky=3, s=0)
        # heightmap: 2 render px per sample, bicubic from the native grid
        hn = int(round(px / 2 * region_m / side_m))
        hlat = rbox[3] - (np.arange(hn) + 0.5) * (rbox[3] - rbox[1]) / hn
        hlon = rbox[0] + (np.arange(hn) + 0.5) * (rbox[2] - rbox[0]) / hn
        z = spl(hlat[::-1], hlon)[::-1].astype("float64")
    zmin, zmax = float(z.min()), float(z.max())
    h16 = np.round((z - zmin) / (zmax - zmin) * 65535).astype("uint16")
    hm_png = out / f"{rid}-heightmap16.png"
    Image.fromarray(h16).save(hm_png, optimize=False)
    dem_info.update(heightmap_px=hn, heightmap_spacing_m=round(region_m / hn, 2), heightmap_z_m=[round(zmin, 1), round(zmax, 1)],
                    heightmap_quantisation_m=round((zmax - zmin) / 65535, 3),
                    upsample_note=("bilinear from the 1 m lidar grid" if dem_info.get("fine") else "bicubic from the native grid; detail is limited by the native DEM, not the mesh"))
    timing["dem_s"] = round(time.time() - t0)

    # --- relief (Blender) at px x px
    t0 = time.time()
    meta = {"id": rid, "region_m": region_m, "frame_m": side_m, "px": px, "z_min": zmin, "z_max": zmax, "exag": EXAG,
            "light": LIGHTS, "exposure": EXPOSURE, "samples": int(os.environ.get("SAMPLES", "48")),
            "noise_scale": 2500.0 / OLD_PX * px * region_m / side_m,      # same grain size per pixel as the 1800 px maps
            "bump_distance": 0.0005 * m_px / m_old,
            "mesh_base": 256 if hires else 160, "render_levels": 4 if hires else 3, "viewport_levels": 1, "levels": LEVELS,
            "tiles": 2 if px >= 2048 else 1}
    bl = run_blender(hm_png, meta, out / rid)
    raw = stitch(out / rid, px)
    relief, st = level(raw)
    del raw
    log(f"  relief levels: clipped {st['clipped_pct']:.3f}% (raw {st['raw_clipped_pct']:.3f}%), darkest 1% at "
        f"{st['darkest1pct_value']:.0f}/255 = {st['darkest1pct_grey_pct']:.1f}% grey, median {st['median_value']:.0f}")
    if st["clipped_pct"] > 0.1 or not 50 <= st["darkest1pct_grey_pct"] <= 60:
        log(f"  WARNING: levels outside the settled range (0% clipped, darkest 1% ~55%): {st}")
    timing["relief_s"] = round(time.time() - t0)

    # --- snow
    t0 = time.time()
    sample, snow_info = build_snow(rid, crop, lat_c, lon_c, work)
    sn = px // 2
    s_lat = fbox[3] - (np.arange(sn) + 0.5) * (fbox[3] - fbox[1]) / sn
    s_lon = fbox[0] + (np.arange(sn) + 0.5) * (fbox[2] - fbox[0]) / sn
    dem_f = spl(s_lat[::-1], s_lon)[::-1]
    LA, LO = np.meshgrid(s_lat, s_lon, indexing="ij")
    snow = sample(LA, LO, dem_f)
    del LA, LO
    sig = max(1.0, 1.8 * m_old / (side_m / sn))             # old: gaussian 1.5 px then 1 px at ~m_old per px
    snow = gaussian_filter(snow, sig)
    timing["snow_s"] = round(time.time() - t0)
    log(f"snow field {snow.min():.1f}-{snow.max():.1f} in on the frame ({snow_info['source']} {snow_info['run']})")

    # --- outline at 4K (same rule, same metres), vectors, labels
    t0 = time.time()
    g4 = Grid(fbox, px, px)
    mask, trimmed = trace_outline(runs, g4, m_px)
    acres = float(mask.sum() * m_px * m_px / 4046.86)
    log(f"skiable-terrain outline: {acres:,.0f} acres from {len(runs)} runs (trimmed {trimmed:,.0f} acres)")
    # a lift is drawn only if both terminals are on drawn skiable terrain (within LIFT_TOL_M of the outline):
    # a lift ending on bare ground means its runs were trimmed away, so it is dropped (and listed), never drawn
    LIFT_TOL_M = 120
    near_mask = distance_transform_edt(~mask) <= LIFT_TOL_M / m_px
    keep_l = []
    for l in lifts:
        ok = True
        for la_, lo_ in (l[1][0], l[1][-1]):
            x, y = g4.P(la_, lo_)
            if not (0 <= x < px and 0 <= y < px):
                continue            # terminal outside the frame: the visible part still runs to the frame edge
            if not near_mask[int(y), int(x)]:
                ok = False
        if ok:
            keep_l.append(l)
        else:
            lifts_dropped.append({"name": l[0].get("name"), "type": l[0].get("liftType"), "reason": "terminal not on drawn skiable terrain"})
    del near_mask
    log(f"lifts: {len(keep_l)} drawn, {len(lifts_dropped)} dropped: " + "; ".join(f"{d['name']} ({d['reason']})" for d in lifts_dropped))
    lifts = keep_l
    if not lifts:
        sys.exit("no lift terminals on drawn terrain; refusing to draw base/top")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure()
    ax = fig.add_axes([0, 0, 1, 1])
    cs = ax.contour(gaussian_filter(mask.astype("float32"), 1.5), levels=[0.5])
    area_d = " ".join("M" + " L".join(f"{x + 0.5:.1f},{y + 0.5:.1f}" for x, y in seg[::2]) + " Z" for seg in cs.allsegs[0] if len(seg) > 16)
    plt.close(fig)
    msn = np.asarray(Image.fromarray(mask.astype("uint8") * 255).resize((sn, sn), Image.NEAREST)) > 0
    inside = snow[msn]
    if inside.size == 0 or inside.max() < 1.0:
        sys.exit(f"no snow (max {inside.max() if inside.size else 0:.1f} in) inside the outline: nothing to map; not drawing zeros")
    lo_in, hi_in = np.floor(inside.min()), np.ceil(inside.max())
    step = 1 if hi_in - lo_in <= 4 else 2 if hi_in - lo_in <= 16 else 3   # narrow range (a quiet run): every inch, so the map is never label-less
    while (hi_in - lo_in) / step > 14:
        step += 1
    levels = list(np.arange(math.floor(lo_in / step) * step + step, hi_in, step))
    sc_ = px / sn
    sig2 = 0.01
    lines, _ = contours(snow, levels, sig2, sc_)
    _, fill = contours(snow, [float(math.floor(lo_in))] + levels, sig2, sc_)

    def Pf(la, lo):
        return g4.P(la, lo)

    def path(seq):
        return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in (Pf(la, lo) for la, lo in seq))

    spl_ev = lambda la, lo: float(spl.ev(la, lo))  # noqa: E731
    terms = []
    for _, gg, _a in lifts:
        for la_, lo_ in (gg[0], gg[-1]):
            x, y = Pf(la_, lo_)
            if 0 <= x < px and 0 <= y < px and mask[int(y), int(x)]:
                terms.append((spl_ev(la_, lo_), x, y, float(snow[min(sn - 1, int(y / sc_)), min(sn - 1, int(x / sc_))])))
    terms.sort()
    marks = [("Base", terms[0]), ("Top", terms[-1])] if len(terms) >= 2 else []

    INK = sk.INK
    sw = lambda v: v * s  # noqa: E731
    head = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
            f'width="{px}" height="{px}" viewBox="0 0 {px} {px}" font-family="Inter, Helvetica, Arial, sans-serif">')
    defs = f'<defs><clipPath id="area"><path d="{area_d}" clip-rule="evenodd"/></clipPath></defs>'

    def layer(name, body):
        return [f'<g id="{name}" inkscape:groupmode="layer" inkscape:label="{name}">'] + body + ["</g>"]
    n = max(1, len(fill))
    fill_paths = [f'<path d="{d}" fill="{RAMP[min(len(RAMP) - 1, int(i * (len(RAMP) - 1) / max(1, n - 1)))]}" '
                  f'fill-rule="evenodd" clip-path="url(#area)"/>' for i, (lv_, d) in enumerate(fill) if d]
    fill_layer = layer("snow fill (multiply)", ['<g style="mix-blend-mode:multiply" opacity="0.85">'] + fill_paths + ["</g>"])
    over = []
    over += layer("snow lines", [f'<path d="{" ".join(ds)}" fill="none" stroke="#0d3fb0" stroke-opacity="0.75" stroke-width="{sw(1.6):.2f}" '
                                 f'stroke-linejoin="round" clip-path="url(#area)"/>' for lv_, ds in lines if ds])
    over += layer("runs", [f'<path d="{path(gg)}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="{sw(2.2):.2f}" '
                           f'stroke-linecap="round" clip-path="url(#area)"/>' for _, gg, _a in runs])
    lb = []
    for _, gg, _a in lifts:
        # lifts are not clipped to the outline: they run across the gaps between run areas (Brian 2026-11-19)
        lb.append(f'<path d="{path([gg[0], gg[-1]])}" fill="none" stroke="{INK}" stroke-width="{sw(1.6):.2f}"/>')
        for la_, lo_ in (gg[0], gg[-1]):
            x, y = Pf(la_, lo_)
            if 0 <= x < px and 0 <= y < px:
                lb.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sw(3.2):.2f}" fill="{INK}"/>')
    over += layer("lifts", lb)
    over += layer("skiable terrain outline (from runs)", [f'<path d="{area_d}" fill="none" stroke="{INK}" stroke-opacity="0.55" '
                                                         f'stroke-width="{sw(1.4):.2f}" stroke-dasharray="{sw(6):.1f} {sw(6):.1f}"/>'])
    over_nolab = list(over)
    lab = []
    depth_pts = []
    for lv_, (x, y) in inside_label_points(lines, mask, px):
        if True:
            depth_pts.append((float(lv_), float(x), float(y)))
            lab += halo(x, y, f'{lv_:g}"', f'font-size="{sw(26):.1f}" font-weight="600" fill="#0d3fb0" text-anchor="middle" dominant-baseline="middle"', sw(6))
    for word, (zz, x, y, sv) in marks:
        lab.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sw(11):.1f}" fill="#ffffff" stroke="{INK}" stroke-width="{sw(2):.1f}"/>')
        lab.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sw(4):.1f}" fill="{INK}"/>')
        txt = f'{word} {sv:.0f}"  ·  {zz * FT:,.0f} ft'
        tw = 0.62 * sw(30) * len(txt)           # rough text width; keep the whole label inside the frame
        left = x + sw(18) + tw > px - sw(12)
        lab += halo(x - sw(18) if left else x + sw(18), y, txt,
                    f'font-size="{sw(30):.1f}" font-weight="700" fill="{INK}" dominant-baseline="middle"'
                    + (' text-anchor="end"' if left else ""), sw(6))
    over += layer("labels", lab)
    timing["vectors_s"] = round(time.time() - t0)

    # busiest 1024 px of the map (most runs and lifts per area), for the 1:1 crop
    small = Image.new("L", (px // 4, px // 4), 0)
    sd = ImageDraw.Draw(small)
    for _, gg, _a in runs:
        xy = [(x / 4, y / 4) for x, y in (Pf(la, lo) for la, lo in gg)]
        if len(xy) > 1:
            sd.line(xy, fill=255, width=1)
    for _, gg, _a in lifts:
        sd.line([(x / 4, y / 4) for x, y in (Pf(*gg[0]), Pf(*gg[-1]))], fill=255, width=3)
    csz = min(1024, px)
    dens = uniform_filter(np.asarray(small, dtype="float32") / 255.0, size=max(1, csz // 4), mode="constant")
    iy, ix = np.unravel_index(int(np.argmax(dens)), dens.shape)
    bx = int(np.clip(ix * 4 - csz // 2, 0, px - csz))
    by = int(np.clip(iy * 4 - csz // 2, 0, px - csz))

    # --- compose: relief, multiply tint, vectors
    import cairosvg
    t0 = time.time()
    rbuf = io.BytesIO()
    Image.fromarray(relief).save(rbuf, "PNG", optimize=True)
    rpng = rbuf.getvalue()
    (out / f"{rid}-relief.png").write_bytes(rpng)
    b64 = base64.b64encode(rpng).decode()
    img_layer = layer("relief (raster)", [f'<image width="{px}" height="{px}" xlink:href="data:image/png;base64,{b64}"/>'])
    (out / f"{rid}.svg").write_text("\n".join([head, defs] + img_layer + fill_layer + over + ["</svg>"]))
    (out / f"{rid}-vectors.svg").write_text("\n".join([head, defs] + fill_layer + over + ["</svg>"]))
    del img_layer, b64
    fpng = cairosvg.svg2png(bytestring="\n".join([head, defs] + fill_layer + ["</svg>"]).encode(), output_width=px, output_height=px)
    F = np.asarray(Image.open(io.BytesIO(fpng)).convert("RGBA")).astype("float32") / 255.0
    kk = 0.85 * F[..., 3:4]
    comp = (relief.astype("float32") / 255.0 * (1 - kk + kk * F[..., :3]) * 255).clip(0, 255).astype("uint8")
    del F, kk
    vpng = cairosvg.svg2png(bytestring="\n".join([head, defs] + over + ["</svg>"]).encode(), output_width=px, output_height=px)
    final = Image.alpha_composite(Image.fromarray(comp).convert("RGBA"), Image.open(io.BytesIO(vpng)).convert("RGBA")).convert("RGB")
    app_info = None
    if app:
        vpng2 = cairosvg.svg2png(bytestring="\n".join([head, defs] + over_nolab + ["</svg>"]).encode(), output_width=px, output_height=px)
        clean = Image.alpha_composite(Image.fromarray(comp).convert("RGBA"), Image.open(io.BytesIO(vpng2)).convert("RGBA")).convert("RGB")
        del vpng2
        mu, ow, oh, S_sheet = app_g["mu"], app_g["ow_t"], app_g["oh_t"], app_g["S_sheet"]   # focus = the outline, no pad
        ox, oy = px / 2.0, BAND_CY / REF_H * px          # outline centre in the render
        Wc = int(round(min(px, max((REF_W + 2 * OVERSCAN) * mu, S_sheet) / m_px)))   # (S_sheet: the sheet crop is cut from the same render)
        left = int(round(ox - Wc / 2))
        full_im = clean.crop((left, 0, left + Wc, px))
        full_im.save(out / f"{rid}-full.webp", "WEBP", quality=80, method=6)
        Sp = S_sheet / m_px
        sx0, sy0 = ox - Sp / 2, oy - Sp / 2
        box = (int(round(sx0)), int(round(sy0)), int(round(sx0 + Sp)), int(round(sy0 + Sp)))
        for nm, src_im in (("sheet", clean), ("sheet-baked", final)):
            src_im.crop(box).resize((1080, 1080), Image.LANCZOS).save(out / f"{rid}-{nm}.webp", "WEBP", quality=82, method=6)
        fr = lambda x, y, x0_, y0_, w_, h_: (round((x - x0_) / w_, 4), round((y - y0_) / h_, 4))  # noqa: E731
        mk = lambda x0_, y0_, w_, h_: {  # noqa: E731
            "frame": "fractions of this picture, 0-1 from the top-left",
            "depth": [dict(zip(("x", "y"), fr(x, y, x0_, y0_, w_, h_)), **{"in": lv_}) for lv_, x, y in depth_pts
                      if x0_ <= x <= x0_ + w_ and y0_ <= y <= y0_ + h_],
            "marks": [dict(zip(("x", "y"), fr(x, y, x0_, y0_, w_, h_)), kind=w.lower(), **{"in": round(float(sv), 1)}, ft=round(float(zz) * FT))
                      for w, (zz, x, y, sv) in marks]}
        fx0, fx1 = (ox - ow / 2 / m_px - left) / Wc, (ox + ow / 2 / m_px - left) / Wc
        fy0, fy1 = (oy - oh / 2 / m_px) / px, (oy + oh / 2 / m_px) / px
        app_info = {
            "ref_viewport": [REF_W, REF_H], "band": {"side": SIDE_PX, "top": BAND_TOP, "bottom": BAND_BOT},
            "m_per_ref_px": round(mu, 3),
            "full": {"img": f"{rid}-full.webp", "px": [Wc, px], "ref": [round(Wc * REF_H / px, 2), REF_H],
                     "focus": {"x0": round(fx0, 4), "y0": round(fy0, 4), "x1": round(fx1, 4), "y1": round(fy1, 4)},
                     "labels": mk(left, 0, Wc, px)},
            "sheet": {"img_clean": f"{rid}-sheet.webp", "img": f"{rid}-sheet-baked.webp", "side_m": round(S_sheet),
                      "labels": mk(box[0], box[1], box[2] - box[0], box[3] - box[1])},
        }
        for nm, f_ in (("full", out / f"{rid}-full.webp"), ("sheet", out / f"{rid}-sheet.webp")):
            log(f"  app {nm}: {f_.stat().st_size / 1e6:.2f} MB")
        del clean
    final.save(out / f"{rid}.png", optimize=True)
    final.resize((1024, 1024), Image.LANCZOS).save(out / "preview" / f"{rid}-1024.png")
    final.crop((bx, by, bx + csz, by + csz)).save(out / "preview" / f"{rid}-crop1to1.png")
    Image.fromarray(relief[by:by + csz, bx:bx + csz]).save(out / "preview" / f"{rid}-relief-crop1to1.png")   # same box, plain plaster: shows the DEM-limited detail
    timing["compose_s"] = round(time.time() - t0)

    info = {
        "resort": rid, "ski_area": area_name, "date_utc": time.strftime("%Y-%m-%d", time.gmtime()),
        "frame_km": round(side_m / 1000, 3), "px": px, "m_per_px": round(m_px, 3),
        "frame_bbox_lonlat": [round(v, 6) for v in fbox], "crop": crop,
        "dem": dem_info, "snow": snow_info, "caption_source": snow_info["caption"],
        "relief": {**st, "lights": "even", "exposure": EXPOSURE, "exaggeration": EXAG, "levels": LEVELS, "samples": meta["samples"],
                   "mesh_vertex_spacing_m": round(region_m / (meta["mesh_base"] * 2 ** meta["render_levels"]), 2)},
        "blender": bl,
        "svg_scale_vs_1800px_maps": round(s, 3),
        "inside_range_in": [round(float(inside.min()), 1), round(float(inside.max()), 1)],
        "levels_in": [float(x) for x in levels],
        "base": [round(marks[0][1][0], 1), round(marks[0][1][3], 1)] if marks else None,
        "top": [round(marks[1][1][0], 1), round(marks[1][1][3], 1)] if marks else None,
        "lifts": len(lifts), "lifts_dropped": lifts_dropped, "runs_dropped": runs_dropped, "runs": len(runs), "outline": "skiable terrain from runs", "outline_acres": round(acres),
        "app": app_info,
        "busiest_crop_xy": [bx, by, csz], "timing_s": {**timing, "total_s": round(time.time() - t_start)},
        "files": sorted(p.name for p in out.iterdir() if p.is_file()),
    }
    (out / f"{rid}.json").write_text(json.dumps(info, indent=1, default=float))
    log(f"{rid}: done in {time.time() - t_start:.0f}s; inside {inside.min():.1f}-{inside.max():.1f} in; "
        f"blend {bl.get('blend_mb')} MB; render {bl.get('render_s')} s")
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("resort")
    ap.add_argument("--px", type=int, default=4096)
    ap.add_argument("--hires", action="store_true", help="US only: 1 m lidar DEM, 4096^2 mesh (use with --px 5120)")
    ap.add_argument("--app", action="store_true", help="app layout: one render for the resort sheet (square) and the full-screen map (portrait, pan/zoom)")
    a = ap.parse_args()
    try:
        run(a.out, a.resort, a.px, app=a.app, hires=a.hires)
    except BaseException as e:  # noqa: BLE001  (written to FAILED.txt, then re-raised: the job goes red)
        Path(a.out).mkdir(parents=True, exist_ok=True)
        msg = str(e.code) if isinstance(e, SystemExit) else f"{type(e).__name__}: {e}"
        (Path(a.out) / "FAILED.txt").write_text(f"{a.resort}: {msg}\n\n{traceback.format_exc()}")
        print(f"FAILED {a.resort}: {msg}", file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    main()
