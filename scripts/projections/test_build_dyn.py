#!/usr/bin/env python3
"""Tests for build_dyn.py with synthetic blocks (no network)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dyn as b  # noqa: E402

SLR = {"a": 9.0, "b": -0.6, "clamp": [5.0, 25.0]}
RES = [{"id": "alta", "tz": "America/Denver"}]


def blocks_for(day_utc: str, precip, tmin, tmax, extra=None, n_mem=3):
    out = []
    for h in (0, 6, 12, 18):
        vs = f"{day_utc}T{h:02d}:00:00Z"
        hh = h + 6
        ve = f"{day_utc}T{hh:02d}:00:00Z" if hh < 24 else vs  # end value unused by the builder
        def arr(x):
            return np.full((n_mem, 1), x, dtype=float)
        out += [("precip", "mm", vs, ve + "x", arr(precip)), ("temp_min", "C", vs, ve + "x", arr(tmin)),
                ("temp_max", "C", vs, ve + "x", arr(tmax)), ("wind_speed_max", "km/h", vs, ve + "x", arr(20))]
        if extra is not None:
            out.append(("frozen_pct_mean", "%", vs, ve + "x", arr(extra)))
    return out


def test_frozen_fraction_and_slr():
    t = np.array([-5.0, 0.0, 3.0])
    assert np.allclose(b.frozen_fraction(t, None), [1.0, 0.5, 0.0])
    assert np.allclose(b.frozen_fraction(t, np.array([np.nan, 100.0, 20.0])), [1.0, 1.0, 0.2])
    assert np.allclose(b.slr_of(np.array([0.0, -10.0, -40.0, 20.0]), SLR), [9.0, 15.0, 25.0, 5.0])


def test_lapse_rate_turns_valley_rain_into_mountain_snow():
    # Cell at 1500 m and +2 C: all rain there. Resort mid at 3000 m: 2 − 9.75 = −7.75 C → all snow.
    blocks = blocks_for("2026-11-20", 2.0, 2.0, 2.0) + blocks_for("2026-11-21", 2.0, 2.0, 2.0)
    up = b.daily_from_blocks(blocks, RES, np.array([1500.0]), {"alta": 3000}, SLR)["alta"]["2026-11-20"]
    flat = b.daily_from_blocks(blocks, RES, np.array([1500.0]), {"alta": 1500}, SLR)["alta"]["2026-11-20"]
    assert np.allclose(flat["snow"], 0.0)
    assert np.allclose(up["snow"], 8.0 * (9.0 + 0.6 * 7.75) / 10.0)
    assert np.allclose(up["tmax"], -7.75)


def test_complete_local_day_sums_four_blocks():
    blocks = blocks_for("2026-11-20", 2.0, -8.0, -6.0) + blocks_for("2026-11-21", 2.0, -8.0, -6.0)
    days = b.daily_from_blocks(blocks, RES, np.array([3000.0]), {"alta": 3000}, SLR)["alta"]
    d = days["2026-11-20"]  # local Nov 20 = blocks starting Nov 20 06Z..Nov 21 00Z
    assert d["n"] == 4
    assert np.allclose(d["liquid"], 8.0)
    assert np.allclose(d["snow"], 8.0 * (9.0 + 0.6 * 7.0) / 10.0)  # T = −7 → SLR 13.2 → 10.56 cm
    assert "2026-11-21" not in days  # its last block (Nov 22 00Z) is missing: not written


def test_gefs_frozen_pct_overrides_temperature():
    blocks = blocks_for("2026-11-20", 2.0, 0.5, 0.5, extra=0.0) + blocks_for("2026-11-21", 2.0, 0.5, 0.5, extra=0.0)
    d = b.daily_from_blocks(blocks, RES, np.array([3000.0]), {"alta": 3000}, SLR)["alta"]["2026-11-20"]
    assert np.allclose(d["snow"], 0.0)


def test_pooled_quantiles_weight_models_equally():
    q = b.pooled_quantiles([np.zeros(51), np.full(31, 10.0)])
    assert q["p25"] < 1 and q["p75"] > 9  # 51 members do not outvote 31


def test_summarize_shape_matches_projections_json():
    blocks = []
    for day in ("2026-11-24", "2026-11-25", "2026-11-26"):
        blocks += blocks_for(day, 1.0, -9.0, -7.0)
    daily = {"gefs": b.daily_from_blocks(blocks, RES, np.array([3000.0]), {"alta": 3000}, SLR)}
    sf = ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"]
    s = b.summarize(daily, "alta", sf)
    assert [d["date"] for d in s["days"]] == ["2026-11-25"]
    assert set(s["days"][0]["snow"]) == {"p10", "p25", "p50", "p75", "p90"}
    assert "2026-11-24" in s["spread"]
    assert len(s["members"]["gefs"]) == 3 and len(s["members"]["gefs"][0]) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
