#!/usr/bin/env python3
"""Per-day grids: python3 scripts/maps/test_live_grid.py [--fixture]
--fixture also rewrites test/fixtures/terrain-live/ (the app's JS is tested against these exact bytes and values)."""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import live_grid as LG  # noqa: E402

rng = np.random.default_rng(7)
W, Hpx = 120, 200                                   # a tiny "picture"
gw, gh = LG.fine_dims(W, Hpx)
cw, ch = LG.coarse_dims(W, Hpx)
assert (gw, gh, cw, ch) == (30, 50, 4, 7), (gw, gh, cw, ch)
yy, xx = np.mgrid[0:gh, 0:gw]
H = 6.5 + 0.04 * yy + 0.6 * np.sin(xx / 4.0) + rng.normal(0, 0.05, (gh, gw))   # kft, ridged
mask = ((xx - 15) ** 2 / 100 + (yy - 25) ** 2 / 300) < 1
cy, cx = np.mgrid[0:ch, 0:cw]
A = [-4 + 0.3 * cx + 0.2 * cy + d for d in (0.0, 1.5, 3.0)]    # inches (height term taken out)
G = [np.clip(0.8 + 0.1 * cx - 0.05 * cy + 0.3 * d, 0, None) for d in (0, 1, 2)]   # in / 1000 ft
dates = ["2026-11-22", "2026-11-23", "2026-11-24"]

# 1. pack -> unpack: H within half a 16-bit step (v2), the day parts within half a 16-bit step, the outline exact
gp, dp, q = LG.pack(H, mask, A, G)
live = {**q, "dates": dates}
H2, m2, A2, G2 = LG.unpack(gp, dp, live, 3)
assert np.abs(H2 - H).max() <= (H.max() - H.min()) / 65535 / 2 + 1e-6  # hq is stored to 6 decimals
# a v1 file (8-bit height in R, B empty) still reads as 8 bits
import io as _io
from PIL import Image as _I
_g = np.asarray(_I.open(_io.BytesIO(gp)).convert("RGB")).copy(); _g[..., 2] = 0
_b = _io.BytesIO(); _I.fromarray(_g, "RGB").save(_b, "PNG")
H1, _, _, _ = LG.unpack(_b.getvalue(), dp, {**live, "v": 1}, 3)
assert np.abs(H1 - H).max() <= (H.max() - H.min()) / 255 + 1e-9
assert (m2 == mask).all()
for a, a2, g, g2 in zip(A, A2, G, G2):
    assert np.abs(a2 - a).max() <= (a.max() - a.min()) / 65535 / 2 + 1e-12
    assert np.abs(g2 - g).max() <= (g.max() - g.min()) / 65535 / 2 + 1e-12

# 2. bilinear up is exact on a linear field, and clamps at the edges
lin = 2.0 + 0.5 * cx + 0.25 * cy
up = LG.bilinear_up(lin.astype(float), gw, gh)
u = np.clip(LG.centres(gw, LG.CELL) / LG.CCELL - 0.5, 0, cw - 1)
v = np.clip(LG.centres(gh, LG.CELL) / LG.CCELL - 0.5, 0, ch - 1)
assert np.allclose(up, 2.0 + 0.5 * u[None, :] + 0.25 * v[:, None])

# 3. the field: a window is the sum of its days; k scales the amount and not the pattern; never below 0
f1 = LG.field(H2, A2, G2, [0], 0.8, 1.0)
f12 = LG.field(H2, A2, G2, [0, 1], 0.8, 1.0)
assert (f1 >= 0).all() and (f12 >= f1 - 1e-9).all()
assert np.allclose(LG.field(H2, A2, G2, [0, 1], 0.8, 2.5), 2.5 * f12)

