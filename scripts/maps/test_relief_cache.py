#!/usr/bin/env python3
"""Relief cache rules (no Blender needed):  python3 scripts/maps/test_relief_cache.py
A cached relief is reused only for the identical heightmap + recipe; anything else renders fresh."""
import json, sys, tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import terrain_pilot as tp  # noqa: E402

PX = 64
rng = np.random.default_rng(1)
h16 = rng.integers(0, 65535, (40, 40), dtype=np.uint16)
meta = {"id": "x", "region_m": 5000.0, "frame_m": 4400.0, "px": PX, "z_min": 100.0, "z_max": 900.0, "exag": tp.EXAG,
        "light": tp.LIGHTS, "exposure": tp.EXPOSURE, "samples": 48, "mesh_base": 160, "render_levels": 3, "levels": tp.LEVELS}
relief = rng.integers(0, 255, (PX, PX, 3), dtype=np.uint8)
st = {"clipped_pct": 0.0, "darkest1pct_grey_pct": 55.0, "darkest1pct_value": 140.0, "median_value": 200.0, "raw_clipped_pct": 0.0, "raw_p_lo": 1.0, "raw_p_hi": 2.0}
bl = {"blend_mb": 20.0, "render_s": 100.0, "blender_wall_s": 120}

def png_bytes(a):
    import io
    b = io.BytesIO(); Image.fromarray(a).save(b, "PNG"); return b.getvalue()

with tempfile.TemporaryDirectory() as t:
    tp.RELIEF_CACHE, tp.RELIEF_SEED = t + "/cache", None
    fp = tp.relief_fp(h16, meta)
    assert tp.relief_from_cache("x", fp, h16, PX, meta) is None, "empty cache must miss"
    tp.relief_to_cache("x", fp, png_bytes(relief), st, bl)
    got = tp.relief_from_cache("x", fp, h16, PX, meta)
    assert got and np.array_equal(got[0], relief) and got[1] == st and got[2]["reused"] == "cache", "same terrain+recipe must hit, pixel-identical"
    # any change to the terrain or the recipe changes the fingerprint
    h2 = h16.copy(); h2[0, 0] ^= 1
    assert tp.relief_fp(h2, meta) != fp, "one heightmap pixel must change the fingerprint"
    for k, v in (("exposure", -0.5), ("samples", 64), ("frame_m", 4401.0), ("px", 128), ("exag", 3.0)):
        assert tp.relief_fp(h16, {**meta, k: v}) != fp, f"{k} must change the fingerprint"
    assert tp.relief_from_cache("x", tp.relief_fp(h2, meta), h2, PX, meta) is None, "a changed heightmap must not reuse the cache"
    # wrong-size cached image is refused, not stretched
    tp.relief_to_cache("y", fp, png_bytes(relief[:32, :32]), st, bl)
    assert tp.relief_from_cache("y", fp, h16, PX, meta) is None

    # seeding from an earlier pilot run
    seed = Path(t) / "seed"; seed.mkdir()
    tp.RELIEF_CACHE, tp.RELIEF_SEED = None, str(seed)
    Image.fromarray(h16).save(seed / "z-heightmap16.png")
    (seed / "z-relief.png").write_bytes(png_bytes(relief))
    spacing = round(meta["region_m"] / (meta["mesh_base"] * 2 ** meta["render_levels"]), 2)
    j = {"px": PX, "relief": {**st, "exaggeration": tp.EXAG, "exposure": tp.EXPOSURE, "levels": tp.LEVELS, "samples": 48, "mesh_vertex_spacing_m": spacing}, "blender": bl}
    (seed / "z.json").write_text(json.dumps(j))
    got = tp.relief_from_cache("z", fp, h16, PX, meta)
    assert got and got[2]["reused"] == "pilot-seed" and np.array_equal(got[0], relief), "identical heightmap + recipe must seed"
    assert tp.relief_from_cache("z", fp, h2, PX, meta) is None, "a different heightmap must not seed"
    for bad in ({"px": 128}, {"relief": {**j["relief"], "exposure": -0.5}}, {"relief": {**j["relief"], "samples": 16}},
                {"relief": {**j["relief"], "mesh_vertex_spacing_m": spacing + 1}}):
        (seed / "z.json").write_text(json.dumps({**j, **bad}))
        assert tp.relief_from_cache("z", fp, h16, PX, meta) is None, f"a seed with {list(bad)} must be refused"
print("relief cache tests passed")
