"""Tests for extra_models.py (no network): python3 -m pytest scripts/archive/test_extra_models.py"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import extra_models as em  # noqa: E402
from upper_air import parse_noaa_idx  # noqa: E402

C = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)


def test_blocks_difference_run_totals_and_use_hourly_extremes():
    acc = {6: {"precip": np.array([4.0, 0.0])}, 12: {"precip": np.array([10.0, -0.2])}}
    inst = {h: {"t": np.array([-5.0 + h, 1.0]), "wind": np.array([10.0 * h, 0.0])} for h in range(1, 13)}
    b = {(s.hour, v): a for s, e, v, u, a in em.build_blocks(C, acc, inst, 12)}
    assert list(b[(12, "precip")]) == [4.0, 0.0]          # 12–18 UTC block = first 6 h
    assert list(b[(18, "precip")]) == [6.0, 0.0]          # 10 − 4; −0.2 packing noise → 0
    assert list(b[(12, "temp_min")]) == [-4.0, 1.0] and list(b[(12, "temp_max")]) == [1.0, 1.0]
    assert list(b[(18, "wind_speed_max")]) == [120.0, 0.0]


def test_negative_block_fails_loudly():
    acc = {6: {"precip": np.array([9.0])}, 12: {"precip": np.array([3.0])}}  # not a run total
    with pytest.raises(RuntimeError, match="not a run-total"):
        em.build_blocks(C, acc, {}, 12)


def test_missing_accumulation_drops_the_block_never_zero():
    acc = {12: {"precip": np.array([5.0])}}  # lead 6 missing
    blocks = em.build_blocks(C, acc, {}, 12)
    assert blocks == []


def test_temps_need_five_of_six_hours():
    acc = {6: {"precip": np.array([1.0])}}
    inst = {h: {"t": np.array([0.0])} for h in (1, 2, 3, 4)}
    assert {v for _, _, v, _, _ in em.build_blocks(C, acc, inst, 6)} == {"precip"}


HRRR_IDX = """1:0:d=2026111812:REFC:entire atmosphere:6 hour fcst:
2:100:d=2026111812:TMP:2 m above ground:6 hour fcst:
3:200:d=2026111812:UGRD:10 m above ground:6 hour fcst:
4:300:d=2026111812:VGRD:10 m above ground:6 hour fcst:
5:400:d=2026111812:APCP:surface:0-6 hour acc fcst:
6:500:d=2026111812:APCP:surface:5-6 hour acc fcst:
7:600:d=2026111812:ASNOW:surface:0-6 hour acc fcst:
8:700:d=2026111812:TMP:surface:6 hour fcst:
"""


def test_hrrr_picks_run_total_not_hourly_accumulation():
    p = em.hrrr_picks(parse_noaa_idx(HRRR_IDX), 6)
    assert [(e["start"], v) for e, v, _, _ in p] == [(100, "t"), (200, "u"), (300, "v"), (400, "precip"), (600, "snow")]
    assert {v for _, v, _, _ in em.hrrr_picks(parse_noaa_idx(HRRR_IDX.replace("6 hour fcst", "7 hour fcst")), 7)} == {"t", "u", "v"}
    snow = {v: tf for _, v, _, tf in p}["snow"]
    assert snow(0.05) == 5.0  # m → cm


def test_split_makes_wind_speed_in_kmh():
    acc, inst = em.split({6: {"u": np.array([3.0]), "v": np.array([4.0]), "t": np.array([1.0]), "precip": np.array([2.0])}})
    assert inst[6]["wind"][0] == pytest.approx(18.0) and acc[6]["precip"][0] == 2.0


def test_hrdps_url():
    u = em.hrdps_url(em.MSC_ROOTS[0], C, 6, "APCP", "Sfc")
    assert u == ("https://dd.weather.gc.ca/20261118/WXO-DD/model_hrdps/continental/2.5km/12/006/"
                 "20261118T12Z_MSC_HRDPS_APCP_Sfc_RLatLon0.0225_PT006H.grib2")


def test_hrrr_day_style_accumulation_label():
    idx = HRRR_IDX.replace("6 hour fcst", "24 hour fcst").replace("0-6 hour acc fcst", "0-1 day acc fcst").replace("5-6 hour acc", "23-24 hour acc")
    assert {v for _, v, _, _ in em.hrrr_picks(parse_noaa_idx(idx), 24)} == {"t", "u", "v", "precip", "snow"}
