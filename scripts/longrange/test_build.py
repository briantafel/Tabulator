import math
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from build import calibrate, windows_for


def days(liq_by_date):
    return {d: {"liquid": np.asarray(v, dtype=float)} for d, v in liq_by_date.items()}


def test_calibrate_slope_and_spread():
    cell = {"form": "slope", "coef": [0.0, 1.0]}
    # a = 0, b = 1: the calibrated chance is the shrunk member share itself
    assert abs(calibrate(0.5, 30, cell) - 0.5) < 1e-9
    assert abs(calibrate(0.0, 30, cell) - (0.5 / 31)) < 1e-9          # never exactly 0
    sp = {"form": "spread", "coef": [0.5]}
    assert abs(calibrate(0.5, 30, sp) - 0.5) < 1e-9
    assert calibrate(0.9, 30, sp) < calibrate(0.9, 30, cell)          # a smaller b pulls toward 0.5


def test_windows_need_three_days_a_promoted_lead_and_enough_members():
    m = 31
    d = days({"2026-12-01": [10] * m, "2026-12-02": [10] * m, "2026-12-03": [10] * m, "2026-12-04": [10] * m})
    leads = {"13": {"form": "slope", "coef": [0.0, 1.0]}, "14": {"form": "slope", "coef": [0.0, 1.0]}}
    w = windows_for(d, date(2026, 11, 21), leads)       # 12-04 is lead 13; 12-03 is lead 12 (not promoted)
    assert [x["end"] for x in w] == ["2026-12-04"], w
    assert w[0]["raw"] == 1.0 and w[0]["lead"] == 13
    assert 0.9 < w[0]["p"] < 1.0                         # 30 mm in every member, but never certain
    assert windows_for(d, date(2026, 11, 21), {}) == []  # no promoted lead: no number, not the raw share
    thin = days({k: v[:5] for k, v in {"2026-12-02": [10] * m, "2026-12-03": [10] * m, "2026-12-04": [10] * m}.items()})
    assert windows_for(thin, date(2026, 11, 21), leads) == []


def test_a_missing_day_is_not_zero():
    m = 31
    d = days({"2026-12-02": [10] * m, "2026-12-04": [10] * m})     # 12-03 missing
    assert windows_for(d, date(2026, 11, 21), {"13": {"form": "slope", "coef": [0.0, 1.0]}}) == []


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
