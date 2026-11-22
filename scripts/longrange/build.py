#!/usr/bin/env python3
"""Long-range odds: the calibrated chance of a big storm in each 72 h window, from the live GEFS.

    python3 scripts/longrange/build.py <publicDir>

Writes <publicDir>/longrange.json. The event is the one scripts/verify/longrange.py scores:
72 h of liquid water (three local days) at or above 25 mm at the resort point — about a foot
of snow when it is cold. Plain arithmetic, no model beyond a fitted two-number correction:

  1. Latest complete 00z GEFS (31 members) read at the resort points with the same reader and
     6 h blocks as scripts/projections/build_dyn.py. Liquid per local day per member.
  2. For each local day D with D-2 and D present: each member's 72 h sum; p = share of members
     at or above 25 mm. A day needs all four 6 h blocks (missing is not zero).
  3. lead = D minus the resort-local date of the init (the scoring script's own definition).
  4. Calibration: <publicDir>/longrange-calib.json (scripts/model/promote_longrange.py), per lead:
         pt = (p*n + 0.5) / (n + 1);  q = sigmoid(a + b*logit(pt))     (slope)
         q = sigmoid(b*logit(pt))                                      (spread)
     fitted on past winters and judged on winters held out. A lead with no promoted cell gets NO
     number: never the raw share, never zero.
No calibration file yet: nothing is written and the app shows no section.
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
THRESHOLD_MM = 25.0
MIN_MEMBERS = 10


def _load_dyn():
    spec = importlib.util.spec_from_file_location("build_dyn", ROOT / "scripts/projections/build_dyn.py")
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(ROOT / "scripts/archive"))
    spec.loader.exec_module(mod)
    return mod


def logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def calibrate(p_raw: float, n: int, cell: dict) -> float:
    pt = (p_raw * n + 0.5) / (n + 1.0)
    z = logit(pt)
    a, b = (cell["coef"][0], cell["coef"][1]) if cell["form"] == "slope" else (0.0, cell["coef"][0])
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, a + b * z))))


def windows_for(days: dict, issue_local, calib_leads: dict) -> list[dict]:
    """days: {iso date: {"liquid": array over members}}. One entry per 72 h window ending on a date with a promoted lead."""
    out = []
    for date in sorted(days):
        d = datetime.fromisoformat(date).date()
        prev = [(d - timedelta(days=k)).isoformat() for k in (1, 2)]
        if not all(x in days for x in prev):
            continue
        lead = (d - issue_local).days
        cell = calib_leads.get(str(lead))
        if lead < 1 or cell is None:
            continue
        tot = sum(np.asarray(days[x]["liquid"], dtype=float) for x in [date] + prev)
        tot = tot[np.isfinite(tot)]
        if len(tot) < MIN_MEMBERS:
            continue
        p = float(np.mean(tot >= THRESHOLD_MM))
        out.append({"end": date, "lead": lead, "p": round(calibrate(p, len(tot), cell), 3), "raw": round(p, 3), "n": int(len(tot))})
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__); return 2
    pub = Path(sys.argv[1])
    calib_path = pub / "longrange-calib.json"
    if not calib_path.exists():
        print("longrange: no longrange-calib.json yet (nothing has been promoted) — nothing written", file=sys.stderr)
        return 0
    calib = json.loads(calib_path.read_text())
    if calib.get("version") != "longrange-calib-v1" or not calib.get("leads"):
        print("longrange: the calibration has no promoted lead — nothing written", file=sys.stderr)
        return 0
    dyn = _load_dyn()
    import dynamical_catalog as dc
    import xarray as xr
    from dynamical_ens import DATASETS, read_init
    dc.identify("tabulator snow-forecast (github.com/briantafel/tabulator)")
    forecast = json.loads((pub / "forecast.json").read_text())
    if forecast.get("synthetic"):
        print("forecast.json is sample data — refusing", file=sys.stderr); return 1
    app_ids = {r["id"] for r in forecast["resorts"]}
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]
               if r["id"] in app_ids and (r.get("latlon") or r.get("nws")) and r.get("tz")]
    target = json.loads((ROOT / "src/data/sf-elevations.json").read_text())
    slr, _kind = dyn.load_slr(pub)   # only needed by daily_from_blocks; this script uses liquid
    lat = xr.DataArray([(r.get("latlon") or r["nws"])[0] for r in resorts], dims="resort")
    lon = xr.DataArray([(r.get("latlon") or r["nws"])[1] for r in resorts], dims="resort")
    now = datetime.now(timezone.utc)
    cfg = DATASETS["gefs"]
    ds = dc.open(cfg["id"])
    cands = sorted((datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), timezone.utc)
                    for t in ds.init_time.values), reverse=True)
    daily, init = None, None
    for t in [c for c in cands if c.hour == 0][:2]:
        try:
            blocks, (_la, _lo, elev) = read_init(ds, "gefs", cfg, t, resorts, lat, lon, now.isoformat(), "longrange")
            daily, init = dyn.daily_from_blocks(blocks, resorts, elev, target, slr), t
            break
        except Exception as e:  # noqa: BLE001 — try the previous init, say why
            print(f"  ✗ gefs {t:%Y-%m-%d %Hz}: {e}", file=sys.stderr)
    if daily is None:
        print("GEFS could not be read — nothing written", file=sys.stderr); return 1
    out_resorts, none = {}, []
    for r in resorts:
        days = daily.get(r["id"])
        if not days:
            none.append(r["id"]); continue
        issue_local = init.astimezone(ZoneInfo(r["tz"])).date()
        w = windows_for(days, issue_local, calib["leads"])
        if w:
            out_resorts[r["id"]] = {"windows": w}
        else:
            none.append(r["id"])
    out = {"generatedAt": now.isoformat().replace("+00:00", "Z"), "init": init.isoformat().replace("+00:00", "Z"),
           "source": "NOAA GEFS via dynamical.org (CC BY 4.0), calibrated by Tabulator",
           "event": calib["event"], "calibration": {"version": calib["version"], "winters": calib.get("winters"),
                                                      "leads": sorted(int(k) for k in calib["leads"]), "min_bss": calib.get("min_bss")},
           "resorts": out_resorts}
    (pub / "longrange.json").write_text(json.dumps(out, allow_nan=False))
    print(f"longrange: {len(out_resorts)}/{len(resorts)} resorts, init {out['init']}, leads {out['calibration']['leads']}", file=sys.stderr)
    if none:
        print(f"  WITHOUT: {', '.join(none)}", file=sys.stderr)
    return 0 if len(out_resorts) >= 0.9 * len(resorts) else 1


if __name__ == "__main__":
    sys.exit(main())
