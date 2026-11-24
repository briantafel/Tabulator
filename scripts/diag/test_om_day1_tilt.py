#!/usr/bin/env python3
"""Synthetic check of om_day1_tilt.py: comparator built much better than every Open-Meteo model → Part 2 must say
"X beats stale v1"; comparator built as noise → "v1 lead robust"; a comparator row after the day start → abort.
Plain script: python3 scripts/diag/test_om_day1_tilt.py"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import duckdb
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "model"))
from test_blend_nbm import make  # noqa: E402

TIMING = {"test_a_by_model": {"ecmwf_ifs025": "UNKNOWN", "gfs_seamless": "UNKNOWN", "gem_seamless": "UNKNOWN"}, "test_a": {}}


def run(df):
    with tempfile.TemporaryDirectory() as t:
        p, tj = Path(t) / "pairs.parquet", Path(t) / "timing.json"
        h = df[df.source == "nbm"].copy()
        h["source"], h["source_label"] = "noaa-hrrr", "noaa-hrrr:hrrr"
        duckdb.from_df(pd.concat([df, h])).write_parquet(str(p))
        tj.write_text(json.dumps(TIMING))
        r = subprocess.run([sys.executable, str(HERE / "om_day1_tilt.py"), str(p), str(tj), str(Path(t) / "out")],
                           capture_output=True, text=True)
        j = json.loads((Path(t) / "out/om_day1_tilt.json").read_text()) if r.returncode == 0 else None
        return r, j


r, j = run(make(nbm_noise=1.0))
assert r.returncode == 0, r.stderr[-2000:]
v = {c: j["part2"][c]["verdict"] for c in j["part2"]}
assert all(x == "X beats stale v1" for x in v.values()), v
assert all(a == "UNKNOWABLE" for a in j["answer"].values()), j["answer"]  # timing UNKNOWN, not H_late → not an artifact claim
r, j = run(make(nbm_noise=30.0))
assert r.returncode == 0, r.stderr[-2000:]
v = {c: j["part2"][c]["verdict"] for c in j["part2"]}
assert all(x == "v1 lead robust" for x in v.values()), v
assert all(a == "REAL" for a in j["answer"].values()), j["answer"]
r, _ = run(make(nbm_noise=5.0, leak=True))
assert r.returncode != 0 and "leakage" in (r.stderr + r.stdout).lower(), r.stderr[-500:]
print("om_day1_tilt synthetic: OK")
