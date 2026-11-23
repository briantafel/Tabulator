"""python3 scripts/maps/test_anchor.py"""
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import anchor as A  # noqa: E402

FC = {"resorts": [{"id": "jh", "elevation": {"mid": 2554}, "days": [
    {"date": "2026-11-21"}, {"date": "2026-11-22"}, {"date": "2026-11-23"}, {"date": "2026-11-24"},
    {"date": "2026-11-25"}, {"date": "2026-11-26"}, {"date": "2026-11-27", "projected": True}]}]}
BL = {"resorts": {"jh": {"days": [{"date": f"2026-11-{d}", "snow": s} for d, s in
                                  [(21, 9), (22, 0.2), (23, 1.2), (24, 0), (25, 0), (26, 4.1), (27, 12.3)]]}}}


def raises(f):
    try:
        f()
    except SystemExit:
        return True
    return False


def test():
    ds = A.sheet_dates(FC, "jh", date(2026, 11, 22))
    assert ds == ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"], ds   # past day and projected day out
    assert A.blend_total_cm(BL, "jh", ds) == 5.5
    assert raises(lambda: A.blend_total_cm(BL, "jh", ds + ["2026-11-28"]))                     # all or nothing
    assert A.mid_elevation_m(FC, "jh") == 2554
    assert raises(lambda: A.mid_elevation_m({"resorts": [{"id": "jh"}]}, "jh"))
    a, b = A.window_utc(ds, "America/Denver")
    assert a == datetime(2026, 11, 22, 7, tzinfo=timezone.utc) and b == datetime(2026, 11, 27, 7, tzinfo=timezone.utc)
    l00 = A.nbm_leads(datetime(2026, 11, 22, 0, tzinfo=timezone.utc), a, b)
    assert l00[0] == 12 and l00[-1] == 126 and len(l00) == 20, l00                          # 20 x 6 h = the 5 days
    l12 = A.nbm_leads(datetime(2026, 11, 22, 12, tzinfo=timezone.utc), a, b)
    assert l12[0] == 6 and l12[-1] == 114, l12                                               # hours before the cycle: none
    k = A.scale(1.0, 5.5)
    assert abs(k * 1.0 - 5.5 / 2.54) < 1e-9
    assert A.scale(0.0, 0.0) == 0.0
    assert raises(lambda: A.scale(0.05, 5.5))                                                # blend snow, NBM none: refuse
    assert A.scale(0.07, 1.2) is None and A.scale(0.0, 2.4) is None                           # no pattern, under 1 in: flat at the total
    assert raises(lambda: A.scale(0.07, 2.6))                                                # no pattern, 1.02 in: still refuse
    assert A.label(ds) == "Nov 22–26"
    assert A.label(["2026-11-29", "2026-12-03"]) == "Nov 29 – Dec 3"
    print("anchor: ok")


if __name__ == "__main__":
    test()
