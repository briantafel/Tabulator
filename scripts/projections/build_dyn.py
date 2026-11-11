#!/usr/bin/env python3
"""Shadow projections from dynamical.org: liquid precipitation + OUR snow ratio.

    python3 scripts/projections/build_dyn.py <publicDir>

Brian, 2026-11-11: "start working with data from dynamical.org and see if we
can get the liquid to snow ratio right in the background. This provides us
another method of comparison and a backup data source if one fails."

Writes <publicDir>/projections-dyn.json in the SAME shape as projections.json
(the Open-Meteo build), so the two can be compared day by day and either can
stand in for the other. The app does NOT read this file yet.

Method, v0 (every step is plain arithmetic; see claude/dyn-projections-plan.md):
  1. Latest complete 00z init of ECMWF IFS ENS (51 members) and GEFS (31),
     read at the resort points with scripts/archive/dynamical_ens.py — the
     same reader and 6 h blocks the archive uses.
  2. Temperature moved from the model's grid-cell height to the resort's
     Snow-Forecast mid elevation (src/data/sf-elevations.json) at 6.5 °C/km.
     A 0.25° cell sits far below a mid-mountain; without this, snow turns to rain.
  3. Snow vs rain per 6 h block: GEFS's own percent-frozen where it has one;
     otherwise all snow at ≤ −1.5 °C, all rain at ≥ +1.5 °C, linear between.
  4. Snow-to-liquid ratio SLR = a + b·T, clamped (the form scripts/model/slr.py
     fits). Uses <publicDir>/slr.json when a fitted one has been committed;
     until then scripts/projections/slr-prior.json, a stated PRIOR, not a fit.
     snow cm = liquid mm × frozen fraction × SLR ÷ 10.
  5. Blocks go to the resort's LOCAL day by their midpoint; a day needs all
     four of its blocks (missing is not zero).
  6. Percentiles pooled across models, each model weighted equally.
Not yet: per-resort bias correction, a fitted SLR, wind/temperature
calibration against Snow-Forecast (the Open-Meteo build has that).
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/archive"))

LAPSE_C_PER_M = 0.0065
SNOW_ALL_BELOW_C, RAIN_ALL_ABOVE_C = -1.5, 1.5
PROJECTION_DAYS, BUFFER_DAYS = 10, 2      # = scripts/projections/lib.js
MODELS = ("ecmwf_ifs_ens", "gefs")
Q = {"p10": 0.10, "p25": 0.25, "p50": 0.50, "p75": 0.75, "p90": 0.90}


def frozen_fraction(t_c: np.ndarray, frozen_pct: np.ndarray | None) -> np.ndarray:
    by_temp = np.clip((RAIN_ALL_ABOVE_C - t_c) / (RAIN_ALL_ABOVE_C - SNOW_ALL_BELOW_C), 0.0, 1.0)
    if frozen_pct is None:
        return by_temp
    return np.where(np.isfinite(frozen_pct), np.clip(frozen_pct / 100.0, 0.0, 1.0), by_temp)


def slr_of(t_c: np.ndarray, p: dict) -> np.ndarray:
    return np.clip(p["a"] + p["b"] * t_c, *p["clamp"])


def daily_from_blocks(blocks, resorts, cell_elev, target_elev, slr):
    """blocks: (variable, unit, valid_start, valid_end, array[member, resort]) as
    dynamical_ens.build_blocks returns. Returns {resort_id: {date: {...}}}, each
    value an array over members: snow (cm), liquid (mm), tmax, tmin (°C), wind (km/h)."""
    by_start: dict[str, dict[str, np.ndarray]] = {}
    for var, _u, vs, ve, arr in blocks:
        if vs == ve:  # instants: not used here
            continue
        by_start.setdefault(vs, {})[var] = arr
    out: dict[str, dict[str, dict]] = {}
    for vs, v in sorted(by_start.items()):
        if not {"precip", "temp_min", "temp_max", "wind_speed_max"} <= v.keys():
            continue
        mid_utc = datetime.fromisoformat(vs.replace("Z", "+00:00")) + timedelta(hours=3)
        for r, resort in enumerate(resorts):
            tgt, cell = target_elev.get(resort["id"]), cell_elev[r]
            shift = -LAPSE_C_PER_M * (tgt - cell) if (tgt is not None and math.isfinite(cell)) else 0.0
            tmin, tmax = v["temp_min"][:, r] + shift, v["temp_max"][:, r] + shift
            tmean = (tmin + tmax) / 2.0
            liquid = v["precip"][:, r]
            fp = v.get("frozen_pct_mean")
            frac = frozen_fraction(tmean, fp[:, r] if fp is not None else None)
            snow = liquid * frac * slr_of(tmean, slr) / 10.0
            date = mid_utc.astimezone(ZoneInfo(resort["tz"])).date().isoformat()
            d = out.setdefault(resort["id"], {}).setdefault(date, {"n": 0, "snow": 0.0, "liquid": 0.0,
                                                                    "tmax": None, "tmin": None, "wind": None})
            d["n"] += 1
            d["snow"] = d["snow"] + snow
            d["liquid"] = d["liquid"] + liquid
            d["tmax"] = tmax if d["tmax"] is None else np.maximum(d["tmax"], tmax)
            d["tmin"] = tmin if d["tmin"] is None else np.minimum(d["tmin"], tmin)
            w = v["wind_speed_max"][:, r]
            d["wind"] = w if d["wind"] is None else np.maximum(d["wind"], w)
    # A local day needs all four 6 h blocks; a partial sum would read as less snow.
    return {rid: {date: d for date, d in days.items() if d["n"] == 4} for rid, days in out.items()}


def pooled_quantiles(per_model: list[np.ndarray]) -> dict | None:
    """Each model's members share equal total weight (as the Open-Meteo build)."""
    vals, wts = [], []
    for arr in per_model:
        a = arr[np.isfinite(arr)]
        if len(a):
            vals.append(a); wts.append(np.full(len(a), 1.0 / len(a)))
    if not vals:
        return None
    v, w = np.concatenate(vals), np.concatenate(wts)
    o = np.argsort(v); v, w = v[o], w[o]
    cum = (np.cumsum(w) - w / 2) / w.sum()
    return {k: round(float(np.interp(q, cum, v)), 2) for k, q in Q.items()}


