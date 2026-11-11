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


def write_archive(rows, root: Path) -> None:
    arch = root / "source=x" / "month=2025-01"
    arch.mkdir(parents=True)
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    types = {"elevation_m": "INTEGER", "lat": "DOUBLE", "lon": "DOUBLE", "value": "DOUBLE", "member": "SMALLINT",
             "issued_at": "TIMESTAMPTZ", "fetched_at": "TIMESTAMPTZ", "valid_start": "TIMESTAMPTZ",
             "valid_end": "TIMESTAMPTZ"}
    con.execute("CREATE TABLE t(" + ", ".join(f"{c} {types.get(c, 'VARCHAR')}" for c in COLS) + ")")
    con.executemany(f"INSERT INTO t VALUES ({', '.join('?' * len(COLS))})", [[r[c] for c in COLS] for r in rows])
    con.execute(f"COPY t TO '{arch / 'test.parquet'}' (FORMAT parquet)")


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
            for var, v in (("precip", 20.0 if wet else 0.0), ("snow", 14.0 if wet else 0.0),
                           ("temp_min", -10.0 if wet else 0.0), ("temp_max", -6.0 if wet else 2.0)):
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
    # Temperature truth: SNOTEL daily TMAX 0 °C / TMIN −8 °C at the 2,920 m station, Jan 1–10.
    for d in range(1, 11):
        t = local(d, 0, MST)
        for var, v in (("temp_max", 0.0), ("temp_min", -8.0)):
            rows.append(row(source="snotel", kind="observation", station_id="766:UT:SNTL", fetched_at=fetched,
                            valid_start=t, valid_end=t + timedelta(days=1), period_label="daily", variable=var, value=v))
    # NWS hourly temperature, 5 °C all day Jan 7, grid cell at 2,520 m, issued Jan 6 → lead 1.
    nws_issued = local(6, 12, MST)
    for h in range(0, 48):
        vs = local(7, 0, MST) + timedelta(hours=h)
        rows.append(row(source="nws", kind="forecast", resort_id="alta", elevation_m=2520, station_id="SLC/1,1",
                        issued_at=nws_issued, fetched_at=nws_issued, valid_start=vs, valid_end=vs + timedelta(hours=1),
                        variable="temp", value=5.0))
    # Snow-Forecast temperatures, issued Jan 6 11:00, covering Jan 7 fully (night of the 6th → 06:00 the 7th).
    sf_issued = local(6, 11, MST)
    for d, lab, h, n, tx, tn in ((6, "night", 18, 12, -2.0, -6.0), (7, "am", 6, 6, 1.0, -1.0), (7, "pm", 12, 6, 3.0, 0.0),
                                 (7, "night", 18, 12, -2.0, -6.0)):
        vs = local(d, h, MST)
        for var, v in (("temp_max", tx), ("temp_min", tn)):
            rows.append(row(source="snow-forecast", kind="forecast", resort_id="alta", tier="mid", elevation_m=2900,
                            station_id="Alta", issued_at=sf_issued, fetched_at=sf_issued, valid_start=vs,
                            valid_end=vs + timedelta(hours=n), period_label=lab, variable=var, value=v))
    # Resort report for Jan 3: same-day capture (ignored), next-day capture (used), later (fallback, unused).
    day3 = local(3, 0, MST)
    for when, v in ((local(3, 20, MST), 12.0), (local(4, 10, MST), 30.0), (local(5, 10, MST), 28.0)):
        rows.append(row(source="onthesnow", kind="observation", resort_id="alta", station_id="alta", fetched_at=when,
                        valid_start=day3, valid_end=day3 + timedelta(days=1), period_label="daily",
                        variable="reported_daily_snow", value=v))

    # BC ASWS (Revelstoke, America/Vancouver): hourly pillow, 20 mm / 25 cm gained 04:00–08:00 PST on Jan 3.
    rows.append(row(source="bc-asws", kind="mapping", resort_id="revelstoke", station_id="2A06P", elevation_m=1850,
                    fetched_at=fetched, variable="candidate_distance", value=8.0, value_text="Mount Revelstoke"))
    storm_start, storm_end = local(3, 4, PST), local(3, 8, PST)
    t = local(1, 0, PST) - timedelta(hours=2)
    while t < local(11, 3, PST):
        frac = min(max((t - storm_start) / (storm_end - storm_start), 0), 1)
        jitter = 0.4 if t.hour % 2 else -0.4  # pillow noise the midnight median must ride over
        for var, base, gain in (("swe", 400.0, 20.0), ("snow_depth", 200.0, 25.0)):
            rows.append(row(source="bc-asws", kind="observation", station_id="2A06P", fetched_at=fetched,
                            valid_start=t, valid_end=t, period_label="hourly", variable=var,
                            value=base + gain * frac + (jitter if var == "swe" else 0)))
        t += timedelta(hours=1)
    for i in range(4 * 10):
        vs = start + timedelta(hours=6 * i)
        wet = vs == datetime(2025, 1, 3, 12, tzinfo=UTC)  # 04–10 PST Jan 3
        rows.append(row(source="open-meteo-previous-runs", kind="forecast", resort_id="revelstoke", tier="mid",
                        elevation_m=1900, issued_at=vs, fetched_at=fetched, valid_start=vs,
                        valid_end=vs + timedelta(hours=6), period_label="previous_day0", variable="precip",
                        value=20.0 if wet else 0.0, model="ecmwf_ifs025"))
    for d in range(2, 6):
        for lab, h, n in (("am", 6, 6), ("pm", 12, 6), ("night", 18, 12)):
            vs = local(d, h, PST)
            rows.append(row(source="snow-forecast-hindcast", kind="hindcast", resort_id="revelstoke", tier="mid",
                            elevation_m=1900, station_id="Revelstoke", fetched_at=fetched, valid_start=vs,
                            valid_end=vs + timedelta(hours=n), period_label=lab, variable="snow", value=0.0))

    # Window truth (windows.py). CoCoRaHS: a valley observer (1500 m vs Alta's 2900 m mid
    # tier) reading at 07:00 MST, 24 h windows. 10 mm in the window ending Jan 4 07:00 MST.
    rows.append(row(source="cocorahs", kind="mapping", resort_id="alta", station_id="UT-SL-1", elevation_m=1500,
                    fetched_at=fetched, variable="candidate_distance", value=12.0, value_text="Valley observer"))
    for d in range(2, 11):
        end = local(d, 7, MST)
        rows.append(row(source="cocorahs", kind="observation", station_id="UT-SL-1", elevation_m=1500,
                        fetched_at=fetched, valid_start=end - timedelta(days=1), valid_end=end, period_label="24h",
                        variable="precip_24h", value=10.0 if d == 4 else 0.0, unit="mm"))
    # SNODAS: 06 UTC snowpack snapshots at Alta's cell; +18 mm SWE from Jan 3 06Z to Jan 4 06Z.
    for d in range(1, 7):
        t6 = datetime(2025, 1, d, 6, tzinfo=UTC)
        for var, v, u in (("swe", 300.0 + (18 if d >= 4 else 0), "mm"), ("swe_max_5x5", 320.0 + (25 if d >= 4 else 0), "mm")):
            rows.append(row(source="snodas", kind="analysis", resort_id="alta", station_id="snodas:10_20",
                            fetched_at=fetched, valid_start=t6, valid_end=t6, period_label="instant",
                            variable=var, value=v, unit=u))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        write_archive(rows, tmp / "archive")

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
        # Precip-weighted temperature: the storm block's −8 °C, not the day's mean.
        assert one("SELECT fc_temp_c FROM p WHERE issue_key = 'previous_day0' AND space = 'liquid'AND resort_id = 'alta' "
                   "AND local_date = DATE '2025-01-03'")[0] == -8
        # Dry day: plain mean of block mid-temperatures (1 °C).
        assert one("SELECT fc_temp_c FROM p WHERE issue_key = 'previous_day0' AND space = 'liquid'AND resort_id = 'alta' "
                   "AND local_date = DATE '2025-01-05'")[0] == 1
        # A dry day is a real zero, not missing.
        assert one("SELECT obs FROM p WHERE space = 'liquid' AND issue_key = 'previous_day0'AND resort_id = 'alta' "
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
        # Scores: one 10 mm event at each resort, both hit at lead 0.
        s = duckdb.read_parquet(str(tmp / "out" / "scores.parquet"))
        hit = q.execute(f"SELECT hits, misses, false_alarms FROM read_parquet('{tmp / 'out' / 'scores.parquet'}') "
                        "WHERE source_label LIKE 'open-meteo-previous%' AND space = 'liquid' AND threshold = 10 "
                        "AND lead_day = 0 AND region = 'ALL'").fetchone()
        assert hit == (2, 0, 0), hit  # Alta (SNOTEL) and Revelstoke (BC pillow)
        # BC pillow: the storm day gets the full 20 mm, the days either side get 0 despite ±0.4 mm noise.
        bc = q.execute("SELECT local_date, obs, truth_source FROM p WHERE resort_id = 'revelstoke' AND space = 'liquid' "
                       "AND source = 'open-meteo-previous-runs' AND local_date BETWEEN DATE '2025-01-02' AND DATE '2025-01-04' "
                       "ORDER BY local_date").fetchall()
        assert [(str(d), o, src) for d, o, src in bc] == [("2025-01-02", 0, "bc-asws"), ("2025-01-03", 20, "bc-asws"),
                                                            ("2025-01-04", 0, "bc-asws")], bc
        assert one("SELECT obs FROM p WHERE resort_id = 'revelstoke' AND space = 'snow' "
                   "AND local_date = DATE '2025-01-03' LIMIT 1")[0] == 25
        assert stats["resorts_with_strict_pair_bc"] == 1, stats
        assert "BC ASWS check" in (tmp / "out" / "log.txt").read_text()
        # ---- window truth
        w = lambda sql: q.execute(sql.replace("{W}", f"read_parquet('{tmp / 'out' / 'wpairs.parquet'}')")).fetchall()
        # CoCoRaHS window Jan 3 07:00 → Jan 4 07:00 MST (14 UTC → 14 UTC) holds 4 of the storm block's
        # 6 hours (12–18 UTC Jan 3): 2/3 × 20 mm. The window before holds the other 2 hours.
        got = w("SELECT fc, obs, elev_class FROM {W} WHERE product = 'cocorahs' AND issue_key = 'previous_day0' "
                "AND we = TIMESTAMPTZ '2025-01-04 14:00:00+00'")
        assert len(got) == 1 and abs(got[0][0] - 40 / 3) < 1e-6 and got[0][1] == 10 and got[0][2] == "valley", got
        got = w("SELECT fc FROM {W} WHERE product = 'cocorahs' AND issue_key = 'previous_day0' "
                "AND we = TIMESTAMPTZ '2025-01-03 14:00:00+00'")
        assert abs(got[0][0] - 20 / 3) < 1e-6, got
        # SNODAS: the 06Z→06Z window takes the whole block; truth is the SWE gain, class grid.
        got = w("SELECT fc, obs, elev_class FROM {W} WHERE product = 'snodas-swe-gain' AND issue_key = 'previous_day0' "
                "AND we = TIMESTAMPTZ '2025-01-04 06:00:00+00'")
        assert got == [(20.0, 18.0, "grid")], got
        assert w("SELECT obs FROM {W} WHERE product = 'snodas-swe-gain-max5x5' "
                 "AND we = TIMESTAMPTZ '2025-01-04 06:00:00+00' LIMIT 1") == [(25.0,)]
        # Valley truth judges only the low thresholds; the grid judges all three.
        ts = (tmp / "out" / "truth_scores.csv").read_text()
        thr = lambda prod: sorted({float(l.split(",")[ts.split("\n")[0].split(",").index("threshold")])
                                   for l in ts.splitlines()[1:] if l.startswith(prod + ",") and ",liquid," in l})
        assert thr("cocorahs") == [2.5, 10.0], thr("cocorahs")
        assert thr("snodas-swe-gain") == [2.5, 10.0, 20.0], thr("snodas-swe-gain")
        # The height gap, learned: the valley got 10 mm on the day the slope pillow got 20.
        er = q.execute(f"SELECT ratio_to_slope, elev_class FROM read_csv_auto('{tmp / 'out' / 'elevation_ratios.csv'}') "
                       "WHERE product = 'cocorahs' AND region = 'ALL' AND space = 'liquid'").fetchall()
        assert er == [(0.5, "valley")], er
        assert (tmp / "out" / "truth_windows.md").exists() and (tmp / "out" / "matched_scores.csv").exists()

        log = (tmp / "out" / "log.txt").read_text()
        assert "snow-forecast" not in log, "paid source named in the public log"
        assert "report" and "PRIVATE" in (tmp / "out" / "report.md").read_text()
        # Temperature: forecasts moved to the station's 2,920 m at 6.5 °C/km.
        q.execute(f"CREATE VIEW tp AS SELECT * FROM read_parquet('{tmp / 'out' / 'temp_pairs.parquet'}')")
        fa, fr, ob = one("SELECT fc_adj, fc_raw, obs FROM tp WHERE source = 'open-meteo-previous-runs' AND var = 'hi' "
                         "AND issue_key = 'previous_day0' AND local_date = DATE '2025-01-05'")
        assert fr == 2.0 and abs(fa - (2.0 - 0.13)) < 1e-9 and ob == 0, (fa, fr, ob)
        fa, ld = one("SELECT fc_adj, lead_day FROM tp WHERE source = 'nws' AND var = 'hi' AND local_date = DATE '2025-01-07'")
        assert abs(fa - (5.0 - 2.6)) < 1e-9 and ld == 1, (fa, ld)
        # Snow-Forecast: high from the periods, low includes the night that ends 06:00 on the 7th.
        assert one("SELECT fc_raw FROM tp WHERE source = 'snow-forecast' AND var = 'hi' AND local_date = DATE '2025-01-07'")[0] == 3
        assert one("SELECT fc_raw FROM tp WHERE source = 'snow-forecast' AND var = 'lo' AND local_date = DATE '2025-01-07'")[0] == -6
        # Jan 6 is only 18 h covered by Snow-Forecast → no high, not a wrong high.
        assert one("SELECT count(*) FROM tp WHERE source = 'snow-forecast' AND local_date = DATE '2025-01-06'")[0] == 0
        m = {r[0]: r[1] for r in q.execute(f"SELECT source_label, mae_f FROM read_csv_auto('{tmp / 'out' / 'temp_matched.csv'}') "
                                             "WHERE var = 'hi' AND lead_day = 1").fetchall()}
        assert abs(m["nws"] - 2.4 * 1.8) < 1e-6, m
        assert abs(m["snow-forecast"] - 2.87 * 1.8) < 1e-6, m
        # Equal-weight public blend = mean of NWS (2.4) and ECMWF lead 1 (1.87).
        assert abs(m["blend:public-equal"] - (2.4 + 1.87) / 2 * 1.8) < 1e-6, m
        assert stats["temp_obs_days"] == 10, stats
        assert "Temperature" in (tmp / "out" / "report.md").read_text()
        assert "snow-forecast" not in (tmp / "out" / "log.txt").read_text()
        del s
    # A truth row in the wrong unit must stop the build, not be scored.
    rows.append(row(source="cocorahs", kind="observation", station_id="UT-SL-1", elevation_m=1500, fetched_at=fetched,
                    valid_start=local(4, 7, MST) - timedelta(days=1), valid_end=local(4, 7, MST), period_label="24h",
                    variable="new_snow_24h", value=4.0, unit="in"))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        write_archive(rows, tmp / "archive")
        try:
            build(tmp / "archive", tmp / "out", ROOT / "src/data/resorts.json")
            raise AssertionError("a row in inches was accepted")
        except SystemExit as e:
            assert "unexpected units" in str(e) and "new_snow_24h" in str(e), e
    print("verify build: all checks passed")


if __name__ == "__main__":
    main()
