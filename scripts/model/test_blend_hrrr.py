#!/usr/bin/env python3
"""Synthetic pairs: HRRR is built to be better, so v2 must beat v1 and the report must carry the gate."""
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

rng = np.random.default_rng(1)
rows = []
for split, yr in (("train", 2024), ("test", 2025)):
    for r in range(10):
        for d in range(120):
            date = dt.date(yr, 12, 1) + dt.timedelta(d)
            truth = max(0.0, rng.gamma(0.6, 8) - 3)
            reg = "utah" if r < 5 else "colorado"
            for lead in (1, 2):
                for m, noise in (("ecmwf_ifs025", 4), ("gfs_seamless", 5), ("gem_seamless", 5)):
                    rows.append(dict(source="open-meteo-previous-runs", model=m, space="liquid", pair_quality="strict", tier="mid",
                                     region=reg, resort_id=f"r{r}", local_date=date, lead_day=lead, split=split,
                                     fc_amount=max(0.0, truth + rng.normal(0, noise)), obs=truth, issue_ts=None,
                                     source_label=f"open-meteo-previous-runs:{m}"))
                for h in (0, 6, 12, 18):
                    rows.append(dict(source="noaa-hrrr", model="hrrr", space="liquid", pair_quality="strict", tier="mid",
                                     region=reg, resort_id=f"r{r}", local_date=date, lead_day=lead, split=split,
                                     fc_amount=max(0.0, truth + rng.normal(0, 1)), obs=truth,
                                     issue_ts=pd.Timestamp(date) - pd.Timedelta(days=lead) + pd.Timedelta(hours=h),
                                     source_label="noaa-hrrr:hrrr"))
with tempfile.TemporaryDirectory() as t:
    p = Path(t) / "pairs.parquet"
    duckdb.from_df(pd.DataFrame(rows)).write_parquet(str(p))
    subprocess.run([sys.executable, str(Path(__file__).parent / "blend_hrrr.py"), str(p), t], check=True, capture_output=True)
    j = json.loads((Path(t) / "blend_hrrr.json").read_text())
    rep = (Path(t) / "blend_hrrr_report.md").read_text()
    g = j["rules"]["latest"]["gate"]
    assert g["pass"], g
    assert j["rules"]["latest"]["weights_v2"]["1"]["hrrr"] > 0.3
    assert "Gate (latest rule): PASS" in rep and "gfs_seamless already carry HRRR" in rep
    assert "first" in j["rules"] and "correlation" in j
print("blend_hrrr tests passed")
