#!/usr/bin/env python3
"""Synthetic test for canada_water.py.  python3 scripts/model/test_canada_water.py

Case 1: every model forecasts HALF of what fell (train and test), v1's Canada factor is 1.0.
  → raw volume 0.50; the refit factor is near 2 (shrunk toward the pooled 1.0, clamped at 2);
    the refit wins on all three rules → BETTER.
Case 2: forecasts are right (fc = obs) → the refit stays at 1.0 → no CSI gain → "not shown".
Also: a paid source in the pairs never reaches the report; lead 0 has no v1 column; NBM shows in live;
the Whistler check uses the highest candidate station with data this season; no pairs → a stub report.
"""
import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import canada_water as cw  # noqa: E402

MODELS = ("ecmwf_ifs025", "gem_seamless", "gfs_seamless")


def winter(d):
    return d.year if d.month >= 7 else d.year - 1


def split(d):
    return {2024: "train", 2025: "test"}.get(winter(d), "live")


def make(tmp: Path, scale: float):
    rng = np.random.default_rng(1)
    days = ([date(2024, 12, 1) + timedelta(i) for i in range(120)] + [date(2025, 12, 1) + timedelta(i) for i in range(120)]
            + [date(2026, 11, 15) + timedelta(i) for i in range(12)])
    obs = {(r, d): float(np.round(rng.gamma(0.8, 12.0), 1)) if rng.random() < 0.55 else 0.0
           for r in ("whistler", "fernie") for d in days}
    pairs, truth = [], []
    for (rid, d), o in obs.items():
        st = {"whistler": ("1108906", "WHISTLER ROUNDHOUSE", 1835), "fernie": ("1152850", "FERNIE", 1000)}[rid]
        live = split(d) == "live"
        for lead in range(0, 8):
            for m in MODELS:
                pairs.append(("open-meteo-previous-runs", f"open-meteo-previous-runs:{m}", m, rid, "Canada", lead, d,
                              o * scale, st[0], st[1], 3.0, st[2], 50, None if (live and d >= date(2026, 11, 22)) else o,
                              None, winter(d), split(d)))
            if live and lead <= 2:
                pairs.append(("nbm", "nbm:nbm", "nbm", rid, "Canada", lead, d, o, st[0], st[1], 3.0, st[2], 50,
                              None if d >= date(2026, 11, 22) else o, None, winter(d), split(d)))
            # Paid rows that must never reach the report.
            pairs.append(("snow-forecast", "snow-forecast", "", rid, "Canada", lead, d, o, st[0], st[1], 3.0, st[2], 50,
                          o, None, winter(d), split(d)))
        if not (live and d >= date(2026, 11, 22)):
            truth.append((rid, st[0], st[1], 3.0, st[2], 50, True, 0.9, True, d, o, "T" if o == 0 else None, winter(d)))
    # A lower Whistler candidate that is not the check station.
    for d in days:
        truth.append(("whistler", "1108914", "WHISTLER NESTERS", 3.0, 659, -1126, False, 0.8, False, d, 1.0, None, winter(d)))
    con = duckdb.connect()
    con.execute("""CREATE TABLE p(source VARCHAR, source_label VARCHAR, model VARCHAR, resort_id VARCHAR, region VARCHAR,
                   lead_day INTEGER, local_date DATE, fc_amount DOUBLE, station_id VARCHAR, station_name VARCHAR,
                   station_km DOUBLE, station_elev_m INTEGER, station_delev_m INTEGER, obs DOUBLE, obs_flag VARCHAR,
                   winter INTEGER, split VARCHAR)""")
    con.executemany("INSERT INTO p VALUES (" + ", ".join("?" * 17) + ")", pairs)
    con.execute(f"COPY p TO '{tmp / 'eccc_pairs.parquet'}' (FORMAT parquet)")
    con.execute("""CREATE TABLE t(resort_id VARCHAR, station_id VARCHAR, station_name VARCHAR, station_km DOUBLE,
                   station_elev_m INTEGER, station_delev_m INTEGER, strict BOOLEAN, coverage DOUBLE, chosen BOOLEAN,
                   local_date DATE, obs DOUBLE, flag VARCHAR, winter INTEGER)""")
    con.executemany("INSERT INTO t VALUES (" + ", ".join("?" * 13) + ")", truth)
    con.execute(f"COPY t TO '{tmp / 'eccc_truth.parquet'}' (FORMAT parquet)")
    blend = {"factors": {f"{m}|{l}|{r}": 1.0 for m in MODELS for l in range(1, 8) for r in ("Canada", "West")},
             "pooled_factors": {f"{m}|{l}": 1.0 for m in MODELS for l in range(1, 8)},
             "weights": {str(l): {m: round(1 / 3, 3) for m in MODELS} for l in range(1, 8)}}
    (tmp / "blend.json").write_text(json.dumps(blend))


