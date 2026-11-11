"""Tests for upper_air.py index parsing (no network): python3 -m pytest scripts/archive/test_upper_air.py"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import upper_air as ua  # noqa: E402

GEFS_IDX = """1:0:d=2026111100:HGT:10 mb:6 hour fcst:ENS=+3
2:900:d=2026111100:TMP:850 mb:6 hour fcst:ENS=+3
3:1800:d=2026111100:RH:850 mb:6 hour fcst:ENS=+3
4:2700:d=2026111100:TMP:700 mb:6 hour fcst:ENS=+3
5:3600:d=2026111100:PRES:surface:6 hour fcst:ENS=+3
6:4500:d=2026111100:HGT:surface:6 hour fcst:ENS=+3
7:5400:d=2026111100:TMP:2 m above ground:6 hour fcst:ENS=+3
8:6300:d=2026111100:HGT:500 mb:6 hour fcst:ENS=+3
"""


def test_gefs_idx_keeps_ens_lines_and_picks_profile_levels():
    idx = ua.parse_noaa_idx(GEFS_IDX)
    assert idx[1]["extra"] == "ENS=+3"
    picks = ua.select_noaa(idx, 6)
    names = [v for _, v, _, _ in picks]
    assert names == ["t_850hpa", "rh_850hpa", "t_700hpa", "psfc", "@orog", "z_500hpa"]  # not 10 mb, not 2 m
    assert picks[-1][0]["end"] is None  # last message: open range
    assert ua.select_noaa(idx, 12) == []  # other lead


def test_lead_zero_is_the_analysis():
    idx = ua.parse_noaa_idx("1:0:d=2026111100:TMP:850 mb:anl:\n2:10:d=2026111100:RH:850 mb:anl:\n")
    assert [v for _, v, _, _ in ua.select_noaa(idx, 0)] == ["t_850hpa", "rh_850hpa"]


def test_units_kelvin_pascal():
    idx = ua.parse_noaa_idx(GEFS_IDX)
    p = {v: tf for _, v, _, tf in ua.select_noaa(idx, 6)}
    assert abs(p["t_850hpa"](273.15) - 0.0) < 1e-9
    assert p["psfc"](85000.0) == 850.0


def test_adjacent_messages_merge_into_one_request():
    idx = ua.parse_noaa_idx(GEFS_IDX)
    groups = ua.merge_ranges(ua.select_noaa(idx, 6))
    # entries 2–6 are back to back; 8 is separated by the 2 m line
    assert [[v for _, v, _, _ in g] for g in groups] == [["t_850hpa", "rh_850hpa", "t_700hpa", "psfc", "@orog"], ["z_500hpa"]]
    assert groups[0][0][0]["start"] == 900 and groups[0][-1][0]["end"] == 5399


def ecmwf_line(**kw):
    base = {"domain": "g", "date": "20261111", "time": "0000", "stream": "enfo", "step": "24", "levtype": "pl"}
    return json.dumps({**base, **kw})


def test_ecmwf_index_q_only_where_r_missing_and_no_mean_products():
    lines = [
        ecmwf_line(type="cf", param="t", levelist="850", _offset=0, _length=100),
        ecmwf_line(type="cf", param="r", levelist="850", _offset=100, _length=100),
        ecmwf_line(type="cf", param="q", levelist="850", _offset=200, _length=100),  # has r → skipped
        ecmwf_line(type="cf", param="q", levelist="700", _offset=300, _length=100),  # no r at 700 → kept
        ecmwf_line(type="pf", number="7", param="gh", levelist="500", _offset=400, _length=100),
        ecmwf_line(type="pf", number="7", param="t", levelist="250", _offset=500, _length=100),  # level not wanted
        ecmwf_line(type="em", param="t", levelist="850", _offset=600, _length=100),  # ensemble mean
        ecmwf_line(type="cf", param="sp", levtype="sfc", _offset=700, _length=100),
    ]
    idx = ua.parse_ecmwf_index("\n".join(lines))
    picks = ua.select_ecmwf(idx)
    assert [v for _, v, _, _ in picks] == ["t_850hpa", "rh_850hpa", "q_700hpa", "z_500hpa", "psfc"]
    assert idx[0]["end"] == 99
    q = {v: tf for _, v, _, tf in picks}["q_700hpa"]
    assert abs(q(0.004) - 4.0) < 1e-9  # kg/kg → g/kg
    assert ua.member_of("ifs-ens", "x", picks[0][0]) == 0
    assert ua.member_of("ifs-ens", "x", picks[3][0]) == 7


def test_members_and_files():
    from datetime import datetime, timezone
    c = datetime(2026, 11, 11, 12, tzinfo=timezone.utc)
    assert ua.member_of("gefs", "https://x/gefs.20261111/12/atmos/pgrb2ap5/gec00.t12z.pgrb2a.0p50.f006", {}) == 0
    assert ua.member_of("gefs", "https://x/gefs.20261111/12/atmos/pgrb2ap5/gep17.t12z.pgrb2a.0p50.f006", {}) == 17
    assert ua.member_of("hrrr", "u", {}) is None
    g = ua.files_for("gefs", ua.MODELS["gefs"], c)
    assert len(g) == 31 * 41 and g[0][1].endswith("gec00.t12z.pgrb2a.0p50.f000")
    h = ua.files_for("hrrr", ua.MODELS["hrrr"], c)
    assert h[1][1].endswith("hrrr.20261111/conus/hrrr.t12z.wrfprsf06.grib2") and h[1][2].endswith(".grib2.idx")
    e = ua.files_for("ifs-ens", ua.MODELS["ifs-ens"], c)
    assert e[4][1].endswith("20261111/12z/ifs/0p25/enfo/20261111120000-24h-enfo-ef.grib2")
    assert e[4][2].endswith("20261111120000-24h-enfo-ef.index")
    assert ua.MODELS["ifs-ens"]["leads"][-3:] == [216, 228, 240] and 150 in ua.MODELS["ifs-ens"]["leads"]


def test_plausibility_catches_unit_mistakes():
    import numpy as np
    import pytest
    good = [(6, 0, "z_500hpa", "m", np.array([5600.0, 5550.0])), (6, 0, "t_850hpa", "C", np.array([-5.0, np.nan]))]
    assert ua.check_plausible(good) == 3  # the NaN is missing, not a row
    with pytest.raises(RuntimeError):
        ua.check_plausible([(6, 0, "z_500hpa", "m", np.array([560.0, 555.0]))])  # decametres, not metres
    with pytest.raises(RuntimeError):
        ua.check_plausible([(6, 0, "t_850hpa", "C", np.array([268.0]))])  # still Kelvin
    assert ua.check_plausible([(6, 0, "rh_500hpa", "%", np.array([112.0]))]) == 1  # ECMWF over ice: real
    with pytest.raises(RuntimeError):
        ua.check_plausible([(6, 0, "rh_500hpa", "%", np.array([0.9, 1.0]) * 1000)])  # fraction ×1000 mistake


def test_spans_cover_small_gaps_with_placeholders():
    e = [{"start": i * 100, "end": i * 100 + 99} for i in range(8)]
    picks = [(e[0], "a", "u", None), (e[1], "b", "u", None), (e[3], "c", "u", None), (e[7], "d", "u", None)]
    groups = ua.merge_ranges(picks, e, gap=150)
    # e[2] (100 bytes) is bridged; e[4..6] (300 bytes) is not
    assert [[v for _, v, _, _ in g] for g in groups] == [["a", "b", None, "c"], ["d"]]
    assert groups[0][0][0]["start"] == 0 and groups[0][-1][0]["end"] == 399
    # no gap allowed: only back-to-back messages merge
    assert [[v for _, v, _, _ in g] for g in ua.merge_ranges(picks, e, gap=0)] == [["a", "b"], ["c"], ["d"]]


def test_ensemble_chunks_cover_every_lead_once():
    ch = ua.chunks(ua.MODELS["ifs-ens"])
    assert [l for c in ch for l in c] == ua.MODELS["ifs-ens"]["leads"]
    assert max(len(c) for c in ch) == 6
    assert ua.chunks(ua.MODELS["gefs"]) == [ua.MODELS["gefs"]["leads"]]
