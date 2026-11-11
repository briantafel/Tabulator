"""Tests for regional_eps.py without the network or ecCodes.

    python3 -m pytest scripts/archive/test_regional_eps.py
"""
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import regional_eps as R  # noqa: E402

RESORTS = [{"id": "zermatt", "latlon": [46.0, 7.73]}, {"id": "alta", "latlon": [40.59, -111.64]}]
CLAT = np.radians(np.array([46.0, 46.5, 45.0]))
CLON = np.radians(np.array([7.73, 8.5, 6.0]))


def test_nearest_cells_keeps_only_resorts_inside_the_domain():
    cells = R.nearest_cells(CLAT, CLON, RESORTS, 5.0)
    assert set(cells) == {"zermatt"}
    assert cells["zermatt"][0] == 0 and cells["zermatt"][1] < 0.01


def test_blocks_difference_accumulations_and_skip_partial_blocks(monkeypatch):
    # Accumulated precip grows 1 mm per hour; member 1 only. 00z run, leads 0–12.
    def fake_messages(raw):
        var, lead = raw.decode().split(":")
        lead = int(lead)
        vals = {"tot_prec": float(lead), "t_2m": 273.15 - lead, "u_10m": 3.0, "v_10m": 4.0}[var]
        yield {"perturbationNumber": 1, "typeOfEnsembleForecast": 192}, np.array([vals, vals, vals])

    monkeypatch.setattr(R, "grib_messages", fake_messages)
    monkeypatch.setattr(R, "http", lambda url, **k: url.encode())
    files = {v: {l: [f"{v}:{l}"] for l in range(0, 13)} for v in ("tot_prec", "t_2m", "u_10m", "v_10m")}
    cfg = dict(source="dwd-icon-eps", max_km=5.0)
    consts = {"clat": CLAT, "clon": CLON, "hsurf": np.array([1620.0, 0, 0])}
    rt = datetime(2026, 11, 11, 0, tzinfo=timezone.utc)
    rows = R.collect_run("icon-eu-eps", cfg, rt, RESORTS, files, consts, "2026-11-11T05:00:00Z", "t")
    by = {(r["valid_start"], r["variable"]): r for r in rows}
    assert {r["resort_id"] for r in rows} == {"zermatt"}
    assert by[("2026-11-11T00:00:00Z", "precip")]["value"] == 6.0
    assert by[("2026-11-11T06:00:00Z", "precip")]["value"] == 6.0
    assert ("2026-11-11T12:00:00Z", "precip") not in by  # 12–18 is not covered: no row, not zero
    assert by[("2026-11-11T00:00:00Z", "temp_min")]["value"] == -6.0  # instants 1..6 h
    assert math.isclose(by[("2026-11-11T00:00:00Z", "wind_speed_max")]["value"], 18.0)  # 5 m/s
    assert by[("2026-11-11T00:00:00Z", "precip")]["elevation_m"] == 1620
    assert by[("2026-11-11T00:00:00Z", "precip")]["issued_at"] == "2026-11-11T00:00:00Z"


def test_d2_run_starting_mid_block_skips_the_partial_first_block(monkeypatch):
    def fake_messages(raw):
        var, lead = raw.decode().split(":")
        yield {"perturbationNumber": 3}, np.array([float(lead)] * 3)

    monkeypatch.setattr(R, "grib_messages", fake_messages)
    monkeypatch.setattr(R, "http", lambda url, **k: url.encode())
    files = {"tot_prec": {l: [f"tot_prec:{l}"] for l in range(0, 10)}}
    rt = datetime(2026, 11, 11, 3, tzinfo=timezone.utc)
    rows = R.collect_run("icon-d2-eps", dict(source="dwd-icon-eps", max_km=5.0), rt, RESORTS, files,
                         {"clat": CLAT, "clon": CLON}, "x", "t")
    starts = {r["valid_start"] for r in rows}
    assert starts == {"2026-11-11T06:00:00Z"}  # 03–06 partial skipped, 06–12 full
    assert rows[0]["value"] == 6.0 and rows[0]["member"] == 3
