#!/usr/bin/env python3
"""Synthetic-archive test for build.py.  python3 scripts/verify/test_build.py

Alta (America/Denver) gets one storm: 20 mm of water / 25 cm of snow on
2025-01-03 local. Checks: pro-rata day split, partial days dropped (never
zero), SNOTEL start-of-day alignment chosen from the data, Palisades' two
slugs combined with max, the resort-report "following day" rule, lead days,
and hit counting.
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).parent))
from build import build  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
UTC = timezone.utc
MST = timedelta(hours=-7)
PST = timedelta(hours=-8)
COLS = ["source", "kind", "resort_id", "tier", "elevation_m", "lat", "lon", "station_id", "issued_at", "fetched_at",
        "valid_start", "valid_end", "period_label", "variable", "value", "value_text", "unit", "model", "member",
        "run_id", "parser_version"]


def row(**k):
    return {c: k.get(c) for c in COLS}


def local(d, h, off):  # local wall time → UTC
    return (datetime(2025, 1, d, h, tzinfo=UTC) - off).replace(tzinfo=UTC)


def main():
    rows = []
    fetched = datetime(2025, 2, 1, tzinfo=UTC)
    # SNOTEL: mapping + daily SWE/depth at local-standard midnight; storm on Jan 3 shows at Jan 4 00:00.
    rows.append(row(source="snotel", kind="mapping", resort_id="alta", station_id="766:UT:SNTL", elevation_m=2920,
                    fetched_at=fetched, variable="candidate_distance", value=3.0, value_text="Snowbird"))
    rows.append(row(source="snotel", kind="mapping", resort_id="alta", station_id="999:UT:SNTL", elevation_m=1800,
                    fetched_at=fetched, variable="candidate_distance", value=1.0, value_text="Valley"))
    swe, depth = 300.0, 150.0
    for d in range(1, 11):
        if d == 4:
            swe, depth = swe + 20, depth + 25
        t = local(d, 0, MST)
        for var, v in (("swe", swe), ("snow_depth", depth)):
            rows.append(row(source="snotel", kind="observation", station_id="766:UT:SNTL", fetched_at=fetched,
                            valid_start=t, valid_end=t + timedelta(days=1), period_label="daily", variable=var, value=v))
    # Open-Meteo previous runs: 6 h UTC blocks, Jan 1–10, lead 0 and 1; 20 mm in the block 12–18 UTC Jan 3.
    start = datetime(2025, 1, 1, 0, tzinfo=UTC)
    for i in range(4 * 10):
        vs = start + timedelta(hours=6 * i)
        wet = vs == datetime(2025, 1, 3, 12, tzinfo=UTC)
        for lead in (0, 1):
            for var, v in (("precip", 20.0 if wet else 0.0), ("snow", 14.0 if wet else 0.0)):
                rows.append(row(source="open-meteo-previous-runs", kind="forecast", resort_id="alta", tier="mid",
                                elevation_m=2900, issued_at=vs - timedelta(days=lead), fetched_at=fetched,
                                valid_start=vs, valid_end=vs + timedelta(hours=6), period_label=f"previous_day{lead}",
                                variable=var, value=v, model="ecmwf_ifs025"))
    # Snow-Forecast hindcast for Alta: am/pm/night periods Jan 2–5; 25 cm in Jan 3 pm.
    for d in range(2, 6):
        for lab, h, n in (("am", 6, 6), ("pm", 12, 6), ("night", 18, 12)):
            vs = local(d, h, MST)
            rows.append(row(source="snow-forecast-hindcast", kind="hindcast", resort_id="alta", tier="mid",
                            elevation_m=2900, station_id="Alta", fetched_at=fetched, valid_start=vs,
                            valid_end=vs + timedelta(hours=n), period_label=lab, variable="snow",
                            value=25.0 if (d == 3 and lab == "pm") else 0.0))
    # Spring-forward night written the old way (18:00 MST + 12 real hours = 07:00 MDT):
    # the builder must end it at 06:00 local, not double-cover 06–07 on Mar 9.
    for d, lab, h, n in ((8, "am", 6, 6), (8, "pm", 12, 6), (8, "night", 18, 12), (9, "am", 6, 6),
                         (9, "pm", 12, 6), (9, "night", 18, 12)):
        off = MST if (d == 8) else timedelta(hours=-6)
        vs = (datetime(2025, 3, d, h, tzinfo=UTC) - off).replace(tzinfo=UTC)
        rows.append(row(source="snow-forecast-hindcast", kind="hindcast", resort_id="alta", tier="mid",
                        elevation_m=2900, station_id="Alta", fetched_at=fetched, valid_start=vs,
                        valid_end=vs + timedelta(hours=n), period_label=lab, variable="snow", value=1.0))
    # Palisades: two slugs, one hindcast period each; max must win (30, not 40).
    for slug, v in (("Squaw-Valley", 30.0), ("Alpine-Meadows", 10.0)):
        for d in range(2, 4):
            for lab, h, n in (("am", 6, 6), ("pm", 12, 6), ("night", 18, 12)):
                vs = local(d, h, PST)
                rows.append(row(source="snow-forecast-hindcast", kind="hindcast", resort_id="palisades", tier="mid",
                                elevation_m=2400, station_id=slug, fetched_at=fetched, valid_start=vs,
                                valid_end=vs + timedelta(hours=n), period_label=lab, variable="snow",
                                value=v if (d == 3 and lab == "am") else 0.0))
    # A live Snow-Forecast issue whose first period starts 06:00 local → that day is partial.
    issued = local(5, 11, MST)
    for lab, h, n in (("am", 6, 6), ("pm", 12, 6), ("night", 18, 12)):
        vs = local(6, h, MST)
        rows.append(row(source="snow-forecast", kind="forecast", resort_id="alta", tier="mid", elevation_m=2900,
                        station_id="Alta", issued_at=issued, fetched_at=issued, valid_start=vs,
                        valid_end=vs + timedelta(hours=n), period_label=lab, variable="snow", value=5.0))
    # Resort report for Jan 3: same-day capture (ignored), next-day capture (used), later (fallback, unused).
    day3 = local(3, 0, MST)
    for when, v in ((local(3, 20, MST), 12.0), (local(4, 10, MST), 30.0), (local(5, 10, MST), 28.0)):
        rows.append(row(source="onthesnow", kind="observation", resort_id="alta", station_id="alta", fetched_at=when,
                        valid_start=day3, valid_end=day3 + timedelta(days=1), period_label="daily",
                        variable="reported_daily_snow", value=v))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        arch = tmp / "archive" / "source=x" / "month=2025-01"
        arch.mkdir(parents=True)
        con = duckdb.connect()
        con.execute("SET TimeZone = 'UTC'")
        types = {"elevation_m": "INTEGER", "lat": "DOUBLE", "lon": "DOUBLE", "value": "DOUBLE", "member": "SMALLINT",
                 "issued_at": "TIMESTAMPTZ", "fetched_at": "TIMESTAMPTZ", "valid_start": "TIMESTAMPTZ",
                 "valid_end": "TIMESTAMPTZ"}
        con.execute("CREATE TABLE t(" + ", ".join(f"{c} {types.get(c, 'VARCHAR')}" for c in COLS) + ")")
        con.executemany(f"INSERT INTO t VALUES ({', '.join('?' * len(COLS))})", [[r[c] for c in COLS] for r in rows])
        con.execute(f"COPY t TO '{arch / 'test.parquet'}' (FORMAT parquet)")

        stats = build(tmp / "archive", tmp / "out", ROOT / "src/data/resorts.json")
        q = duckdb.connect()
        q.execute("SET TimeZone = 'UTC'")
        q.execute(f"CREATE VIEW p AS SELECT * FROM read_parquet('{tmp / 'out' / 'pairs.parquet'}')")
        one = lambda sql: q.execute(sql).fetchone()

        assert stats["alignment"]["used"] == "start", stats["alignment"]
        # Pro-rata: the 12–18 UTC block is 05–11 MST, all inside Jan 3.
        fc, obs = one("SELECT fc_amount, obs FROM p WHERE source_label = 'open-meteo-previous-runs:ecmwf_ifs025' "
                      "AND space = 'liquid' AND issue_key = 'previous_day0' AND local_date = DATE '2025-01-03'")
        assert abs(fc - 20) < 1e-9 and obs == 20, (fc, obs)
        # A dry day is a real zero, not missing.
        assert one("SELECT obs FROM p WHERE space = 'liquid' AND issue_key = 'previous_day0' "
                   "AND local_date = DATE '2025-01-02'")[0] == 0
        assert one("SELECT lead_day FROM p WHERE issue_key = 'previous_day1' LIMIT 1")[0] == 1
        # Hindcast: lead 0, 25 cm on Jan 3; Jan 2 starts at 06:00 → partial → absent (not zero).
        assert one("SELECT fc_amount, lead_day, paid FROM p WHERE source = 'snow-forecast-hindcast' "
                   "AND resort_id = 'alta' AND local_date = DATE '2025-01-03'") == (25.0, 0, True)
        assert one("SELECT count(*) FROM p WHERE source = 'snow-forecast-hindcast' AND resort_id = 'alta' "
                   "AND local_date = DATE '2025-01-02'")[0] == 0
        # DST: Mar 9 is fully covered exactly once (23 h day), so it is a scorable day.
        assert one("SELECT count(*) FROM p WHERE source = 'snow-forecast-hindcast' AND resort_id = 'alta' "
                   "AND local_date = DATE '2025-03-09'")[0] == 1
        # Palisades: max of the two faces.
        assert one("SELECT fc_amount FROM p WHERE resort_id = 'palisades' AND local_date = DATE '2025-01-03'")[0] == 30
        # Live issue: its only day is partial → no rows at all.
        assert one("SELECT count(*) FROM p WHERE source = 'snow-forecast'")[0] == 0
        # Resort report: the next-day capture.
        assert one("SELECT DISTINCT ots_reported_cm, ots_next_day FROM p WHERE resort_id = 'alta' "
                   "AND local_date = DATE '2025-01-03'") == (30.0, True)
        # Station pair: the near-elevation station wins over the closer valley one.
        pairs = (tmp / "out" / "station_pairs.csv").read_text()
        assert "766:UT:SNTL" in pairs and "999:UT:SNTL" not in pairs, pairs
        # Scores: one 10 mm event, hit at lead 0.
        s = duckdb.read_parquet(str(tmp / "out" / "scores.parquet"))
        hit = q.execute(f"SELECT hits, misses, false_alarms FROM read_parquet('{tmp / 'out' / 'scores.parquet'}') "
                        "WHERE source_label LIKE 'open-meteo-previous%' AND space = 'liquid' AND threshold = 10 "
                        "AND lead_day = 0 AND region = 'ALL'").fetchone()
        assert hit == (1, 0, 0), hit
        log = (tmp / "out" / "log.txt").read_text()
        assert "snow-forecast" not in log, "paid source named in the public log"
        assert "report" and "PRIVATE" in (tmp / "out" / "report.md").read_text()
        del s
    print("verify build: all checks passed")


if __name__ == "__main__":
    main()
