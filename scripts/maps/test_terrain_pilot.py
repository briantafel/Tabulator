#!/usr/bin/env python3
"""Synthetic end-to-end test for terrain_pilot.py: made-up terrain, snow, OSM files; real Blender (bpy).
Checks the plumbing (frame, heightmap, displacement check, levels, SVG/PNG sizes, .blend packing, previews).
It does not test real data sources. Needs `pip install bpy` (or a Blender binary on BLENDER).
    python3 scripts/maps/test_terrain_pilot.py [workdir]
"""
import json, math, os, stat, sys, tempfile
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import terrain_pilot as tp  # noqa: E402

# NBM 'empty' is judged on the box, not the resort (Panorama 2026-11-23: dry at the resort in NBM, snowy crest nearby)
assert not tp.nbm_looks_empty(2.5, 4.3)   # real forecast, rain shadow
assert tp.nbm_looks_empty(0.0, 4.3)       # fill: nothing anywhere while IFS has snow
assert not tp.nbm_looks_empty(0.0, 1.0)   # IFS light: no basis to call NBM empty

work = Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="pilot-test-"))
work.mkdir(parents=True, exist_ok=True)
RID = "alta"
elev = json.loads((tp.ROOT / "src/data/resort-elevations.json").read_text())["resorts"][RID]
LAT, LON = 40.58, -111.63

# --- fake OpenSkiMap exports (ski area, lifts, runs) around Alta
osm = work / "osm"
osm.mkdir(exist_ok=True)
sid = elev["osm_id"]
d = 0.012
poly = [[LON - d, LAT - d], [LON + d, LAT - d], [LON + d, LAT + d], [LON - d, LAT + d], [LON - d, LAT - d]]
(osm / "ski_areas.geojson").write_text(json.dumps({"features": [{"properties": {"id": sid, "name": "Test"}, "geometry": {"type": "Polygon", "coordinates": [poly]}}]}))
rng = np.random.default_rng(4)
runs, lifts = [], []
for i in range(60):
    x0, y0 = LON + rng.uniform(-d, d) * 0.8, LAT + rng.uniform(-d, d) * 0.8
    pts = [[x0 + j * rng.uniform(-3e-4, 3e-4), y0 - j * 2.5e-4] for j in range(12)]
    runs.append({"properties": {"uses": ["downhill"], "skiAreas": [{"properties": {"id": sid}}]}, "geometry": {"type": "LineString", "coordinates": pts}})
for i in range(5):
    x0, y0 = LON - d * 0.6 + i * d * 0.3, LAT - d * 0.7
    lifts.append({"properties": {"skiAreas": [{"properties": {"id": sid}}]}, "geometry": {"type": "LineString", "coordinates": [[x0, y0], [x0 + 2e-3, y0 + 1.6e-2]]}})
(osm / "runs.geojson").write_text(json.dumps({"features": runs}))
(osm / "lifts.geojson").write_text(json.dumps({"features": lifts}))
os.environ["OSM_DIR"] = str(osm)

# --- fake Blender: run the script with python (bpy module)
fb = work / "fake-blender"
fb.write_text(f'#!/bin/sh\n# -b -P script -- args\nshift 3\nshift\nexec {sys.executable} "$0.script" "$@"\n')
fb.chmod(fb.stat().st_mode | stat.S_IEXEC)
(work / "fake-blender.script").write_text(f'import runpy, sys\nsys.argv=["x"]+sys.argv[1:]\nrunpy.run_path(r"{HERE / "relief_heightmap.py"}", run_name="__main__")\n')
# the script path is $3 of the original argv; our wrapper ignores it and always runs relief_heightmap.py
os.environ["BLENDER"] = str(fb)
os.environ["SAMPLES"] = "4"


def fake_terrain(la, lo):
    x = (lo - LON) * 111320 * math.cos(math.radians(LAT))
    y = (la - LAT) * 111320
    return 3000 + 0.25 * y + 400 * np.sin(x / 700) * np.cos(y / 900) + 150 * np.sin(x / 150 + y / 210)


def fake_dem(bbox, lat_c, lon_c, fine=False):
    res = 1 / 10800
    W, S, E, N = bbox
    cols, rows = int(round((E - W) / res)), int(round((N - S) / res))
    la = N - (np.arange(rows) + 0.5) * res
    lo = W + (np.arange(cols) + 0.5) * res
    z = fake_terrain(la[:, None], lo[None, :]).astype("float32")
    info = {"source": "synthetic", "native_res_deg": res, "native_res_m": [10.3, 7.9], "native_shape": list(z.shape)}
    if os.environ.get("TEST_FINE"):
        info["fine"] = True          # exercises the 1 m branch (heightmap by map_coordinates, block-averaged spline)
    return z, W, N, res, info


def fake_snow(rid, crop, lat_c, lon_c, work_):
    def sample(LA, LO, dem_m):
        return np.clip(8 + 0.012 * (dem_m - 2800) + 2 * np.sin(LO * 4000), 0, None)
    return sample, {"nbm_checked": True, "source": "NBM", "caption": tp.CAPTION["nbm"], "run": "2026-11-19T12:00:00+00:00", "grid": "synthetic", "slr": "n/a", "nbm_check": "synthetic"}


tp.load_dem_native = fake_dem
tp.HIRES_HM = 512
tp.build_snow = fake_snow
info = tp.run(work / "out", RID, px=int(os.environ.get("TEST_PX", "512")), app=bool(os.environ.get("TEST_APP")))
out = work / "out"
from PIL import Image  # noqa: E402
px = info["px"]
for name in (f"{RID}.png", f"{RID}-relief.png"):
    assert Image.open(out / name).size == (px, px), name
assert (out / f"{RID}.blend").stat().st_size > 1e5
svg = (out / f"{RID}-vectors.svg").read_text()
assert f'viewBox="0 0 {px} {px}"' in svg and "<image" not in svg
assert "<image" in (out / f"{RID}.svg").read_text()
assert info["relief"]["clipped_pct"] <= 0.1, info["relief"]
assert 45 <= info["relief"]["darkest1pct_grey_pct"] <= 65, info["relief"]
assert (out / "preview" / f"{RID}-1024.png").exists() and (out / "preview" / f"{RID}-crop1to1.png").exists()
if os.environ.get("TEST_APP"):
    a = info["app"]
    assert a and (out / f"{RID}-full.webp").exists() and (out / f"{RID}-sheet.webp").exists() and (out / f"{RID}-sheet-baked.webp").exists()
    fw, fh = Image.open(out / f"{RID}-full.webp").size
    assert (fw, fh) == tuple(a["full"]["px"]) and Image.open(out / f"{RID}-sheet.webp").size == (1080, 1080)
    # portrait picture; its reference size is the 874-tall phone
    assert fh > fw and a["full"]["ref"][1] == 874
    f = a["full"]["focus"]
    # the outline's focus rect sits inside the picture and in the band: centred horizontally, between the header and legend
    assert 0 <= f["x0"] < f["x1"] <= 1 and 0 <= f["y0"] < f["y1"] <= 1, f
    assert abs((f["x0"] + f["x1"]) / 2 - 0.5) < 0.02
    ys0, ys1 = f["y0"] * 874, f["y1"] * 874
    assert ys0 >= 60 and ys1 <= 874 - 110, (ys0, ys1)
    for im_ in (a["full"]["labels"], a["sheet"]["labels"]):
        for m in im_["marks"]:
            assert 0 <= m["x"] <= 1 and 0 <= m["y"] <= 1, m
    print("app layout OK", a["full"]["px"], a["full"]["ref"], f)
print("OK", work)

