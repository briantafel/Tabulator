#!/usr/bin/env python3
"""ERA5 reanalysis at our resort points for past winters: the analysed flow, for storm typing.

    python3 scripts/archive/era5_history.py <workDir> [--winters 2020-2025] [--dry-run] [--only-month 2024-12]

Added 2026-11-22 (Brian: "Let's get that data and any historical data"). The
storm-type idea (claude/state-2026-11-22-era5-probe.md): wind direction at
crest level (700 hPa, ~10,000 ft) separates good mountain storms from busts,
and models' biases differ by storm type. Our own upper-air archive starts in
Nov 2026, so past winters need a reanalysis to label each storm's flow.

Source: Earthmover's ERA5 copy on AWS (s3://earthmover-icechunk-era5/icechunkV2,
CC BY 4.0, anonymous; attribution "ERA5, Copernicus Climate Change Service,
via Earthmover"). Coverage runs to 2026-06-30, so 2025-26 is included.

Winter W = Nov 1 of W to Apr 30 of W+1. Default 2020-21 … 2025-26, the same
winters as our GEFS history, so every storm we can score has a flow label.

Rows (source "era5", kind "reanalysis", model "era5", tier "grid", nearest
0.25° cell; elevation_m = the cell's ERA5 surface height, so 2 m values are at
that height, not the resort's):
  3-hourly instants (00, 03 … 21 UTC), period_label "instant":
    wind_u_700, wind_v_700, temp_700, rh_700, omega_700   (m/s, °C, %, Pa/s)
    wind_u_850, wind_v_850, temp_850                       (m/s, °C)
    wind_u_500, wind_v_500, height_500                     (m/s, m)
    temp_2m, dewpoint_2m, pwat (total column water vapour, mm), cape (J/kg), mslp (hPa)
  3-hour sums ending at each instant, period_label "3h":
    precip, snowfall (mm water)
Wind direction / speed are derived by whoever reads them (from = atan2(−u, −v)).

Loud failures: a resort with NaN in a month, a value outside plausible bounds,
or a month with missing hours stops the run (exit 1) before anything for that
month is uploaded. Done markers (era5/done/<yyyy-mm>.json) make reruns skip
months already archived.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BUCKET, PREFIX, REGION = "earthmover-icechunk-era5", "icechunkV2", "us-east-1"
SOURCE, PARSER_VERSION = "era5", "era5-history-1"
G = 9.80665
STEP_H = 3
WINTER_MONTHS = (11, 12, 1, 2, 3, 4)

# name in the archive: (group, ERA5 variable, level or None, unit, convert, plausible lo, hi)
K = lambda x: x - 273.15  # noqa: E731
INSTANT = {
    "wind_u_700": ("pressure", "u", 700, "m/s", None, -120, 120),
    "wind_v_700": ("pressure", "v", 700, "m/s", None, -120, 120),
    "temp_700": ("pressure", "t", 700, "C", K, -50, 20),
    "rh_700": ("pressure", "r", 700, "%", None, -10, 150),  # ERA5 r is over ice below −23 °C (can pass 100) and has small negative round-off
    "omega_700": ("pressure", "w", 700, "Pa/s", None, -20, 20),
    "wind_u_850": ("pressure", "u", 850, "m/s", None, -120, 120),
    "wind_v_850": ("pressure", "v", 850, "m/s", None, -120, 120),
    "temp_850": ("pressure", "t", 850, "C", K, -55, 35),
    "wind_u_500": ("pressure", "u", 500, "m/s", None, -150, 150),
    "wind_v_500": ("pressure", "v", 500, "m/s", None, -150, 150),
    "height_500": ("pressure", "z", 500, "m", lambda x: x / G, 4500, 6200),
    "temp_2m": ("single", "t2m", None, "C", K, -60, 35),
    "dewpoint_2m": ("single", "d2m", None, "C", K, -70, 30),
    "pwat": ("single", "tcwv", None, "mm", None, 0, 80),
    "cape": ("single", "cape", None, "J/kg", None, 0, 8000),
    "mslp": ("single", "msl", None, "hPa", lambda x: x / 100, 900, 1090),
}
SUMS = {  # ERA5 hourly accumulations (m of water) over the hour ending at the timestamp
    "precip": ("single", "tp", "mm", 0, 150),
    "snowfall": ("single", "sf", "mm", 0, 150),
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def bucket(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint] + ([] if args[:1] == ("ls",) else ["--only-show-errors"]),
                          capture_output=True, text=True)


def done_months() -> set[str]:
    if not os.environ.get("R2_BUCKET"):
        return set()
    r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/era5/done/")
    if r.returncode not in (0, 1):
        raise SystemExit(f"could not list done markers: {r.stderr[-300:]}")
    return {ln.split()[-1].removesuffix(".json") for ln in r.stdout.splitlines() if ln.strip().endswith(".json")}


def months_of(winters: range) -> list[str]:
    return [f"{w + (m < 11):04d}-{m:02d}" for w in winters for m in WINTER_MONTHS]


def month_bounds(ym: str) -> tuple[np.datetime64, np.datetime64]:
    y, m = map(int, ym.split("-"))
    a = np.datetime64(f"{y:04d}-{m:02d}-01T00")
    b = np.datetime64(f"{y + (m == 12):04d}-{(m % 12) + 1:02d}-01T00")
    return a, b


def resort_points() -> list[dict]:
    meta = json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]
    point = lambda r: r.get("latlon") or r.get("nws")  # noqa: E731 - same rule as the ensemble collectors
    missing = [r["id"] for r in meta if not point(r)]
    if missing:
        raise SystemExit(f"resorts without coordinates: {missing}")
    return [{"id": r["id"], "lat": float(point(r)[0]), "lon": float(point(r)[1])} for r in meta]


def open_groups():
    import icechunk
    import xarray as xr
    storage = icechunk.s3_storage(bucket=BUCKET, prefix=PREFIX, region=REGION, anonymous=True)
    session = icechunk.Repository.open(storage).readonly_session("main")
    return {g: xr.open_zarr(session.store, group=f"{g}/temporal", consolidated=False, chunks=None)
            for g in ("pressure", "single")}


def read_month(ds: dict, ym: str, resorts: list[dict]):
    """→ (instants {name: (T, R)}, sums {name: (T, R)}, times of instants, cell lat/lon/elev)."""
    import xarray as xr
    a, b = month_bounds(ym)
    lat = xr.DataArray([r["lat"] for r in resorts], dims="resort")
    lon = xr.DataArray([r["lon"] % 360 for r in resorts], dims="resort")
    pick = lambda da: da.sel(latitude=lat, longitude=lon, method="nearest")  # noqa: E731
    out_i, out_s, times, cell = {}, {}, None, None
    for name, (g, var, lev, _unit, conv, lo, hi) in INSTANT.items():
        da = ds[g][var].sel(valid_time=slice(a, b - np.timedelta64(1, "h")))
        if lev is not None:
            da = da.sel(pressure_level=lev)
        da = pick(da)
        da = da.isel(valid_time=(da.valid_time.dt.hour % STEP_H == 0).values).load()
        x = da.values.astype(float)
        if conv is not None:
            x = conv(x)
        out_i[name] = x
        t = da.valid_time.values
        if times is None:
            times = t
            cell = (da.latitude.values, ((da.longitude.values + 180) % 360) - 180,
                    pick(ds["single"]["z_sfc"]).values / G if "z_sfc" in ds["single"].coords else None)
        elif not np.array_equal(times, t):
            raise SystemExit(f"{ym}: {name} has different time steps from the other variables")
    for name, (g, var, _unit, lo, hi) in SUMS.items():
        # Block k ends at instant a + 3k and holds the hours ending at a+3k−2, a+3k−1, a+3k, so the
        # hourly slice runs from a − 2 h to b − 3 h: exactly as many hours as the month has.
        da = pick(ds[g][var].sel(valid_time=slice(a - np.timedelta64(STEP_H - 1, "h"), b - np.timedelta64(STEP_H, "h")))).load()
        x = da.values.astype(float) * 1000.0  # m → mm
        t = da.valid_time.values
        n_exp = int((b - a) / np.timedelta64(1, "h"))
        if len(t) != n_exp:
            raise SystemExit(f"{ym}: {var} has {len(t)} hourly steps, expected {n_exp} (missing hours are not zero)")
        x = np.clip(x, 0, None)  # ERA5 accumulations carry tiny negative round-off
        out_s[name] = x.reshape(-1, STEP_H, x.shape[1]).sum(axis=1)
    n_exp = int((b - a) / np.timedelta64(STEP_H, "h"))
    if times is None or len(times) != n_exp:
        raise SystemExit(f"{ym}: {0 if times is None else len(times)} 3-hourly instants, expected {n_exp}")
    return out_i, out_s, times, cell


def check(ym: str, resorts: list[dict], inst: dict, sums: dict) -> None:
    bad = []
    for name, x in {**inst, **sums}.items():
        lo, hi = (INSTANT[name][5:7] if name in INSTANT else SUMS[name][3:5])
        nan_r = [resorts[j]["id"] for j in np.where(np.isnan(x).any(axis=0))[0]]
        if nan_r:
            bad.append(f"{name}: NaN at {nan_r[:5]}{'…' if len(nan_r) > 5 else ''}")
        v = x[np.isfinite(x)]
        if v.size and (v.min() < lo or v.max() > hi):
            bad.append(f"{name}: range {v.min():.1f}..{v.max():.1f} outside {lo}..{hi}")
    if bad:
        raise SystemExit(f"{ym}: implausible ERA5 values, nothing uploaded: " + "; ".join(bad))


def iso(t) -> str:
    return np.datetime_as_string(t, unit="s") + "Z"


def rows(ym, resorts, inst, sums, times, cell, fetched_at, run_id):
    clat, clon, celev = cell
    step = np.timedelta64(STEP_H, "h")
    ts = [iso(t) for t in times]
    ts0 = [iso(t - step) for t in times]
    for j, r in enumerate(resorts):
        base = {"source": SOURCE, "kind": "reanalysis", "resort_id": r["id"], "tier": "grid",
                "elevation_m": None if celev is None else int(round(float(celev[j]))),
                "lat": round(float(clat[j]), 3), "lon": round(float(clon[j]), 3), "station_id": None,
                "issued_at": None, "fetched_at": fetched_at, "value_text": None, "model": "era5", "member": None,
                "run_id": run_id, "parser_version": PARSER_VERSION}
        for name, x in inst.items():
            unit = INSTANT[name][3]
            for k in range(len(ts)):
                yield {**base, "valid_start": ts[k], "valid_end": ts[k], "period_label": "instant",
                       "variable": name, "value": round(float(x[k, j]), 2), "unit": unit}
        for name, x in sums.items():
            for k in range(len(ts)):
                yield {**base, "valid_start": ts0[k], "valid_end": ts[k], "period_label": "3h",
                       "variable": name, "value": round(float(x[k, j]), 3), "unit": "mm"}


def write_and_upload(work: Path, ym: str, it, run_id: str, dry: bool) -> int:
    d = work / ym
    (d / "rows").mkdir(parents=True, exist_ok=True)
    n = 0
    with gzip.open(d / "rows" / f"{SOURCE}.ndjson.gz", "wt", compresslevel=3) as f:
        for r in it:
            f.write(json.dumps(r) + "\n")
            n += 1
    subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"), run_id, ym],
                   check=True)
    marker = d / "done.json"
    marker.write_text(json.dumps({"month": ym, "rows": n, "run_id": run_id, "parser_version": PARSER_VERSION}))
    if dry:
        log(f"  {ym}: dry run, {n} rows built, nothing uploaded")
        return n
    b = os.environ["R2_BUCKET"]
    r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
    if r.returncode:
        raise SystemExit(f"{ym}: upload failed: {r.stderr[-300:]}")
    r = bucket("cp", str(marker), f"s3://{b}/era5/done/{ym}.json")
    if r.returncode:
        raise SystemExit(f"{ym}: marker upload failed: {r.stderr[-300:]}")
    shutil.rmtree(d, ignore_errors=True)
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--winters", default="2020-2025", help="first-last winter start years, e.g. 2020-2025 = 2020-21 … 2025-26")
    ap.add_argument("--only-month", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    w0, w1 = map(int, a.winters.split("-"))
    months = [a.only_month] if a.only_month else months_of(range(w0, w1 + 1))
    done = done_months()
    todo = [m for m in months if m not in done]
    log(f"ERA5 history: {len(months)} months asked, {len(months) - len(todo)} already archived, {len(todo)} to load")
    if not todo:
        print("ERA5 HISTORY COMPLETE for the asked winters")
        return 0
    resorts = resort_points()
    t = time.time()
    ds = open_groups()
    log(f"  opened ERA5 anonymously in {time.time() - t:.1f} s; {len(resorts)} resorts")
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    work = Path(a.work)
    total = 0
    for ym in todo:
        t = time.time()
        inst, sums, times, cell = read_month(ds, ym, resorts)
        check(ym, resorts, inst, sums)
        run_id = f"era5-{ym}-{fetched_at[:10]}"
        n = write_and_upload(work, ym, rows(ym, resorts, inst, sums, times, cell, fetched_at, run_id), run_id, a.dry_run)
        total += n
        w7 = np.hypot(inst["wind_u_700"], inst["wind_v_700"])
        log(f"  {ym}: {n} rows, {len(times)} steps, 700 hPa wind mean {w7.mean():.1f} max {w7.max():.1f} m/s, "
            f"precip max 3 h {sums['precip'].max():.1f} mm ({time.time() - t:.0f} s)")
    print(f"ERA5 history: {len(todo)} months, {total} rows {'built (dry run)' if a.dry_run else 'archived'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
