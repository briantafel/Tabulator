"""Tests for nbm.py's .idx parsing (no network): python3 -m pytest scripts/archive/test_nbm.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import nbm  # noqa: E402

IDX = """1:0:d=2026111100:TMP:2 m above ground:6 hour fcst:
2:1000:d=2026111100:TMP:2 m above ground:6 hour fcst:ens std dev:
3:2000:d=2026111100:APCP:surface:5-6 hour acc fcst:prob >0.254:
4:3000:d=2026111100:APCP:surface:0-6 hour acc fcst:prob >0.254:
5:4000:d=2026111100:APCP:surface:5-6 hour acc fcst:
6:5000:d=2026111100:APCP:surface:0-6 hour acc fcst:
7:6000:d=2026111100:ASNOW:surface:0-6 hour acc fcst:
8:7000:d=2026111100:WIND:10 m above ground:6 hour fcst:
"""


def test_idx_keeps_only_deterministic_lines_with_byte_ranges():
    idx = nbm.parse_idx(IDX)
    assert nbm.pick(idx, "APCP", "surface", "0-6 hour acc fcst") == (5000, 5999)  # not the prob line at 3000
    assert nbm.pick(idx, "TMP", "2 m above ground", "6 hour fcst") == (0, 999)  # not the std dev line
    assert nbm.pick(idx, "WIND", "10 m above ground", "6 hour fcst") == (7000, None)  # last message: open range
    assert nbm.pick(idx, "ASNOW", "surface", "0-6 hour acc fcst") == (6000, 6999)


IDX2 = """1:0:d=2026111100:TMP:2 m above ground:24 hour fcst:
2:1000:d=2026111100:SNOWLVL:0 m above mean sea level:24 hour fcst:
3:2000:d=2026111100:SNOWLVL:0 m above mean sea level:24 hour fcst:10% level:
4:3000:d=2026111100:SNOWLR:surface:24 hour fcst:
5:4000:d=2026111100:SNOWLR:surface:18-24 hour ave fcst:
"""


def test_snow_level_and_slr_are_matched_by_pattern_deterministic_instants_only():
    idx = nbm.parse_idx(IDX2)
    assert nbm.pick_like(idx, nbm.SNOW_LEVEL_RE, "24 hour fcst") == (1000, 1999)  # not the percentile line
    assert nbm.pick_like(idx, nbm.SLR_RE, "24 hour fcst") == (3000, 3999)  # not the average
    assert nbm.pick_like(idx, nbm.SNOW_LEVEL_RE, "18 hour fcst") is None
    assert "SNOWLVL:0 m above mean sea level" in nbm.related_lines(idx)

# ---- cycles (2026-11-23): all four collected; the terrain map's choice is 00z/12z unless the switch is on
import json as _j, tempfile as _t
from datetime import datetime as _dt, timezone as _tz
_D = lambda s: _dt.fromisoformat(s).replace(tzinfo=_tz.utc)  # noqa: E731
assert nbm.CYCLES == (0, 6, 12, 18)
_now = _D("2026-11-23T08:30:00")   # 05:30 after the lag -> 00z (12h step) or 00z (6h step); 06z is only 2.5 h old
assert nbm.candidate_cycles(_now)[0] == _D("2026-11-23T00:00:00")
assert nbm.candidate_cycles(_now, True)[0] == _D("2026-11-23T00:00:00")
_now = _D("2026-11-23T09:10:00")   # 06z is 3 h old: usable with the switch, never without it
assert nbm.candidate_cycles(_now)[0] == _D("2026-11-23T00:00:00")
assert nbm.candidate_cycles(_now, True)[0] == _D("2026-11-23T06:00:00")
assert len(nbm.candidate_cycles(_now)) == 4 and len(nbm.candidate_cycles(_now, True)) == 8
assert all(c.hour in (0, 12) for c in nbm.candidate_cycles(_now))
assert nbm.candidate_cycles(_now, True)[1] - nbm.candidate_cycles(_now, True)[2] == nbm.timedelta(hours=6)
with _t.TemporaryDirectory() as _d:
    _p = _d + "/flags.json"
    assert nbm.six_hourly_map_enabled(_p) is False, "missing file = off"
    open(_p, "w").write("{broken"); assert nbm.six_hourly_map_enabled(_p) is False, "broken file = off"
    open(_p, "w").write(_j.dumps({"terrain.freshCycle": "preview"})); assert nbm.six_hourly_map_enabled(_p) is False
    open(_p, "w").write(_j.dumps({"terrain.freshCycle": "on"})); assert nbm.six_hourly_map_enabled(_p) is True
assert nbm.six_hourly_map_enabled() is False, "the committed flags.json ships with it off"
print("cycle selection ok")


def _rows(**kw):
    base = {"precip": 2.0, "snow": 3.0, "temp_max": -4.0, "temp_min": -9.0, "wind_speed_max": 30.0}
    base.update(kw)
    return [{"resort_id": "alta", "valid_start": "2026-01-10T00:00:00Z", "variable": v, "value": x} for v, x in base.items()]


def test_range_cycles_is_00z_12z_newest_first_and_inclusive():
    c = nbm.range_cycles("20260101-20260102")
    assert [f"{x:%d%H}" for x in c] == ["0212", "0200", "0112", "0100"]
    assert [x.hour for x in nbm.range_cycles("20260101-20260101", (0, 6, 12, 18))] == [18, 12, 6, 0]


def test_backfill_unit_check_passes_normal_winter_values():
    nbm.check_units_backfill(_rows())


def test_backfill_unit_check_catches_kelvin_and_ms_slips():
    import pytest
    for bad in ({"temp_max": 268.0}, {"wind_speed_max": 0.4}, {"precip": 90.0}, {"snow": 400.0}):
        with pytest.raises(RuntimeError):
            nbm.check_units_backfill(_rows(**bad))


def test_month_marker_needs_every_cycle_marked():
    wanted = nbm.range_cycles("20260101-20260102")
    done = {f"nbm-{c:%Y%m%d%H}" for c in wanted}
    assert nbm.month_marker_check(done, wanted) == {"2026-01": wanted}
    assert nbm.month_marker_check(done - {"nbm-2026010112"}, wanted) == {}
