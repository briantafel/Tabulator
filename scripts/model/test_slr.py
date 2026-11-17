#!/usr/bin/env python3
"""Synthetic test for slr.py v2. Truth: CoCoRaHS-style station windows with new
snow AND water, true SLR = 12 − 0.6·T at the station, stations 800 m below the
Snow-Forecast mid elevation (so the station is 5.2 °C warmer than the slope).
The fit must recover the line at STATION temperature, beat 7:1 at 10 cm on
the judge winter (promoted), and compare against a Snow-Forecast hindcast.
    python3 scripts/model/test_slr.py
"""
import json
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from slr import main  # noqa: E402

PREV = "open-meteo-previous-runs"


def make_tables(out: Path) -> None:
    rng = np.random.default_rng(3)
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    con.execute("""CREATE TABLE wpairs(resort_id VARCHAR, region VARCHAR, product VARCHAR, truth_source VARCHAR,
        space VARCHAR, station_id VARCHAR, station_km DOUBLE, st_elev INTEGER, delev_mid INTEGER, elev_class VARCHAR,
        ws TIMESTAMPTZ, we TIMESTAMPTZ, obs DOUBLE, source VARCHAR, source_label VARCHAR, issue_key VARCHAR,
        lead_day INTEGER, fc DOUBLE, split VARCHAR)""")
    con.execute("""CREATE TABLE pairs(source VARCHAR, source_label VARCHAR, resort_id VARCHAR, tier VARCHAR,
        space VARCHAR, issue_key VARCHAR, lead_day INTEGER, local_date DATE, fc_temp_c DOUBLE, split VARCHAR)""")
    W, P = [], []
    for split, start in (("train", date(2024, 12, 1)), ("test", date(2025, 12, 1))):
        for d in range(140):
            day = start + timedelta(days=d)
            for resort in ("alta", "snowbird", "vail", "jackson-hole", "kirkwood", "heavenly"):
                maritime = resort in ("kirkwood", "heavenly")
                t_mid = rng.uniform(-12, -3) if maritime else rng.uniform(-18, -3)
                t_st = t_mid + 0.0065 * 800
                water = float(rng.choice([0, 0, 1, 4, 8, 15, 25]))
                true = (8 - 0.3 * t_st) if maritime else (12 - 0.6 * t_st)
                snow = water * true / 10 * rng.uniform(0.9, 1.1) if t_st <= 0 else 0.0
                ws = datetime(day.year, day.month, day.day, 14, tzinfo=timezone.utc)
                we = ws + timedelta(hours=24)
                st = f"cocorahs:{resort}"
                base = (resort, "Utah", "cocorahs", "cocorahs")
                tail = (st, 5.0, 2100, -800, "valley", ws, we)
                for lead in range(0, 8):
                    ik = f"previous_day{lead}"
                    fw = water * rng.uniform(0.8, 1.2)
                    W.append(base + ("liquid",) + tail + (water, PREV, f"{PREV}:ecmwf_ifs025", ik, lead, fw, split))
                    W.append(base + ("snow",) + tail + (snow, PREV, f"{PREV}:ecmwf_ifs025", ik, lead, fw * 0.7, split))
                    P.append((PREV, f"{PREV}:ecmwf_ifs025", resort, "mid", "liquid", ik, lead, day,
                              t_mid + rng.normal(0, 0.5), split))
                W.append(base + ("liquid",) + tail + (water, "snow-forecast-hindcast", "snow-forecast-hindcast", "h", 0, water, split))
                W.append(base + ("snow",) + tail + (snow, "snow-forecast-hindcast", "snow-forecast-hindcast", "h", 0, snow * 0.6, split))
    con.executemany(f"INSERT INTO wpairs VALUES ({', '.join('?' * 19)})", W)
    con.executemany(f"INSERT INTO pairs VALUES ({', '.join('?' * 10)})", P)
    out.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY wpairs TO '{out / 'wpairs.parquet'}' (FORMAT parquet)")
    con.execute(f"COPY pairs TO '{out / 'pairs.parquet'}' (FORMAT parquet)")


with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "out"
    make_tables(out)
    main(out / "pairs.parquet", out)
    p = json.loads((out / "slr.json").read_text())
    assert p["version"] == "slr-v3", p
    # The Sierra gets its own (shrunk) line, lower than the Rockies', and it is promoted.
    sierra, rock = p["regions"]["Sierra & Cascades"], p["regions"]["Rockies"]
    assert sierra["promoted"] is True and sierra["a"] < rock["a"], p["regions"]
    assert p["region_of"]["kirkwood"] == "Sierra & Cascades"
    # The Rockies line is recovered at STATION temperature (not the slope's): a ≈ 12, b ≈ −0.6.
    assert abs(rock["a_raw"] - 12) < 1.0 and abs(rock["b_raw"] + 0.6) < 0.1, rock
    assert p["promote"].get("1") is True, p["promote"]
    rep = (out / "slr_report.md").read_text()
    assert "Over-forecast by station height" in rep and "| ALL |" in rep.split("Over-forecast")[1], rep
    assert "Ours vs a flat 7:1" in rep and "snow-forecast-hindcast" in rep and "OWN LINE promoted" in rep, rep
print("slr: all checks passed")