def run(scale: float):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        make(tmp, scale)
        cw.main(tmp / "eccc_pairs.parquet", tmp / "blend.json", tmp / "out")
        return (tmp / "out" / "canada_water_report.md").read_text(), json.loads((tmp / "out" / "canada_water.json").read_text())


def main():
    rep, js = run(0.5)
    low = rep.lower()
    assert "snow-forecast" not in low and "paid)" not in low, "paid source in the public report"
    f = js["refit_factors"]["ecmwf_ifs025|1|Canada"]
    assert abs(f["raw_ratio"] - 2.0) < 1e-6, f
    w = f["wet_days"] / (f["wet_days"] + 40)
    assert abs(f["refit"] - round(min(w * 2.0 + (1 - w) * 1.0, 2.0), 3)) < 1e-6 and f["refit"] > 1.7, f
    head = next(r for r in js["judgement"] if r["leads"] == "1-7")
    assert abs(head["vol_b_raw"] - 0.5) < 1e-9 and abs(head["vol_b_v1"] - 0.5) < 1e-9, head
    assert abs(head["vol_b_refit"] - 1) < abs(head["vol_b_v1"] - 1), head
    assert head["a"] and head["b"] and head["c"] and head["better"], head
    assert "**Headline (leads 1-7): BETTER.**" in rep
    # Pooled table: ECMWF, test, leads 1-2 → raw volume 0.50; lead 0 has no v1 column.
    row = next(l for l in rep.splitlines() if l.startswith("| test | ECMWF | 1-2 |"))
    assert row.split(" | ")[6].startswith("0.50 (") and row.split(" | ")[7].startswith("0.50 ("), row
    row0 = next(l for l in rep.splitlines() if l.startswith("| test | ECMWF | 0 |"))
    assert row0.split(" | ")[7] == "—", row0
    assert any(l.startswith("| live | NBM | 0 |") for l in rep.splitlines()), "NBM missing from live"
    # Whistler check: the Roundhouse (highest with data), not the valley station.
    assert "Check station: **WHISTLER ROUNDHOUSE** (1108906, 1835 m)" in rep, rep[rep.find("## Whistler"):][:800]
    assert "| 2026-11-23 | — |" in rep  # a forecast day with no observation yet: missing, never zero
    assert "Gauge undercatch" in rep and "Decision rule" in rep
    # Per-resort table present for both resorts.
    assert "| fernie | test | GEM | 3-5 |" in rep and "| whistler | train | GFS | 6-7 |" in rep

    rep2, js2 = run(1.0)
    head2 = next(r for r in js2["judgement"] if r["leads"] == "1-7")
    assert abs(js2["refit_factors"]["gfs_seamless|4|Canada"]["refit"] - 1.0) < 1e-9
    assert not head2["a"] and not head2["better"], head2
    assert "**Headline (leads 1-7): not shown.**" in rep2

    with tempfile.TemporaryDirectory() as tmp:
        cw.main(Path(tmp) / "missing.parquet", Path(tmp) / "blend.json", Path(tmp) / "out")
        assert "No eccc_pairs.parquet" in (Path(tmp) / "out" / "canada_water_report.md").read_text()
    print("canada water: all checks passed")


if __name__ == "__main__":
    main()