def projection_dates(sf_dates: list[str]) -> list[str]:
    if not sf_dates:
        return []
    first = datetime.fromisoformat(sf_dates[0])
    return [d for d in ((first + timedelta(days=i)).date().isoformat() for i in range(PROJECTION_DAYS + BUFFER_DAYS))
            if d > sf_dates[-1]]


def summarize(daily_by_model: dict, resort_id: str, sf_dates: list[str]) -> dict | None:
    dates = projection_dates(sf_dates)
    models = [m for m in daily_by_model if resort_id in daily_by_model[m]]
    if not models:
        return None
    def get(m, date, key):
        d = daily_by_model[m][resort_id].get(date)
        return None if d is None else np.asarray(d[key], dtype=float)
    days = []
    for date in dates:
        arrs = [a for m in models if (a := get(m, date, "snow")) is not None]
        if not arrs:
            continue
        snow = pooled_quantiles(arrs)
        if snow is None:
            continue

        def med(k, date=date):
            a = np.concatenate([x for m in models if (x := get(m, date, k)) is not None])
            a = a[np.isfinite(a)]
            return round(float(np.median(a)), 1) if len(a) else None
        days.append({"date": date, "snow": snow, "tempMax": med("tmax"), "tempMin": med("tmin"), "windMax": med("wind"),
                     "liquidMm": med("liquid"), "members": int(sum(len(a) for a in arrs))})
    if not days:
        return None
    spread = {}
    for date in sf_dates:
        arrs = [a for m in models if (a := get(m, date, "snow")) is not None]
        if arrs and (q := pooled_quantiles(arrs)):
            spread[date] = q
    # Per-member snow on the projected dates, [member][day], so the app can add
    # a window up member by member (as with the Open-Meteo build). None = missing.
    members = {}
    for m in models:
        n_mem = len(next(iter(daily_by_model[m][resort_id].values()))["snow"])
        cols = []
        for d in days:
            a = get(m, d["date"], "snow")
            cols.append(a if a is not None else np.full(n_mem, np.nan))
        mat = np.stack(cols, axis=1)  # member × day
        members[m] = [[None if not math.isfinite(x) else round(float(x), 1) for x in row] for row in mat]
    return {"days": days, "spread": spread, "members": members}


def compare(om_path: Path, dyn: dict) -> str:
    """Side by side with the Open-Meteo build on the same resort-days. Agreement,
    not accuracy: which one is RIGHT is for the verification table to say."""
    try:
        om = json.loads(om_path.read_text())
    except Exception:  # noqa: BLE001
        return "## dynamical.org vs Open-Meteo projections\n\nNo Open-Meteo file to compare against."
    pairs = []
    for rid, d in dyn["resorts"].items():
        o = {x["date"]: x for x in (om.get("resorts", {}).get(rid, {}).get("days") or [])}
        for x in d["days"]:
            if x["date"] in o and o[x["date"]].get("snow") and x.get("snow"):
                pairs.append((o[x["date"]]["snow"]["p50"], x["snow"]["p50"]))
    if not pairs:
        return "## dynamical.org vs Open-Meteo projections\n\nNo shared resort-days yet."
    a = np.array(pairs, dtype=float)
    both = ((a[:, 0] >= 2.5) & (a[:, 1] >= 2.5)).sum()
    either = ((a[:, 0] >= 2.5) | (a[:, 1] >= 2.5)).sum()
    tot_om, tot_dyn = a[:, 0].sum(), a[:, 1].sum()
    return "\n".join([
        "## dynamical.org vs Open-Meteo projections (median snow per day)",
        f"- Shared resort-days: {len(a)}",
        f"- Median absolute difference: {np.median(np.abs(a[:, 0] - a[:, 1])):.1f} cm",
        f"- Total snow, dynamical.org ÷ Open-Meteo: {tot_dyn / tot_om:.2f}" if tot_om > 0 else "- Open-Meteo total is 0",
        f"- Days ≥ 1\" (2.5 cm) in both / in either: {both} / {either}",
        f"- SLR: {dyn['slr'].get('kind')}; inits {dyn['inits']}",
        "Agreement only. Accuracy comes from scoring against SNOTEL and the BC pillows.",
    ])


