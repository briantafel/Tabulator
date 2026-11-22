#!/usr/bin/env python3
"""Probe Earthmover's free ERA5 copy on AWS (Icechunk + Zarr v3, anonymous, CC BY 4.0).

    python3 scripts/archive/era5_probe.py [--start 2024-12-01] [--days 7]

Why (Brian, 2026-11-22, claude/state-2026-11-22-past-winters.md): past winters
have no crest-level wind (850 / 700 hPa) in our archive, and dynamical.org's
history has none either. ERA5 would give the analysed flow for 2020 on. This
only checks that the copy opens without a login, which variables and levels
it holds, how far forward it runs, how long a read of our resort points
takes, and that the numbers are plausible. Prints only; writes nothing and
archives nothing. Storm-type corrections are NOT built from it (on hold).

Failures are loud: any step that does not work exits non-zero and the
summary says which one.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BUCKET, PREFIX, REGION = "earthmover-icechunk-era5", "icechunkV2", "us-east-1"
LEVELS = (850, 700)
failures: list[str] = []


def say(msg: str = "") -> None:
    print(msg, flush=True)


def fail(msg: str) -> None:
    failures.append(msg)
    say(f"  ✗ {msg}")


def name_of(ds, *needles: str) -> str | None:
    """First data variable whose name contains every needle (case-insensitive)."""
    for n in ds.data_vars:
        low = n.lower()
        if all(k in low for k in needles):
            return n
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-12-01")
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()

    try:
        import icechunk
        import xarray as xr
    except ImportError as e:
        say(f"✗ missing package: {e}")
        return 1

    say(f"opening s3://{BUCKET}/{PREFIX} anonymously ({REGION})")
    t = time.time()
    try:
        storage = icechunk.s3_storage(bucket=BUCKET, prefix=PREFIX, region=REGION, anonymous=True)
        repo = icechunk.Repository.open(storage)
        session = repo.readonly_session("main")
    except Exception as e:  # noqa: BLE001 - the probe's job is to report any failure
        say(f"✗ could not open the repository without a login: {type(e).__name__}: {e}")
        return 1
    say(f"  opened in {time.time() - t:.1f} s (no credentials used)")

    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("nws")]
    sample = [r for r in resorts if r["id"] in ("alta", "palisades", "jackson-hole", "whistler", "stowe", "mammoth", "niseko")] or resorts[:6]
    say(f"{len(resorts)} resorts with coordinates; reading {len(sample)} for the timing test: {[r['id'] for r in sample]}")

    # Which groups hold what. The page names single / pressure / 500hPa, each spatial and temporal.
    temporal_ds = None
    for group in ("pressure/temporal", "pressure/spatial", "single/temporal"):
        say(f"\n========== group {group}")
        try:
            ds = xr.open_zarr(session.store, group=group, consolidated=False, chunks=None)
        except Exception as e:  # noqa: BLE001
            say(f"  could not open: {type(e).__name__}: {e}")
            if group == "pressure/temporal":
                fail("pressure/temporal would not open")
            continue
        say(f"  dims: {dict(ds.sizes)}")
        for c in ds.coords:
            v = ds[c]
            if v.size <= 14:
                say(f"  coord {c}: {v.values.tolist()}")
            else:
                say(f"  coord {c}: {v.values[0]} … {v.values[-1]} ({v.size})")
        for n, v in ds.data_vars.items():
            say(f"  var {n}: dims={v.dims} units={v.attrs.get('units')} long={v.attrs.get('long_name')} chunks={v.encoding.get('chunks')}")
        if group == "pressure/temporal":
            temporal_ds = ds

    ds = temporal_ds
    if ds is None:
        fail("no pressure-level time series to read")
        return summary()

    tname = next((c for c in ("time", "valid_time") if c in ds.coords), None)
    if tname is None:
        fail(f"no time coordinate in {list(ds.coords)}")
        return summary()
    t_first, t_last = ds[tname].values[0], ds[tname].values[-1]
    say(f"\ntime coverage: {t_first} → {t_last}")
    if np.datetime64(t_last, "D") < np.datetime64("2025-11-01"):
        say("  note: ends before the 2025-26 winter; that winter (and this one) would need another source.")

    lev = next((c for c in ("level", "isobaricInhPa", "pressure_level") if c in ds.coords), None)
    u_name, v_name = name_of(ds, "u_component") or name_of(ds, "wind", "u") or "u", name_of(ds, "v_component") or name_of(ds, "wind", "v") or "v"
    z_name = name_of(ds, "geopotential")
    say(f"level coordinate: {lev}; wind variables guessed as u={u_name!r} v={v_name!r}; geopotential={z_name!r}")
    if lev is None or u_name not in ds or v_name not in ds:
        fail(f"could not find u/v wind on pressure levels (names: {list(ds.data_vars)})")
        return summary()
    missing = [p for p in LEVELS if p not in set(int(x) for x in ds[lev].values)]
    if missing:
        fail(f"levels not present: {missing}")
        return summary()

    latn, lonn = ("latitude" if "latitude" in ds.coords else "lat"), ("longitude" if "longitude" in ds.coords else "lon")
    lon_vals = ds[lonn].values
    lon_is_360 = float(lon_vals.max()) > 180
    lat = xr.DataArray([r["nws"][0] for r in sample], dims="resort")
    lon = xr.DataArray([(r["nws"][1] % 360) if lon_is_360 else r["nws"][1] for r in sample], dims="resort")
    t0 = np.datetime64(args.start)
    t1 = t0 + np.timedelta64(args.days, "D")
    say(f"\nreading {args.start} + {args.days} d, levels {LEVELS}, {len(sample)} resorts (nearest grid cell)")
    out = {}
    for var in (u_name, v_name):
        t = time.time()
        try:
            a = (ds[var].sel({tname: slice(t0, t1)}).sel({lev: list(LEVELS)})
                 .sel({latn: lat, lonn: lon}, method="nearest").load())
        except Exception as e:  # noqa: BLE001
            fail(f"read of {var} failed: {type(e).__name__}: {e}")
            return summary()
        out[var] = a
        say(f"  {var}: shape {a.shape} dims {a.dims} in {time.time() - t:.1f} s; "
            f"min {float(np.nanmin(a)):.1f} max {float(np.nanmax(a)):.1f} NaN {int(np.isnan(a.values).sum())}")
    u, v = out[u_name], out[v_name]
    speed = np.hypot(u, v)                          # m s-1
    frm = (np.degrees(np.arctan2(-u, -v)) + 360) % 360  # direction the wind blows FROM, 0 = north
    for p in LEVELS:
        s = speed.sel({lev: p})
        say(f"  {p} hPa: speed mean {float(s.mean()):.1f} m/s, max {float(s.max()):.1f} m/s ({float(s.max()) * 3.6:.0f} km/h)")
        if not (0 <= float(s.min()) and float(s.max()) < 120):
            fail(f"{p} hPa wind speed outside 0–120 m/s")
    first = sample[0]["id"]
    i0 = 0
    say(f"\nsample ({first}, first 8 hourly steps at 700 hPa): speed m/s / direction from °")
    sp7, dr7 = speed.sel({lev: 700}).isel(resort=i0), frm.sel({lev: 700}).isel(resort=i0)
    for k in range(min(8, sp7.sizes[tname])):
        say(f"  {np.datetime_as_string(sp7[tname].values[k], unit='h')}  {float(sp7.values[k]):5.1f}  {float(dr7.values[k]):5.0f}")
    if np.isnan(speed.values).all():
        fail("every wind value is NaN")
    return summary()


def summary() -> int:
    say("\n" + ("PROBE FAILED: " + "; ".join(failures) if failures else "PROBE OK: opens without a login, winds on 850 and 700 hPa read and look plausible"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
