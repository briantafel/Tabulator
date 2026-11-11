"""Tests for dynamical_ens.py block building (no network).

    python3 -m pytest scripts/archive/test_dynamical_ens.py
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import dynamical_ens as D  # noqa: E402

RESORTS = [{"id": "alta"}, {"id": "zermatt"}]


def make(leads, n_mem=2, rate=1 / 3600.0):
    n = len(leads)
    shape = (n, n_mem, len(RESORTS))
    pr = np.full(shape, rate)
    pr[0] = np.nan  # no rate at lead 0
    t = np.zeros(shape)
    for k in range(n):
        t[k] = -float(k)
    return {"precipitation_surface": pr, "temperature_2m": t,
            "wind_u_10m": np.full(shape, 3.0), "wind_v_10m": np.full(shape, 4.0),
            "temperature_850hpa": np.full(shape, -8.0)}


def blocks_by(blocks):
    return {(v, vs): arr for v, u, vs, ve, arr in blocks}


def test_rate_times_interval_gives_mm_and_6h_blocks():
    leads = [0, 3, 6, 9, 12, 18, 24]  # 3-hourly then 6-hourly
    init = datetime(2026, 11, 11, 0, tzinfo=timezone.utc)
    b = D.build_blocks("ecmwf_ifs_ens", init, leads, make(leads), RESORTS, None, None, None, "x", "r",
                       {"temperature_850hpa": "temp_850_mean"}, None)
    by = blocks_by(b)
    # 1 mm/h rate → 6 mm per 6-hour block, whether from two 3-h steps or one 6-h step
    assert np.allclose(by[("precip", "2026-11-11T00:00:00Z")], 6.0)
    assert np.allclose(by[("precip", "2026-11-11T12:00:00Z")], 6.0)
    assert np.allclose(by[("precip", "2026-11-11T18:00:00Z")], 6.0)
    assert np.allclose(by[("temp_min", "2026-11-11T00:00:00Z")], -2.0)  # instants at 3 h and 6 h
    assert np.allclose(by[("wind_speed_max", "2026-11-11T00:00:00Z")], 18.0)  # 5 m/s
    assert np.allclose(by[("temp_850_mean", "2026-11-11T06:00:00Z")], -8.0)


def test_missing_rate_stays_missing_not_zero():
    leads = [0, 6, 12]
    d = make(leads)
    d["precipitation_surface"][1, 0, 1] = np.nan  # member 0, zermatt, first block
    init = datetime(2026, 11, 11, 0, tzinfo=timezone.utc)
    by = blocks_by(D.build_blocks("gefs", init, leads, d, RESORTS, None, None, None, "x", "r", {}, None))
    arr = by[("precip", "2026-11-11T00:00:00Z")]
    assert np.isnan(arr[0, 1]) and arr[0, 0] == pytest.approx(6.0)


def test_rows_skip_nan_and_carry_exact_issue_time():
    leads = [0, 6]
    init = datetime(2026, 11, 11, 6, tzinfo=timezone.utc)
    d = make(leads, n_mem=1)
    d["precipitation_surface"][1, 0, 0] = np.nan
    blocks = D.build_blocks("ecmwf_aifs_ens", init, leads, d, RESORTS, None, None, None, "x", "r", {}, None)
    rows = list(D.iter_rows(blocks, "ecmwf_aifs_ens", init, RESORTS, np.array([40.5, 46.0]), np.array([-111.75, 7.75]),
                            np.array([2900.4, float("nan")]), "f", "r"))
    precip = [r for r in rows if r["variable"] == "precip"]
    assert [r["resort_id"] for r in precip] == ["zermatt"]  # alta's NaN rate wrote no row
    assert precip[0]["issued_at"] == "2026-11-11T06:00:00Z" and precip[0]["valid_start"] == "2026-11-11T06:00:00Z"
    assert precip[0]["elevation_m"] is None and rows[0]["source"] == "dynamical-ens"


def test_implausible_fails_loudly():
    arr = np.array([[400.0]])
    with pytest.raises(RuntimeError, match="implausible"):
        D.check_plausible([("precip", "mm", "a", "b", arr)])


def test_gefs_frozen_no_precip_code_is_not_averaged():
    leads = [0, 3, 6]
    d = make(leads)
    pf = np.full(d["precipitation_surface"].shape, -50.0)  # "no precipitation"
    pf[2, 0, 0] = 80.0  # one real value
    d["percent_frozen_precipitation_surface"] = pf
    init = datetime(2026, 11, 11, 0, tzinfo=timezone.utc)
    by = blocks_by(D.build_blocks("gefs", init, leads, d, RESORTS, None, None, None, "x", "r",
                                  {"percent_frozen_precipitation_surface": "frozen_pct_mean"}, None))
    arr = by[("frozen_pct_mean", "2026-11-11T00:00:00Z")]
    assert arr[0, 0] == pytest.approx(80.0) and np.isnan(arr[0, 1])
    D.check_plausible([("frozen_pct_mean", "%", "a", "b", arr)])


def test_three_hourly_temperature_instants():
    leads = [0, 3, 6, 9, 12, 18, 24, 246]  # 3-hourly, then 6-hourly, then past day 10
    init = datetime(2026, 11, 11, 0, tzinfo=timezone.utc)
    b = D.build_blocks("ecmwf_ifs_ens", init, leads, make(leads), RESORTS, None, None, None, "x", "r", {}, None)
    inst = [(vs, ve, arr) for v, u, vs, ve, arr in b if v == "temp"]
    assert [vs for vs, _, _ in inst] == ["2026-11-11T03:00:00Z", "2026-11-11T06:00:00Z", "2026-11-11T09:00:00Z",
                                         "2026-11-11T12:00:00Z", "2026-11-11T18:00:00Z", "2026-11-12T00:00:00Z"]
    assert all(vs == ve for vs, ve, _ in inst)  # instants, not windows; lead 0 and >240 h left out
    assert np.allclose(inst[2][2], -3.0)  # the lead-9 value itself
    rows = list(D.iter_rows([("temp", "C", inst[0][0], inst[0][1], inst[0][2])], "ecmwf_ifs_ens", init, RESORTS,
                            np.zeros(2), np.zeros(2), np.zeros(2), "f", "r"))
    assert rows[0]["period_label"] == "instant" and rows[0]["variable"] == "temp"
