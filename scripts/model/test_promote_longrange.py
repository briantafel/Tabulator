import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from promote_longrange import promote, MIN_BSS


def cell(lead, form="slope", bss=0.05, win=72, t=25, coef=(0.1, 0.6)):
    return {"form": form, "lead_day": lead, "window_h": win, "threshold_mm": t, "coef": list(coef),
            "bss_cal": bss, "bss_raw": 0.0, "winters": 6, "winters_better": 5}


def test_only_cells_that_beat_climatology_ship():
    m = {"version": "ens-calib-lowo-v1", "judged": True, "source": "s", "winters": ["a"],
         "promoted_cells_fit_on_all_winters": [
             cell(12, bss=0.05), cell(13, bss=MIN_BSS - 0.001), cell(14, bss=MIN_BSS),
             cell(10, win=24), cell(10, t=50), cell(11, form="full"),
             cell(9, form="spread", bss=0.04, coef=(0.7,)), cell(9, form="slope", bss=0.09)]}
    out = promote(m)
    assert sorted(out["leads"]) == ["12", "14", "9"], out["leads"]
    assert out["leads"]["9"]["form"] == "slope"          # the better of the surviving forms


def test_an_old_file_without_bss_cal_ships_nothing():
    c = cell(12); del c["bss_cal"]
    out = promote({"version": "ens-calib-lowo-v1", "judged": True, "promoted_cells_fit_on_all_winters": [c]})
    assert out["leads"] == {}


def test_an_unjudged_file_is_refused():
    try:
        promote({"version": "ens-calib-lowo-v1", "judged": False})
    except SystemExit:
        return
    raise AssertionError("unjudged file accepted")


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