def load_slr(pub: Path) -> tuple[dict, str]:
    fitted = pub / "slr.json"
    if fitted.exists():
        return json.loads(fitted.read_text()), "fitted (public/slr.json)"
    return json.loads((ROOT / "scripts/projections/slr-prior.json").read_text()), "PRIOR (not fitted)"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__); return 2
    pub = Path(sys.argv[1])
    import dynamical_catalog as dc
    import xarray as xr
    from dynamical_ens import DATASETS, read_init
    dc.identify("tabulator snow-forecast (github.com/briantafel/tabulator)")
    forecast = json.loads((pub / "forecast.json").read_text())
    if forecast.get("synthetic"):
        print("forecast.json is sample data — refusing", file=sys.stderr); return 1
    sf_dates = forecast.get("dates") or [d["date"] for d in forecast["resorts"][0]["days"]]
    app_ids = {r["id"] for r in forecast["resorts"]}
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]
               if r["id"] in app_ids and (r.get("latlon") or r.get("nws")) and r.get("tz")]
    target = json.loads((ROOT / "src/data/sf-elevations.json").read_text())
    slr, slr_kind = load_slr(pub)
    lat = xr.DataArray([(r.get("latlon") or r["nws"])[0] for r in resorts], dims="resort")
    lon = xr.DataArray([(r.get("latlon") or r["nws"])[1] for r in resorts], dims="resort")
    now = datetime.now(timezone.utc)
    daily, inits = {}, {}
    for model in MODELS:
        cfg = DATASETS[model]
        ds = dc.open(cfg["id"])
        cands = sorted((datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), timezone.utc)
                        for t in ds.init_time.values), reverse=True)
        for init in [t for t in cands if t.hour == 0][:2]:   # newest 00z; one step back if it is not complete
            try:
                blocks, (_la, _lo, elev) = read_init(ds, model, cfg, init, resorts, lat, lon, now.isoformat(), "shadow")
                daily[model] = daily_from_blocks(blocks, resorts, elev, target, slr)
                inits[model] = init.isoformat().replace("+00:00", "Z")
                print(f"{model}: init {inits[model]}", file=sys.stderr)
                break
            except Exception as e:  # noqa: BLE001 — try the previous init, say why
                print(f"  ✗ {model} {init:%Y-%m-%d %Hz}: {e}", file=sys.stderr)
    if not daily:
        print("no model could be read — nothing written", file=sys.stderr); return 1
    gen = now.isoformat().replace("+00:00", "Z")
    issued = min(inits.values())
    out = {"generatedAt": gen, "source": "dynamical.org (ECMWF IFS ENS, NOAA GEFS) + Tabulator SLR",
           "attribution": "ECMWF and NOAA ensemble data from dynamical.org (CC BY 4.0)",
           "inits": inits, "slr": {**slr, "kind": slr_kind}, "sfGeneratedAt": forecast.get("generatedAt"),
           "days": PROJECTION_DAYS, "units": {"snow": "cm", "temp": "C", "wind": "km/h", "liquid": "mm"},
           "models": list(daily), "resorts": {}}
    missing = []
    for r in resorts:
        s = summarize(daily, r["id"], sf_dates)
        if s:
            out["resorts"][r["id"]] = {"issuedAt": issued, **s}
        else:
            missing.append(r["id"])
    (pub / "projections-dyn.json").write_text(json.dumps(out, allow_nan=False))
    n = len(out["resorts"])
    report = compare(pub / "projections.json", out)
    print(report, file=sys.stderr)
    import os
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report + "\n")
    print(f"projections-dyn: {n}/{len(resorts)} resorts, models {list(daily)}, SLR {slr_kind}", file=sys.stderr)
    if missing:
        print(f"  WITHOUT: {', '.join(missing)}", file=sys.stderr)
    return 0 if n >= 0.9 * len(resorts) else 1


if __name__ == "__main__":
    sys.exit(main())
