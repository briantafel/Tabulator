#!/usr/bin/env python3
"""Synthetic test for temps.py: each model has a fixed per-resort HIGH bias
(e.g. GEM +3 °C at Alta) plus noise; ECMWF is the noisiest. The fit must
recover the biases, weight the quiet models higher, and the corrected blend
must be promoted for highs on the judge winter. Lows have NO bias, so their correction
must not be promoted; lift-hours lows have a cold bias and must be.
    python3 scripts/model/test_temps.py
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from temps import main  # noqa: E402

rng = np.random.default_rng(5)
BIAS = {("ecmwf_ifs025", "alta"): -2.0, ("gem_seamless", "alta"): 3.0, ("gfs_seamless", "alta"): 1.0,
        ("ecmwf_ifs025", "vail"): 1.5, ("gem_seamless", "vail"): -1.0, ("gfs_seamless", "vail"): -3.0,
        ("ecmwf_ifs025", "snowbird"): -2.0, ("gem_seamless", "snowbird"): 2.5, ("gfs_seamless", "snowbird"): 0.5}
NOISE = {"ecmwf_ifs025": 2.5, "gem_seamless": 1.0, "gfs_seamless": 1.5}
REGION = {"alta": "Utah", "snowbird": "Utah", "vail": "Colorado"}
rows = []
for split, start in (("train", date(2024, 12, 1)), ("test", date(2025, 12, 1))):
    for d in range(150):
        day = start + timedelta(days=d)
        for resort in REGION:
            hi, lo, lift = rng.normal(-3, 5), rng.normal(-12, 5), rng.normal(-8, 5)
            for lead in range(1, 8):
                for m in NOISE:
                    for var, obs, b in (("hi", hi, BIAS[(m, resort)]), ("lo", lo, 0.0),
                                        ("lift", lift, -BIAS[(m, resort)] - 2.0)):
                        rows.append(("open-meteo-previous-runs", f"open-meteo-previous-runs:{m}", resort,
                                     REGION[resort], day, lead, split, var, obs + b + rng.normal(0, NOISE[m]), obs))
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    con = duckdb.connect()
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, resort_id VARCHAR, region VARCHAR,
                   local_date DATE, lead_day INTEGER, split VARCHAR, var VARCHAR, fc_adj DOUBLE, obs DOUBLE)""")
    con.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("ALTER TABLE p ADD COLUMN pair_quality VARCHAR DEFAULT 'strict'")
    con.execute("ALTER TABLE p ADD COLUMN tier VARCHAR DEFAULT 'mid'")
    con.execute(f"COPY p TO '{tmp / 'temp_pairs.parquet'}' (FORMAT parquet)")
    main(tmp / "temp_pairs.parquet", tmp / "out")
    p = json.loads((tmp / "out" / "temp-model.json").read_text())
    # 450 training days per resort → shrinkage is small; recovered within 0.4 °C.
    assert abs(p["high_bias"]["gem_seamless|alta"] - 3.0) < 0.4, p["high_bias"]
    assert abs(p["high_bias"]["gfs_seamless|vail"] + 3.0) < 0.4, p["high_bias"]
    w = p["weights"]["hi"]["1"]
    assert w["gem_seamless"] > w["gfs_seamless"] > w["ecmwf_ifs025"], w
    assert all(p["promote"]["hi"].values()), p["promote"]
    assert p["version"] == "temps-v2" and "caveat_lows" in p
    assert not any(p["promote"]["lo"].values()), p["promote"]["lo"]  # no real low bias → no promotion
    assert all(p["promote"]["lift"].values()), p["promote"]["lift"]
    assert abs(p["lift_bias"]["gem_seamless|alta"] + 5.0) < 0.4, p["lift_bias"]
    rep = (tmp / "out" / "temps_report.md").read_text()
    assert "Judged on the test winter" in rep
    assert "## Drift" in rep and "## Decaying-average bias" in rep
    assert p["decay"]["alpha"]["hi"] in (0.02, 0.05, 0.1, 0.2), p["decay"]

# Drift (2026-11-19): the test winter's models run 2 °C warmer than in training, as the
# Sierra highs did live. The static correction then overshoots; the decaying bias must
# catch up and be promoted, and must not invent a gain where nothing drifted (lows).
rows = []
for split, start, shift in (("train", date(2024, 12, 1), 0.0), ("test", date(2025, 12, 1), 2.0)):
    for d in range(120):
        day = start + timedelta(days=d)
        for resort in ("alta", "vail"):
            hi, lo = rng.normal(-3, 5), rng.normal(-12, 5)
            for lead in range(1, 8):
                for m in NOISE:
                    for var, o, b in (("hi", hi, BIAS[(m, resort)] + shift), ("lo", lo, 0.0)):
                        rows.append(("open-meteo-previous-runs", f"open-meteo-previous-runs:{m}", resort,
                                     REGION[resort], day, lead, split, var, o + b + rng.normal(0, NOISE[m]), o))
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    con = duckdb.connect()
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, resort_id VARCHAR, region VARCHAR,
                   local_date DATE, lead_day INTEGER, split VARCHAR, var VARCHAR, fc_adj DOUBLE, obs DOUBLE)""")
    con.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("ALTER TABLE p ADD COLUMN pair_quality VARCHAR DEFAULT 'strict'")
    con.execute("ALTER TABLE p ADD COLUMN tier VARCHAR DEFAULT 'mid'")
    con.execute(f"COPY p TO '{tmp / 'temp_pairs.parquet'}' (FORMAT parquet)")
    main(tmp / "temp_pairs.parquet", tmp / "out")
    p = json.loads((tmp / "out" / "temp-model.json").read_text())
    assert p["decay"]["promote"]["hi"]["1"] is True, p["decay"]
    assert not p["decay"]["promote"]["lo"].get("1"), p["decay"]
print("temps: all checks passed")
