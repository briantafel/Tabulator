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
    assert p["phase"] == {"1-3": "temp", "4-7": "temp"}, p["phase"]  # no model snowfall here
    assert "Phase: rain or snow" in rep
    assert "warm" in p and set(p["warm"]["promote"]) == {"1-3", "4-7"} and "Warm days" in rep, p.get("warm")
    assert "Ours vs a flat 7:1" in rep and "snow-forecast-hindcast" in rep and "OWN LINE promoted" in rep, rep
print("slr: all checks passed")


# Phase: no model snowfall in the data → today's rule everywhere; phase_frac edge cases.
import numpy as _np
from slr import phase_frac
_p = json.loads((out / "slr.json").read_text()) if False else None
_w = _np.array([10.0, 10.0, 10.0, 0.0]); _ms = _np.array([7.0, 3.5, _np.nan, 0.0]); _t = _np.array([3.0, -1.0, 1.0, -5.0])
assert list(phase_frac("temp", _w, _ms, _t)) == [0, 1, 1, 1]
assert list(_np.round(phase_frac("model", _w, _ms, _t), 2)) == [1.0, 0.5, 1.0, 0.0]   # NaN → temp rule; dry → 0
assert list(_np.round(phase_frac("hybrid", _w, _ms, _t), 2)) == [1.0, 1.0, 1.0, 1.0]  # cold slope overrides model rain
print("phase: checks passed")


# Warm cap: never raises today's ratio; interpolates between bin centres; no cap colder than the first centre.
from slr import warm_ratio, ours_snow
_warm = {"t": [-1.5, -0.5, 0.5, 1.5], "r": [11.0, 9.0, 5.0, 2.0]}
assert list(_np.round(warm_ratio(_np.array([-5.0, 0.0, 1.5, 4.0]), _warm), 2)) == [_np.inf, 7.0, 2.0, 2.0]
_pp = {"a": 11.5, "b": -0.36, "clamp": [5.0, 25.0], "regions": {}}
_tt = _np.array([-10.0, 0.0, 1.0, 3.0]); _ww = _np.full(4, 20.0); _mm = _np.array(["Rockies"] * 4)
_now, _new = ours_snow(_ww, _tt, _pp, _mm), ours_snow(_ww, _tt, _pp, _mm, _warm)
assert (_new <= _now + 1e-9).all() and _new[0] == _now[0] and _new[3] == 0 and abs(_new[2] - 20 * 3.5 / 10) < 1e-9, (_now, _new)
print("warm: checks passed")

# Sub-daily split: ramp + cap arithmetic, and hourly_check end to end on a tiny synthetic table with ERA5 rows.
import os as _os, tempfile as _tf, duckdb as _dd
from slr import hourly_ratio, hourly_check
_h = {"t0": -1.0, "t1": 1.0, "cap": 7.0}
_r = hourly_ratio(_np.array([-5.0, -1.5, 0.0, 1.0]), _pp, _np.array(["Rockies"] * 4), _h)
assert abs(_r[0] - (11.5 + 1.8)) < 1e-9 and abs(_r[1] - 7.0) < 1e-9 and abs(_r[2] - 3.5) < 1e-9 and _r[3] == 0, _r
_cwd = _os.getcwd()
with _tf.TemporaryDirectory() as _d:
    _os.chdir(_d)
    try:
        _c = _dd.connect()
        _rng = _np.random.default_rng(1)
        _rows = []
        for _i in range(900):
            ws = _np.datetime64("2024-12-01T12") + _np.timedelta64(int(_i % 300) * 24, "h")
            split = "train" if _i < 450 else "test"
            if split == "test":
                ws = ws + _np.timedelta64(365 * 24, "h")
            t = float(_rng.uniform(-6, 3)); w = float(_rng.uniform(3, 40))
            frac = _np.clip((1.0 - t) / 2.0, 0, 1)
            _rows.append((f"r{_i % 3}", "st", str(ws.astype("datetime64[s]")).replace("T", " "), str((ws + _np.timedelta64(24, "h")).astype("datetime64[s]")).replace("T", " "), split, 1 + _i % 7,
                          str((ws + _np.timedelta64(24, "h")).astype("datetime64[D]")), w, t, w * frac * 1.0, "Rockies"))
        _c.execute("CREATE TABLE d(resort_id VARCHAR, station_id VARCHAR, ws TIMESTAMP, we TIMESTAMP, split VARCHAR, lead_day INT,"
                   " end_date DATE, fc_water DOUBLE, t_st DOUBLE, snow_cm DOUBLE, macro VARCHAR)")
        _c.executemany("INSERT INTO d VALUES (?,?,?,?,?,?,?,?,?,?,?)", _rows)
        _os.makedirs("archive/source=era5/month=2024-12", exist_ok=True)
        _c.execute("""COPY (SELECT r.resort_id, te AS valid_end, v.variable,
                        CASE WHEN v.variable = 'temp_2m' THEN sin(epoch(te) / 9000.0) ELSE 1.0 END AS value
                      FROM (SELECT DISTINCT resort_id FROM d) r,
                           range(TIMESTAMP '2024-11-01', TIMESTAMP '2026-05-01', INTERVAL 3 HOUR) AS g(te),
                           (VALUES ('temp_2m'), ('precip')) v(variable))
                      TO 'archive/source=era5/month=2024-12/x.parquet' (FORMAT PARQUET)""")
        _res, _rep = hourly_check(_c, {**_pp, "warm": {}})
        assert set(_res["promote"]) == {"1-3", "4-7"} and "Sub-daily" in _rep and "Windows with an ERA5 shape: " in _rep, _rep[:400]
    finally:
        _os.chdir(_cwd)
print("hourly: checks passed")
