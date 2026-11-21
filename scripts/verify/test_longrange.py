#!/usr/bin/env python3
"""Synthetic test for longrange.py.  python3 scripts/verify/test_longrange.py

Three Utah resorts, a train winter (Dec 2024) and a test winter (Dec 2025),
storms on random days. Two dynamical-ens "models":
- gefs: every member is exactly right at every lead → BSS 1, skill through the last lead.
- ecmwf_ifs_ens: members ignore the weather (random, at the climate rate) → no skill.
Also checks: a partial first local day is absent (lead 0 never scored for a
00z init in Denver), 72 h windows exist, nothing paid gets in, and the
resort-vs-region comparison: gefs storms differ by resort, so the resort's own
probability beats the regional average.
"""
import json
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
UTC = timezone.utc
RESORTS = ["alta", "snowbird", "brighton"]
LEADS = 6
MEMBERS = 10


def main():
    rng = np.random.default_rng(1)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        out = td / "out"
        out.mkdir()
        # Four winters: 2022-23 and 2023-24 (history, w2022/w2023), 2024-25 (train), 2025-26 (test).
        days = [date(y, 12, 1) + timedelta(d) for y in (2022, 2023, 2024, 2025) for d in range(40)]
        obs = {(r, d): (15.0 if rng.random() < 0.3 else 0.0) for r in RESORTS for d in days}
        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        con.execute("CREATE TABLE t(resort_id VARCHAR, region VARCHAR, tz VARCHAR, local_date DATE, truth_source VARCHAR, obs DOUBLE, winter INTEGER)")
        con.executemany("INSERT INTO t VALUES (?, 'Utah', 'America/Denver', ?, 'snotel', ?, ?)",
                        [(r, d, v, d.year if d.month >= 7 else d.year - 1) for (r, d), v in obs.items()])
        con.execute(f"COPY t TO '{out / 'truth_daily.parquet'}' (FORMAT parquet)")
        # pairs.parquet with the columns longrange reads, no rows of the sources it takes.
        con.execute("""CREATE TABLE p(source VARCHAR, paid BOOLEAN, space VARCHAR, tier VARCHAR, fc_amount DOUBLE,
                       source_label VARCHAR, resort_id VARCHAR, issue_key VARCHAR, local_date DATE, lead_day INTEGER, member INTEGER)""")
        con.execute("INSERT INTO p VALUES ('snow-forecast', true, 'liquid', 'mid', 5, 'snow-forecast', 'alta', 'x', '2025-12-05', 1, -1)")
        con.execute(f"COPY p TO '{out / 'pairs.parquet'}' (FORMAT parquet)")

        rows = []
        for d0 in days:
            init = datetime(d0.year, d0.month, d0.day, tzinfo=UTC)  # 00z = previous evening in Denver
            for lead in range(0, LEADS + 2):  # +1: day LEADS needs the next day's 06–12Z block
                vd = (init - timedelta(hours=7)).date() + timedelta(lead)  # resort-local valid date
                for r in RESORTS:
                    o = obs.get((r, vd))
                    for model in ("gefs", "ecmwf_ifs_ens"):
                        for m in range(MEMBERS):
                            amt = o if model == "gefs" else (15.0 if rng.random() < 0.3 else 0.0)
                            if amt is None:
                                amt = 0.0
                            # four 6 h UTC blocks of the local day 07Z→07Z; rain only in 12–18Z and 18–24Z
                            day0 = datetime(vd.year, vd.month, vd.day, 7, tzinfo=UTC)
                            for h0, v in ((-1, 0.0), (5, amt / 2), (11, amt / 2), (17, 0.0)):
                                vs = day0 + timedelta(hours=h0)
                                if vs < init:
                                    continue
                                rows.append((init, r, model, m, vs, vs + timedelta(hours=6), v))
        con.execute("""CREATE TABLE d(source VARCHAR, kind VARCHAR, resort_id VARCHAR, issued_at TIMESTAMPTZ, fetched_at TIMESTAMPTZ,
                       valid_start TIMESTAMPTZ, valid_end TIMESTAMPTZ, variable VARCHAR, value DOUBLE, model VARCHAR, member SMALLINT)""")
        con.executemany("INSERT INTO d VALUES ('dynamical-ens', 'forecast', ?, ?, ?, ?, ?, 'precip', ?, ?, ?)",
                        [(r, i, i, vs, ve, v, mo, m) for i, r, mo, m, vs, ve, v in rows])
        # block 01–07Z at 06Z boundary: the -1 h block (06–12Z) straddles 07Z; keep it so day splitting is exercised.
        for mon in ("2022-12", "2023-01", "2023-12", "2024-01", "2024-12", "2025-01", "2025-12", "2026-01"):
            mdir = td / "archive" / "source=dynamical-ens" / f"month={mon}"
            mdir.mkdir(parents=True)
            con.execute(f"""COPY (SELECT * FROM d WHERE strftime(issued_at, '%Y-%m') = '{mon}')
                            TO '{mdir / 'x.parquet'}' (FORMAT parquet)""")
        r = subprocess.run([sys.executable, str(ROOT / "scripts/verify/longrange.py"), str(td / "archive"), str(out),
                            "--resorts", str(ROOT / "src/data/resorts.json")], capture_output=True, text=True)
        assert r.returncode == 0, r.stderr[-3000:]
        s = duckdb.connect()
        sc = lambda q: s.execute(q.replace("SC", f"read_csv_auto('{out / 'longrange_scores.csv'}')")).fetchall()
        perf = sc("SELECT min(bss), max(bss) FROM SC WHERE source_label = 'dynamical-ens:gefs' AND split = 'test' AND macro = 'ALL' AND events > 0")[0]
        assert abs(perf[0] - 1) < 1e-9 and abs(perf[1] - 1) < 1e-9, perf
        noise = sc("""SELECT max(bss_lo) FROM SC WHERE source_label = 'dynamical-ens:ecmwf_ifs_ens' AND split = 'test'
                      AND macro = 'ALL' AND win = 24 AND threshold = 10""")[0][0]
        assert noise < 0.05, f"random members should show no skill, got bss_lo {noise}"
        leads = [x[0] for x in sc("SELECT DISTINCT lead_day FROM SC WHERE source_label = 'dynamical-ens:gefs' ORDER BY 1")]
        assert 0 not in leads and leads[0] == 1 and leads[-1] == LEADS, leads
        wins = {x[0] for x in sc("SELECT DISTINCT win FROM SC")}
        assert wins == {24, 72}, wins
        assert not sc("SELECT 1 FROM SC WHERE source_label LIKE 'snow-forecast%'"), "paid source in long-range scores"
        hz = s.execute(f"""SELECT skill_through_day, resort_beats_region_through_day FROM read_csv_auto('{out / 'longrange_horizon.csv'}')
                           WHERE source_label = 'dynamical-ens:gefs' AND split = 'test' AND win = 24 AND threshold = 10""").fetchall()
        assert hz == [(LEADS, LEADS)], hz
        hz72 = s.execute(f"""SELECT skill_through_day FROM read_csv_auto('{out / 'longrange_horizon.csv'}')
                             WHERE source_label = 'dynamical-ens:gefs' AND split = 'test' AND win = 72 AND threshold = 10""").fetchall()
        assert hz72 == [(LEADS,)], f"72 h horizon counts from day 3: {hz72}"
        cal = s.execute(f"""SELECT min(gain), count(*) FROM read_csv_auto('{out / 'longrange_calibration.csv'}')
                            WHERE fit_source = 'dynamical-ens:ecmwf_ifs_ens' AND fit = 'train' AND judged = 'test'
                              AND win = 24 AND threshold = 2.5""").fetchall()[0]
        assert cal[1] > 0 and cal[0] > 0, f"calibrating a no-skill ensemble toward climatology must help: {cal}"
        # Older winters are scored and the leave-one-winter-out calibration runs (four winters).
        wb = {x[0] for x in s.execute(f"SELECT DISTINCT winter FROM read_csv_auto('{out / 'longrange_winter_bss.csv'}')").fetchall()}
        assert wb == {"w2022", "w2023", "train", "test"}, wb
        lw = s.execute(f"""SELECT count(*), min(gain), max(winters) FROM read_csv_auto('{out / 'longrange_calibration_lowo.csv'}')
                           WHERE win = 24 AND threshold = 10""").fetchall()[0]
        assert lw[0] > 0 and lw[2] == 4 and lw[1] > -0.05, f"LOWO on perfect members: {lw}"
        assert json.loads((out / "ens_calib_lowo.json").read_text())["judged"] is True
        cj = json.loads((out / "ens_calib.json").read_text())
        assert cj["cells"] and all(abs(c["b"]) < 0.5 for c in cj["cells"]
                                   if c["source"] == "dynamical-ens:ecmwf_ifs_ens" and c["window_h"] == 24
                                   and c["threshold_mm"] == 2.5), "no-skill members should get a slope near 0"
        assert "Useful horizon" in (out / "longrange_report.md").read_text()
    print("test_longrange: ok")


if __name__ == "__main__":
    main()
