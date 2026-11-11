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
