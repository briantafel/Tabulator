"""Tests for previous_runs_freshness.py (no network). Run as a plain script: python3 scripts/archive/test_previous_runs_freshness.py"""
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).parent))
import previous_runs_freshness as pf  # noqa: E402

TODAY = date(2026, 11, 23)  # expected last valid day: 2026-11-22


def write(dirpath, name, rows):
    """rows: (resort, model, day, run_id, period_label, variable)."""
    d = Path(dirpath) / "source=open-meteo-previous-runs" / "month=2026-11"
    d.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("CREATE TABLE t (resort_id VARCHAR, model VARCHAR, valid_start TIMESTAMP, run_id VARCHAR, period_label VARCHAR, variable VARCHAR, fetched_at TIMESTAMP)")
    for r, m, day, run, lab, var in rows:
        for h in (0, 6, 12, 18):
            vs = datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc).replace(tzinfo=None)
            con.execute("INSERT INTO t VALUES (?,?,?,?,?,?,?)", [r, m, vs, run, lab, var, datetime(2026, 11, 23, 8)])
    con.execute(f"COPY t TO '{d / name}.parquet' (FORMAT parquet)")


def live(resort, model, last_day, first_day=date(2026, 11, 15), run=None):
    out, d = [], first_day
    while d <= last_day:
        out.append((resort, model, d, run or f"bf-om-live-{resort}-{model}-2026-11-15", "previous_day1", "precip"))
        d += timedelta(days=1)
    return out


def run_check(rows_by_file, **kw):
    with tempfile.TemporaryDirectory() as tmp:
        for name, rows in rows_by_file.items():
            write(tmp, name, rows)
        con, n = pf.load(tmp)
        return pf.check(con, kw.pop("today", TODAY), **kw), n


def main():
    y = date(2026, 11, 22)

    # 1. everything reaches yesterday -> no problems
    files = {f"{r}-{m}": live(r, m, y) for r in ("alta", "whistler") for m in pf.MODELS}
    (last, per_day, problems), n = run_check(files)
    assert problems == [], problems
    assert n == 6 and last[("alta", "gem_seamless")][0] == y
    assert per_day[(y, "gfs_seamless")] == 2

    # 2. one model at one resort a day behind -> a problem naming it; max_lag=1 tolerates it
    files["whistler-gem_seamless"] = live("whistler", "gem_seamless", date(2026, 11, 21))
    (_, _, problems), _ = run_check(files)
    assert problems == ["whistler / gem_seamless: last valid day 2026-11-21 is 1 day(s) behind 2026-11-22"], problems
    (_, _, tolerated), _ = run_check(files, max_lag=1)
    assert tolerated == [], tolerated

    # 3. the 2026-11-23 situation: a model whose rows end on 11-20 is flagged at 2 days
    files["whistler-gem_seamless"] = live("whistler", "gem_seamless", date(2026, 11, 20))
    (_, _, problems), _ = run_check(files, max_lag=1)
    assert problems == ["whistler / gem_seamless: last valid day 2026-11-20 is 2 day(s) behind 2026-11-22"], problems

    # 4. a model with no live rows for a resort that has others is reported (missing is never "fine")
    del files["alta-gfs_seamless"]
    (_, _, problems), _ = run_check(files)
    assert "alta / gfs_seamless: no live rows" in problems, problems

    # 5. history rows (run_id bf-om-<resort>-<model>-<year>) and other leads/variables never count as live
    files = {f"{r}-{m}": live(r, m, y) for r in ("alta",) for m in pf.MODELS}
    files["hist"] = live("alta", "gem_seamless", y, run="bf-om-alta-gem_seamless-2025")
    files["alta-gem_seamless"] = live("alta", "gem_seamless", date(2026, 11, 19))   # the live rows stop on 11-19
    (_, _, problems), _ = run_check(files)
    assert problems == ["alta / gem_seamless: last valid day 2026-11-19 is 3 day(s) behind 2026-11-22"], problems
    files["alta-gem_seamless"] = [(r, m, d, run, "previous_day0", v) for r, m, d, run, _, v in live("alta", "gem_seamless", y)]
    (_, _, problems), _ = run_check(files)
    assert problems == ["alta / gem_seamless: no live rows"], problems

    # 6. no live rows at all is a problem, an empty folder is an error
    (_, _, problems), _ = run_check({"hist": live("alta", "gem_seamless", y, run="bf-om-alta-gem_seamless-2025")})
    assert problems == ["no live rows at all (run_id bf-om-live-*)"], problems
    with tempfile.TemporaryDirectory() as tmp:
        try:
            pf.load(tmp)
            raise AssertionError("an empty folder must not pass")
        except SystemExit as e:
            assert "no open-meteo-previous-runs parquet" in str(e)

    # 7. main() exits 1 on a problem and 0 when clean; the report names the damage
    with tempfile.TemporaryDirectory() as tmp:
        for r in ("alta",):
            for m in pf.MODELS:
                write(tmp, f"{r}-{m}", live(r, m, y if m != "gem_seamless" else date(2026, 11, 20)))
        assert pf.main([tmp, "--today", "2026-11-23"]) == 1
        assert pf.main([tmp, "--today", "2026-11-23", "--max-lag", "2"]) == 0
    print("previous runs freshness: all checks passed")


if __name__ == "__main__":
    main()
