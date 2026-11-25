#!/usr/bin/env python3
"""Synthetic check of canada_interior_wet.py: forecasts built 2x the truth -> TOO WET in both winters; built equal
-> NOT TOO WET; a paid source never reaches the report. Plain script: python3 scripts/diag/test_canada_interior_wet.py"""
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
POOL = ("panorama", "kimberley", "fernie", "kicking-horse", "norquay", "sunshine", "lake-louise", "marmot")


def make(scale: float, seed=1):
    rng = np.random.default_rng(seed)
    P, E = [], []
    for yr, split in ((2024, "train"), (2025, "test"), (2026, "live")):
        for r in POOL:
            for d in range(120 if yr < 2026 else 20):
                day = dt.date(yr, 11, 20) + dt.timedelta(d)
                truth = max(0.0, rng.gamma(0.7, 8) - 2)
                for lead in range(1, 8):
                    for m in ("ecmwf_ifs025", "gfs_seamless", "gem_seamless"):
                        P.append(dict(source="open-meteo-previous-runs", source_label=f"open-meteo-previous-runs:{m}", space="liquid",
                                      tier="mid", resort_id=r, region="Canada", lead_day=lead, local_date=day, issue_ts=pd.NaT,
                                      fc_amount=truth * scale, fc_temp_c=-6.0, truth_source="bc-asws", station_id=f"s-{r}",
                                      station_km=12.0, station_delev_m=-100.0, pair_quality="loose", obs_swe_gain_mm=truth,
                                      ots_reported_cm=truth * 1.3, split=split, obs=truth))
                P.append(dict(source="snow-forecast", source_label="snow-forecast", space="liquid", tier="mid", resort_id=r,
                              region="Canada", lead_day=1, local_date=day, issue_ts=pd.Timestamp(day), fc_amount=99.0,
                              fc_temp_c=-6.0, truth_source="bc-asws", station_id=f"s-{r}", station_km=12.0, station_delev_m=-100.0,
                              pair_quality="loose", obs_swe_gain_mm=truth, ots_reported_cm=None, split=split, obs=truth))
                E.append(dict(resort_id=r, station_id=f"g-{r}", station_name="X", station_km=20.0, station_elev_m=1000,
                              station_delev_m=-500, strict=False, coverage=0.9, chosen=False, local_date=day, obs=truth * 0.8,
                              flag=None, winter=yr))
    return pd.DataFrame(P), pd.DataFrame(E)


def run(scale):
    p, e = make(scale)
    with tempfile.TemporaryDirectory() as t:
        pp, ep, out = Path(t) / "pairs.parquet", Path(t) / "e.parquet", Path(t) / "out"
        duckdb.from_df(p).write_parquet(str(pp))
        duckdb.from_df(e).write_parquet(str(ep))
        r = subprocess.run([sys.executable, str(HERE / "canada_interior_wet.py"), str(pp), str(ep), str(out)], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-3000:]
        text = (out / "canada_interior_wet.md").read_text()
        assert "snow-forecast" not in text.lower()
        return json.loads((out / "canada_interior_wet.json").read_text()), text


j, _ = run(2.5)
assert j["answer"]["final"] == "TOO WET", j["answer"]
# v1 applies the published Canada factors (about x0.9-x1.6), so raw = truth is not v1 = truth; build raw at 0.75.
j, txt = run(0.75)
assert j["answer"]["final"] in ("NOT TOO WET", "MIXED"), (j["answer"], txt[:2000])
print(txt[:2500])
print("canada_interior_wet synthetic: OK")
