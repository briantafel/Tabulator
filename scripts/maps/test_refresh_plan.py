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

# --- archive-only resorts are not redrawn (nothing in the app shows them); an explicit --only still can
app = {"old-nbm", "new-nbm", "old-ifs"}
assert rp.plan(idx, now, nbm_c, ifs_c, app_ids=app)[0] == ["old-ifs", "old-nbm"], "no-run (archive-only) skipped"
assert rp.plan(idx, now, nbm_c, ifs_c, only=["no-run"], app_ids=app)[0] == ["no-run"], "--only overrides"
f = rp.plan(idx, now, nbm_c, ifs_c, force=True, app_ids=app)[0]
assert f == ["new-nbm", "old-ifs", "old-nbm"], f

# --- two waves: anchored first (one job each), the rest after; together exactly the due set
first, rest, due = rp.plan_waves(idx, now, nbm_c, ifs_c, anchored={"new-nbm"}, app_ids=app)
assert first == ["new-nbm"], first                       # anchored is due even when its run is the newest
assert sorted(" ".join(rest).split()) == ["old-ifs", "old-nbm"], rest
assert sorted(first + " ".join(rest).split()) == sorted(due)
f2, r2, d2 = rp.plan_waves(idx, now, nbm_c, ifs_c, anchored=set(), app_ids=app)
assert f2 == [] and sorted(" ".join(r2).split()) == d2, "no anchored resorts: one wave"
f3, r3, _ = rp.plan_waves({"a": {"run": "2026-11-22T00:00:00+00:00", "label": "NOAA NBM"}}, now, nbm_c, ifs_c, app_ids={"a"})
assert f3 == [] and r3 == [], "nothing due: nothing in either wave"
real = rp.app_resorts()
assert "jackson-hole" in real and "chamonix" not in real and len(real) == 57, len(real)
print("refresh plan tests passed")
