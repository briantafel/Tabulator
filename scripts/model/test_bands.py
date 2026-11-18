#!/usr/bin/env python3
"""Tests for bands.py with synthetic data (no archive)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bands as b  # noqa: E402


def synth(n=20000, seed=1):
    rng = np.random.default_rng(seed)
    lead = rng.integers(1, 8, n)
    f = rng.gamma(0.6, 6.0, n)
    # truth: multiplicative noise that widens with lead, plus dry misses
    sigma = 0.4 + 0.12 * lead
    obs = f * rng.lognormal(-sigma**2 / 2, sigma)
    obs[rng.random(n) < 0.15] = 0.0
    return lead, f, obs, np.array([f"2025-01-{1 + i % 28:02d}" for i in range(n)])


def test_bins_and_groups():
    assert b.bin_of(0.0) == 0 and b.bin_of(0.49) == 0 and b.bin_of(2.5) == 2 and b.bin_of(40) == 5
    assert b.group_of(0) == "1-2" and b.group_of(4) == "3-4" and b.group_of(7) == "5-7"


def test_band_always_contains_forecast_and_is_ordered():
    lead, f, obs, _ = synth()
    t = b.fit_bands(lead, f, obs)
    for L, x in [(1, 0.2), (1, 3.0), (3, 8.0), (6, 30.0), (0, 15.0)]:
        q = b.band_for(t, L, x)
        assert q["p10"] <= q["p25"] <= x <= q["p75"] <= q["p90"], (L, x, q)


def test_calibrated_on_fresh_data_from_the_same_process():
    lead, f, obs, d = synth(seed=1)
    t = b.fit_bands(lead, f, obs)
    lead2, f2, obs2, d2 = synth(seed=2)
    rows = {r["group"]: r for r in b.judge(t, lead2, f2, obs2, d2)}
    for g in b.GROUPS:
        assert abs(rows[g]["possible"] - 0.80) < 0.06, rows[g]
        assert abs(rows[g]["likely"] - 0.50) < 0.08, rows[g]


def test_wider_far_out():
    lead, f, obs, _ = synth()
    t = b.fit_bands(lead, f, obs)
    near, far = b.band_for(t, 1, 10.0), b.band_for(t, 6, 10.0)
    assert far["p90"] - far["p10"] > near["p90"] - near["p10"]


def test_promote_rule():
    ok = [{"group": g, "likely": 0.52, "possible": 0.78} for g in b.GROUPS]
    assert b.promoted(ok)
    assert not b.promoted(ok[:2] + [{"group": "5-7", "likely": 0.35, "possible": 0.78}])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
