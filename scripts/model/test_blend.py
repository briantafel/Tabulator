#!/usr/bin/env python3
"""Synthetic test for blend.py. Truth is known: ECMWF reads half the real
water (factor must come out ~2), GEM is unbiased but noisy, GFS is very
noisy. The blend must find the factor, weight the models sensibly, and beat
every raw model on the judge winter.
    python3 scripts/model/test_blend.py
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from blend import main  # noqa: E402

rng = np.random.default_rng(3)
rows = []
for split, start in (("train", date(2024, 12, 1)), ("test", date(2025, 12, 1))):
    for d in range(120):
        day = start + timedelta(days=d)
        for resort, region in (("alta", "Utah"), ("vail", "Colorado"), ("snowbird", "Utah")):
            obs = float(rng.choice([0, 0, 0, 3, 8, 15, 25]) * rng.uniform(0.8, 1.2))
            for lead in range(1, 8):
                for model, fc in (("ecmwf_ifs025", obs * 0.5 + rng.normal(0, 0.5)),
                                  ("gem_seamless", obs + rng.normal(0, 3)),
                                  ("gfs_seamless", obs + rng.normal(0, 8))):
                    rows.append(("open-meteo-previous-runs", f"open-meteo-previous-runs:{model}", region, resort, day,
                                 lead, split, "liquid", max(fc, 0.0), obs))
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    con = duckdb.connect()
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, region VARCHAR, resort_id VARCHAR,
                   local_date DATE, lead_day INTEGER, split VARCHAR, space VARCHAR, fc_amount DOUBLE, obs DOUBLE)""")
    con.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("ALTER TABLE p ADD COLUMN pair_quality VARCHAR DEFAULT 'strict'")
    con.execute("ALTER TABLE p ADD COLUMN tier VARCHAR DEFAULT 'mid'")
    con.execute(f"COPY p TO '{tmp / 'pairs.parquet'}' (FORMAT parquet)")
    main(tmp / "pairs.parquet", tmp / "out")
    b = json.loads((tmp / "out" / "blend.json").read_text())
    assert 1.8 <= b["pooled_factors"]["ecmwf_ifs025|1"] <= 2.0, b["pooled_factors"]
    assert 0.9 <= b["pooled_factors"]["gem_seamless|1"] <= 1.1, b["pooled_factors"]
    w = b["weights"]["1"]
    assert abs(sum(w.values()) - 1) < 0.01 and w["ecmwf_ifs025"] > w["gem_seamless"] > w["gfs_seamless"], w
    rep = (tmp / "out" / "blend_report.md").read_text()
    mae = [l for l in rep.split("Mean absolute error")[1].splitlines() if l.startswith("| 1 |")][0]
    v = [float(x) for x in mae.strip("|").split("|")[1:]]
    assert v[0] < min(v[1:]), f"blend MAE should beat every raw model: {mae}"
print("blend: all checks passed")
