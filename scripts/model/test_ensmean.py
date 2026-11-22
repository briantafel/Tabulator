#!/usr/bin/env python3
"""Synthetic test for ensmean.py. Truth is known: the GEFS mean reads 60% of the real water
(its factor must come out near 1/0.6), the ECMWF ENS mean is unbiased, and the three deterministic
models are noisy. The corrected GEFS mean must beat the raw one on every winter, each winter must be
corrected without using itself, and a model with a single winter must stop the run loudly.
    python3 scripts/model/test_ensmean.py
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import ensmean  # noqa: E402

rng = np.random.default_rng(11)
RESORTS = (("alta", "Utah"), ("vail", "Colorado"), ("snowbird", "Utah"))
GEFS_WINTERS = (2021, 2022, 2023, 2024, 2025)
EC_WINTERS = (2024, 2025)


def build(tmp: Path, ec_winters=EC_WINTERS) -> None:
    (tmp / "longrange_tmp").mkdir()
    truth, dyn, pairs = [], [], []
    for w in GEFS_WINTERS:
        for d in range(100):
            day = date(w, 12, 1) + timedelta(days=d)
            for rid, region in RESORTS:
                obs = float(rng.choice([0, 0, 0, 3, 8, 15, 25]) * rng.uniform(0.8, 1.2))
                truth.append((rid, region, "America/Denver", day, "snotel", obs, w))
                for lead in range(1, 8):
                    issue = day - timedelta(days=lead)
                    dyn.append(("dynamical-ens:gefs", rid, f"{issue}T00", lead, day, 24, 31, max(obs * 0.6 + rng.normal(0, 0.8), 0.0)))
                    if w in ec_winters:
                        dyn.append(("dynamical-ens:ecmwf_ifs_ens", rid, f"{issue}T00", lead, day, 24, 51, max(obs + rng.normal(0, 1.5), 0.0)))
                    if w in (2024, 2025):
                        for model, sd in (("ecmwf_ifs025", 4.0), ("gem_seamless", 5.0), ("gfs_seamless", 7.0)):
                            pairs.append(("open-meteo-previous-runs", f"open-meteo-previous-runs:{model}", region, rid, day, lead,
                                          "train" if w == 2024 else "test", "liquid", "mid", "strict", max(obs + rng.normal(0, sd), 0.0), obs))
    con = duckdb.connect()
    con.execute("CREATE TABLE t(resort_id VARCHAR, region VARCHAR, tz VARCHAR, local_date DATE, truth_source VARCHAR, obs DOUBLE, winter INTEGER)")
    con.executemany("INSERT INTO t VALUES (?,?,?,?,?,?,?)", truth)
    con.execute(f"COPY t TO '{tmp / 'truth_daily.parquet'}' (FORMAT parquet)")
    con.execute("""CREATE TABLE e(source_label VARCHAR, resort_id VARCHAR, issue_key VARCHAR, lead_day INTEGER,
                   local_date DATE, win INTEGER, n_mem INTEGER, mean DOUBLE)""")
    con.executemany("INSERT INTO e VALUES (?,?,?,?,?,?,?,?)", dyn)
    con.execute(f"COPY e TO '{tmp / 'longrange_tmp' / 'dyn-test.parquet'}' (FORMAT parquet)")
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, region VARCHAR, resort_id VARCHAR, local_date DATE,
                   lead_day INTEGER, split VARCHAR, space VARCHAR, tier VARCHAR, pair_quality VARCHAR, fc_amount DOUBLE, obs DOUBLE)""")
    con.executemany("INSERT INTO p VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", pairs)
    con.execute(f"COPY p TO '{tmp / 'pairs.parquet'}' (FORMAT parquet)")


with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    build(tmp)
    ensmean.main(tmp)
    rep = (tmp / "ensmean_report.md").read_text()
    fac = json.loads((tmp / "ensmean.json").read_text())["factors"]
    f = fac["gefs"]["pooled"]["3"]
    assert 1.5 < f < 1.8, f"GEFS pooled factor should be ~1.67, got {f}"
    assert 0.9 < fac["ecmwf_ifs_ens"]["pooled"]["3"] < 1.1, fac["ecmwf_ifs_ens"]["pooled"]
    assert fac["gefs"]["winters"] == list(GEFS_WINTERS)
    assert "## Verdict" in rep and "snow-forecast" not in rep.lower()

    # corrected beats raw on every GEFS winter at 10 mm/day, leads 1-3 (read the judged table directly)
    con = duckdb.connect()
    ensmean.load_ens(con, tmp)
    ensmean.lowo_correct(con)
    _, summary = ensmean.judge_ens(con)
    cells = [s for s in summary if s["model"] == "gefs" and s["t"] == 10.0 and s["leads"] == "1-3"]
    assert len(cells) == len(GEFS_WINTERS)
    for s in cells:
        assert s["csi_corr"] > s["csi_raw"], f"winter {s['winter']}: corrected {s['csi_corr']} !> raw {s['csi_raw']}"

    # leave-one-winter-out really leaves the winter out: a winter with a wildly different bias must not
    # pull its own factor. Make 2025 read 3x too high and check its correction does NOT undo that.
    con.execute("UPDATE ens SET fc = fc * 5 WHERE model = 'gefs' AND winter = 2025")
    con.execute("DROP TABLE ens_c")
    ensmean.lowo_correct(con)
    raw, corr, obs = con.execute("""SELECT sum(fc), sum(fcc), sum(obs) FROM ens_c
                                    WHERE model = 'gefs' AND winter = 2025 AND lead = 3""").fetchone()
    assert corr / obs > 2.0, f"2025 must stay over-forecast after correction from other winters, got {corr / obs}"

# one winter only → loud stop
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    build(tmp, ec_winters=(2025,))
    try:
        ensmean.main(tmp)
    except SystemExit as e:
        assert "at least 2" in str(e), e
    else:
        raise AssertionError("a model with one winter must stop the run")

print("ensmean: ok")
