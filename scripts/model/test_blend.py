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
    # This blend has almost no drizzle on dry days: the floor must NOT be promoted where it doesn't help.
    assert not any(b["trace_floor_promote"].values()), b["trace_floor_promote"]
    assert 0.9 <= b["pooled_factors"]["gem_seamless|1"] <= 1.1, b["pooled_factors"]
    w = b["weights"]["1"]
    assert abs(sum(w.values()) - 1) < 0.01 and w["ecmwf_ifs025"] > w["gem_seamless"] > w["gfs_seamless"], w
    rep = (tmp / "out" / "blend_report.md").read_text()
    mae = [l for l in rep.split("Mean absolute error")[1].splitlines() if l.startswith("| 1 |")][0]
    v = [float(x) for x in mae.strip("|").split("|")[1:]]
    assert v[0] < min(v[1:]), f"blend MAE should beat every raw model: {mae}"
    fc = rep.split("## Factor check")[1]
    allrow = [l for l in fc.splitlines() if l.startswith("| 1-3 | ALL |")][0]
    cells = [x.strip() for x in allrow.strip("|").split("|")]
    none_vol, v1_vol, cand_vol = float(cells[5]), float(cells[9]), float(cells[13])
    # ECMWF reads half the water and carries most weight: no factor is dry, v1 fixes it, cand (clamp 1.5) partly.
    assert none_vol < 0.9 and 0.9 <= v1_vol <= 1.1 and none_vol < cand_vol <= v1_vol, allrow
print("blend: all checks passed")


# Trace floor on its own: dry days carry 1–4 mm of model drizzle; wet days are ≥ 6 mm and forecast well.
import duckdb as _db
from blend import trace_floor
_rng = np.random.default_rng(11)
_con = _db.connect()
_con.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
_con.executemany("INSERT INTO w VALUES (?, ?, ?)", [(l, "m", 1.0) for l in range(1, 8)])
_con.execute("CREATE TABLE dc(model VARCHAR, resort_id VARCHAR, local_date DATE, lead INTEGER, split VARCHAR, obs DOUBLE, fcc DOUBLE)")
_rows = []
for split, y in (("train", 2024), ("test", 2025)):
    for d in range(150):
        for r in range(6):
            wet = _rng.random() < 0.35
            obs = float(_rng.uniform(6, 30)) if wet else 0.0
            fc = obs * _rng.uniform(0.8, 1.2) if wet else float(_rng.uniform(1, 4))
            for lead in range(1, 8):
                _rows.append(("m", f"r{r}", f"{y}-12-01", lead, split, obs, fc))
_rows = [(m, rr, str(np.datetime64(dd) + np.timedelta64(i // 42, "D")), l, sp, o, f)
         for i, (m, rr, dd, l, sp, o, f) in enumerate(_rows)]
_con.executemany("INSERT INTO dc VALUES (?, ?, ?, ?, ?, ?, ?)", _rows)
_floors, _prom, _rep = trace_floor(_con, {})
assert _floors["1"] >= 4 and all(_prom.values()), (_floors, _prom)
assert "Trace floor" in _rep
print("trace floor: checks passed")