# 3b. height-profile field: S(H) from the profile, rho from NBM vs its own line; rho = 1 where the line is ~0
PROF_Z = [round(6.0 + 0.1 * i, 1) for i in range(31)]          # 6.0 .. 9.0 kft, includes 8.0 (the ref height)
PROF = {"z_kft": PROF_Z, "cm": {d: [round(max(0.0, c * (1 + 0.4 * (z - 8.0))), 3) for z in PROF_Z]
                                for d, c in zip(dates, (5.0, 12.0, 8.0))}}
REF = {"z_kft": 8.0, "a": [-3.0, -1.5, 0.0], "g": [0.8, 1.1, 1.4]}
fp = LG.field_prof(H2, A2, G2, [1, 2], 0.8, REF, PROF, dates, 0.5, 1.5)
assert (fp >= 0).all()
S = np.interp(H2, PROF_Z, np.sum([PROF["cm"][d] for d in dates[1:]], axis=0) / 2.54)
assert (fp <= 1.5 * S + 1e-9).all()
same = LG.field_prof(np.full_like(H2, 8.0), [REF["a"][i] + 0 * A2[i] for i in range(3)], [REF["g"][i] + 0 * G2[i] for i in range(3)],
                     [1, 2], 0.8, REF, PROF, dates, 0.5, 1.5)
assert np.allclose(same, S[0, 0] * 0 + np.interp(8.0, PROF_Z, np.sum([PROF["cm"][d] for d in dates[1:]], axis=0) / 2.54)), \
    "NBM equal to its own line everywhere: exactly the blend's amount (the sheet total at the blend's height)"

# 4. missing values refuse loudly (missing is not zero)
try:
    LG.pack(H, mask, [A[0] * np.nan], [G[0]])
    raise AssertionError("NaN accepted")
except SystemExit:
    pass

if "--fixture" in sys.argv:
    out = HERE.parents[1] / "test/fixtures/terrain-live"
    out.mkdir(parents=True, exist_ok=True)
    (out / "grid.png").write_bytes(gp)
    (out / "days.png").write_bytes(dp)
    meta = {"v": LG.VERSION, "w": W, "h": Hpx, "cell": LG.CELL, "gw": gw, "gh": gh, "ccell": LG.CCELL, "cw": cw, "ch": ch, **q,
            "dates": dates, "ref": {"z_kft": 8.0, "a": [-3.0, -1.5, 0.0], "g": [0.8, 1.1, 1.4]}, "sigma": 0.8,
            "stroke": 1.0, "floor_in": 0.1, "marks": [{"kind": "base", "x": 60, "y": 150, "ft": 6400}, {"kind": "top", "x": 60, "y": 40, "ft": 10400}],
            "sheet": [10, 40, 100], "deep": [60.0, 100.0]}
    # the app's window for days 1-2 with a sheet total of 20 cm: k = (20 / 2.54) / max(0, sum a + sum g * z)
    idx = [1, 2]
    ref = max(0, sum(meta["ref"]["a"][i] for i in idx) + sum(meta["ref"]["g"][i] for i in idx) * meta["ref"]["z_kft"])
    total = 47.0                                  # k ~ 1: inside the old-map gate (0.67..1.5)
    k = total / 2.54 / ref
    twin = LG.field(H2, A2, G2, idx, meta["sigma"], k)
    (out / "live.json").write_text(json.dumps(meta, indent=1))
    (out / "expected.json").write_text(json.dumps({"dates": [dates[i] for i in idx], "totalCm": total, "k": k,
                                                  "F": [round(float(x), 9) for x in twin.ravel()]}))
    tp = LG.field_prof(H2, A2, G2, idx, meta["sigma"], meta["ref"], PROF, dates, 0.5, 1.5)
    (out / "prof.json").write_text(json.dumps(PROF))
    (out / "expected-prof.json").write_text(json.dumps({"dates": [dates[i] for i in idx], "totalCm": 20.0,
                                                       "F": [round(float(x), 9) for x in tp.ravel()]}))
    print(f"fixture written: grid {len(gp)} B, days {len(dp)} B, k {k:.4f}")
print("live grid tests passed")
