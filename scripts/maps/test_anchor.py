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
    # height profile (2026-11-23): the blend's own snow at each height; at mid exactly the sheet's number
    slr = {"a": 11.5, "b": -0.36, "clamp": [5, 25], "region_of": {}, "regions": {},
           "warm": {"t": [-0.5, 0.5, 1.5], "r": [11.0, 7.0, 4.0], "promote": {"1-3": True, "4-7": False}}}
    bl = {"resorts": {"w": {"days": [{"date": "2026-11-24", "lead": 1, "water": 66.3, "t": 0.1, "snow": 58.3}]}}}
    hs = [675.0, 1480.0, 2260.0]
    pr = A.height_profile(bl, "w", ["2026-11-24"], slr, 1480.0, hs)["2026-11-24"]
    assert pr[1] == 58.3, pr                                   # mid: the sheet's number, untouched
    assert pr[0] == 0.0, pr                                    # +5.3 C at the base: rain
    r_top = 11.5 - 0.36 * (0.1 - 0.0065 * 780)                 # -4.97 C, colder than the warm cap range
    r_mid = min(11.5 - 0.036, 7.0 + (11.0 - 7.0) * (0.5 - 0.1))  # warm cap at +0.1 C = 8.6
    assert abs(pr[2] - round(58.3 * r_top / r_mid, 3)) < 1e-9, pr
    rain_mid = {"resorts": {"w": {"days": [{"date": "2026-11-24", "lead": 1, "water": 20.0, "t": 3.0, "snow": 0.0}]}}}
    pm = A.height_profile(rain_mid, "w", ["2026-11-24"], slr, 1480.0, hs)["2026-11-24"]
    assert pm[1] == 0.0 and pm[2] > 0, pm                       # rain at mid, snow at the summit
    assert A.ratio(2.5, A.line_for(slr, "w"), 1) == 0.0 and A.ratio(0.0, A.line_for(slr, "w"), 5) == 11.5   # 4-7 uncapped
    bad = {**slr, "hourly": {"promote": {"1-3": True}}}
    assert raises(lambda: A.height_profile(bl, "w", ["2026-11-24"], bad, 1480.0, hs))      # daily rule only: refuse loudly
    assert raises(lambda: A.height_profile({"resorts": {"w": {"days": [{"date": "2026-11-24", "snow": 1}]}}}, "w",
                                           ["2026-11-24"], slr, 1480.0, hs))               # no water/t: refuse
    hh = A.profile_heights(700, 2200, 1480.3)
    assert 1480.3 in hh and hh[0] < 700 and hh[-1] > 2200 and hh == sorted(hh)
    print("anchor: ok")


if __name__ == "__main__":
    test()
