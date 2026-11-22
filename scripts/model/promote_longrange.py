#!/usr/bin/env python3
"""Copy the judged long-range calibration into the app: only leads that earned it.

    python3 scripts/model/promote_longrange.py <verify out/ens_calib_lowo.json> public/longrange-calib.json

scripts/verify/longrange.py fits GEFS leave-one-winter-out (ens-calib-lowo-v1): for each lead day it
turns the raw share of ensemble members that reach 25 mm of water in 72 h into a calibrated chance,
and judges that on winters held out of the fit.

A lead ships only when ALL of these hold (nothing here is tuned to look good):
  1. the lowo judge promoted it (90% range of the Brier gain over the raw ensemble above zero, and
     better in all but at most one held-out winter);
  2. its pooled held-out Brier skill over CLIMATOLOGY (bss_cal) is at least MIN_BSS. Beating the raw
     ensemble is not enough: a raw ensemble can be overconfident and still be worse than the base rate.
     MIN_BSS = 0.03 is a stated floor for "worth showing", not a fitted number;
  3. the form is "spread" or "slope" (the forms that need only the member share, no climatology).
Per lead, the better of the surviving forms (higher bss_cal) is kept. An old file without bss_cal
ships nothing: it cannot be judged against climatology.
"""
import json
import sys
from pathlib import Path

WINDOW_H, THRESHOLD_MM = 72, 25
MIN_BSS = 0.03
FORMS = ("slope", "spread")


def promote(m: dict) -> dict:
    if m.get("version") != "ens-calib-lowo-v1" or not m.get("judged"):
        raise SystemExit("not a judged ens-calib-lowo-v1 file — nothing shipped")
    best: dict[int, dict] = {}
    for c in m.get("promoted_cells_fit_on_all_winters", []):
        if c.get("window_h") != WINDOW_H or c.get("threshold_mm") != THRESHOLD_MM or c.get("form") not in FORMS:
            continue
        if c.get("bss_cal") is None or c["bss_cal"] < MIN_BSS:
            continue
        lead = int(c["lead_day"])
        if lead not in best or c["bss_cal"] > best[lead]["bss_cal"]:
            best[lead] = c
    return {
        "version": "longrange-calib-v1",
        "source": m.get("source"),
        "winters": m.get("winters"),
        "event": {"window_h": WINDOW_H, "threshold_mm": THRESHOLD_MM},
        "min_bss": MIN_BSS,
        "forms": {"slope": "q = sigmoid(coef[0] + coef[1]*logit(p))", "spread": "q = sigmoid(coef[0]*logit(p))",
                  "p": "(share of members at or above the threshold * n + 0.5) / (n + 1)"},
        "leads": {str(k): {"form": v["form"], "coef": v["coef"], "bss_cal": v["bss_cal"], "bss_raw": v.get("bss_raw"),
                           "winters": v.get("winters"), "winters_better": v.get("winters_better")}
                  for k, v in sorted(best.items())},
    }


def main(src: Path, dst: Path) -> None:
    out = promote(json.loads(src.read_text()))
    dst.write_text(json.dumps(out, indent=1) + "\n")
    leads = sorted(int(k) for k in out["leads"])
    print(f"longrange promote: leads shipped {leads or 'none'} (floor: held-out Brier skill >= {MIN_BSS} over climatology)",
          file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
