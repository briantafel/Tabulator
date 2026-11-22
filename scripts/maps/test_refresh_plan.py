#!/usr/bin/env python3
"""Refresh planning rules:  python3 scripts/maps/test_refresh_plan.py"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import refresh_plan as rp  # noqa: E402

D = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)  # noqa: E731
now = D("2026-11-22T07:30:00")
assert rp.floor12(now - rp.timedelta(hours=3)) == D("2026-11-22T00:00:00")
assert rp.newest_ifs(now) == D("2026-11-21T12:00:00"), "07:30Z: the 00Z IFS is not up yet (8 h)"
assert rp.newest_ifs(D("2026-11-22T08:30:00")) == D("2026-11-22T00:00:00")

nbm_c, ifs_c = D("2026-11-22T00:00:00"), D("2026-11-21T12:00:00")
idx = {
    "_note": "x",
    "old-nbm": {"run": "2026-11-21T12:00:00+00:00", "label": "NOAA NBM • Tabulator terrain-adjusted"},
    "new-nbm": {"run": "2026-11-22T00:00:00+00:00", "label": "NOAA NBM"},
    "old-ifs": {"run": "2026-11-21T00:00:00+00:00", "label": "ECMWF IFS • Tabulator terrain-adjusted"},
    "new-ifs": {"run": "2026-11-21T12:00:00+00:00", "label": "ECMWF IFS • Tabulator terrain-adjusted"},
    "no-run": {"label": "NOAA NBM"},
}
due, batches = rp.plan(idx, now, nbm_c, ifs_c)
assert due == ["no-run", "old-ifs", "old-nbm"], due
assert sorted(" ".join(batches).split()) == due and all(batches)
assert rp.plan(idx, now, nbm_c, ifs_c, force=True)[0] == sorted(k for k in idx if k != "_note")
assert rp.plan(idx, now, nbm_c, ifs_c, only=["old-nbm", "new-nbm"])[0] == ["old-nbm"]
assert rp.plan({"a": {"run": "2026-11-22T00:00:00+00:00", "label": "NOAA NBM"}}, now, nbm_c, ifs_c) == ([], []), "nothing due -> no batches"
many = {f"r{i:03d}": {"run": "2026-11-20T12:00:00+00:00", "label": "NOAA NBM"} for i in range(106)}
d, b = rp.plan(many, now, nbm_c, ifs_c, batch=6)
assert len(d) == 106 and all(len(x.split()) <= 6 for x in b) and len(b) == 18, (len(b), [len(x.split()) for x in b])
assert rp.plan(idx, now, nbm_c, ifs_c, only=["new-nbm"], anchored={"new-nbm"})[0] == ["new-nbm"], "anchored: always due"
print("refresh plan tests passed")
