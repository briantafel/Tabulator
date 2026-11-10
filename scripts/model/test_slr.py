#!/usr/bin/env python3
"""Synthetic test for slr.py: a known SLR = 10 − 0.8·T must be recovered,
and on the judge winter the fitted ratio must beat 7:1 on ≥15 cm days.
    python3 scripts/model/test_slr.py
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from slr import main  # noqa: E402


def make(path: Path) -> None:
    rng = np.random.default_rng(1)
    rows = []
    for split, start in (("train", date(2024, 12, 1)), ("test", date(2025, 12, 1))):
        for d in range(120):
            day = start + timedelta(days=d)
            for resort in ("alta", "snowbird", "vail", "jackson-hole"):
                t = rng.uniform(-15, 0)
                liq = rng.choice([0, 0, 2, 8, 15, 25, 40])
                true_slr = 10 - 0.8 * t
                obs_depth = liq * true_slr / 10 * rng.uniform(0.9, 1.1)
                for lead in range(0, 4):
                    rows.append(("open-meteo-previous-runs", "open-meteo-previous-runs:gfs_seamless", resort, day, lead,
                                 split, "liquid", float(liq), float(t), float(liq), float(obs_depth)))
                rows.append(("snow-forecast-hindcast", "snow-forecast-hindcast", resort, day, 0, split, "snow",
                             float(obs_depth * 0.8), None, float(liq), float(obs_depth)))
    con = duckdb.connect()
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, resort_id VARCHAR, local_date DATE,
      lead_day INTEGER, split VARCHAR, space VARCHAR, fc_amount DOUBLE, fc_temp_c DOUBLE,
      obs_swe_gain_mm DOUBLE, obs_depth_gain_cm DOUBLE)""")
    con.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("ALTER TABLE p ADD COLUMN pair_quality VARCHAR DEFAULT 'strict'")
    con.execute("ALTER TABLE p ADD COLUMN tier VARCHAR DEFAULT 'mid'")
    con.execute(f"COPY p TO '{path}' (FORMAT parquet)")


with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    make(tmp / "pairs.parquet")
    main(tmp / "pairs.parquet", tmp / "out")
    p = json.loads((tmp / "out" / "slr.json").read_text())
    assert abs(p["a"] - 10) < 1.0 and abs(p["b"] + 0.8) < 0.1, p
    rep = (tmp / "out" / "slr_report.md").read_text()
    assert "Ours vs Snow-Forecast" in rep and "gfs_seamless" in rep
    line = next(l for l in rep.splitlines() if l.startswith("| gfs_seamless | 1 | 15.00"))
    cells = [c.strip() for c in line.strip("|").split("|")]
    assert float(cells[6]) > float(cells[4]), f"ours should beat 7:1: {line}"
print("slr: all checks passed")
