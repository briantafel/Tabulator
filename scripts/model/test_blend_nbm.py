#!/usr/bin/env python3
"""Synthetic pairs for blend_nbm.py: (1) NBM built better → both gates PASS under both cycle rules;
(2) NBM built as noise → (a) does not pass; (3) one NBM row issued after its local day starts → the run aborts."""
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

HERE = Path(__file__).parent


def make(nbm_noise: float, leak: bool = False, seed: int = 1) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows = []
    for split, yr in (("train", 2024), ("test", 2025)):
        for r in range(12):
            reg = "utah" if r < 6 else "colorado"
            for d in range(150):
                date = dt.date(yr, 11, 15) + dt.timedelta(d)
                truth = max(0.0, rng.gamma(0.6, 12) - 3)
                for lead in range(1, 8):
                    for m, noise in (("ecmwf_ifs025", 5), ("gfs_seamless", 6), ("gem_seamless", 6)):
                        rows.append(dict(source="open-meteo-previous-runs", model=m, space="liquid", pair_quality="strict",
                                         tier="mid", region=reg, resort_id=f"r{r}", local_date=date, lead_day=lead, split=split,
                                         fc_amount=max(0.0, truth + rng.normal(0, noise)), obs=truth, issue_ts=pd.NaT,
                                         lead_hours=24.0 * lead, source_label=f"open-meteo-previous-runs:{m}"))
                    for h in (0, 12):
                        # local tz UTC-7: day start = date 07:00Z. issue date local = date - lead.
                        iss = pd.Timestamp(date) - pd.Timedelta(days=lead) + pd.Timedelta(hours=h + (24 if h == 0 else 0))
                        lh = (pd.Timestamp(date) + pd.Timedelta(hours=7) - iss).total_seconds() / 3600
                        rows.append(dict(source="nbm", model="nbm", space="liquid", pair_quality="strict", tier="mid",
                                         region=reg, resort_id=f"r{r}", local_date=date, lead_day=lead, split=split,
                                         fc_amount=max(0.0, truth + rng.normal(0, nbm_noise)), obs=truth, issue_ts=iss,
                                         lead_hours=lh, source_label="nbm:nbm"))
    df = pd.DataFrame(rows)
    if leak:
        i = df.index[(df.source == "nbm")][0]
        df.loc[i, "lead_hours"] = -3.0
    return df


def run(df):
    with tempfile.TemporaryDirectory() as t:
        p = Path(t) / "pairs.parquet"
        duckdb.from_df(df).write_parquet(str(p))
        pr = subprocess.run([sys.executable, str(HERE / "blend_nbm.py"), str(p), t], capture_output=True, text=True)
        j = json.loads((Path(t) / "blend_nbm.json").read_text()) if pr.returncode == 0 else None
        rep = (Path(t) / "blend_nbm_report.md").read_text() if pr.returncode == 0 else ""
        return pr, j, rep


pr, j, rep = run(make(1.5))
assert pr.returncode == 0, pr.stderr[-3000:]
assert j["verdict"]["a_member"] == "PASS", j["verdict"]
assert j["verdict"]["b_standalone"] == "PASS", j["verdict"]
assert j["leakage"]["not_before_day"] == 0 and j["leakage"]["bad_cycle"] == 0
assert j["rules"]["latest"]["weights_v2"]["1"]["nbm"] > 0.4
assert "Coverage by resort" in rep and "Verdict" in rep

pr, j, rep = run(make(12, seed=2))
assert pr.returncode == 0, pr.stderr[-3000:]
assert j["verdict"]["a_member"] != "PASS", j["verdict"]
assert j["verdict"]["b_standalone"] != "PASS", j["verdict"]
assert j["rules"]["latest"]["b"]["verdicts"]["1-3"]["v1"] == "beats NBM"

pr, j, rep = run(make(1.5, leak=True))
assert pr.returncode != 0 and "LEAKAGE CHECK FAILED" in (pr.stderr + pr.stdout), pr.returncode
print("blend_nbm tests passed")
