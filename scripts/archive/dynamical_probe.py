#!/usr/bin/env python3
"""Probe dynamical.org datasets: ids, dimensions, variables, units, latest
init time and the cost of reading our resort points. Prints only; writes
nothing. Run by dynamical-ens.yml with mode=probe (2026-11-11)."""
import json
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr
import dynamical_catalog as dc

ROOT = Path(__file__).resolve().parents[2]
dc.identify("tabulator snow-forecast archive (github.com/briantafel/tabulator)")

ids = dc.list()
print("datasets:", json.dumps(ids, indent=0))
wanted = [i for i in ids if any(k in i for k in ("ifs-ens", "gefs", "aifs-ens"))]
print("probing:", wanted)

resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
lat = xr.DataArray([(r.get("latlon") or r["nws"])[0] for r in resorts], dims="resort")
lon = xr.DataArray([(r.get("latlon") or r["nws"])[1] for r in resorts], dims="resort")

for did in wanted:
    print("\n==========", did)
    t = time.time()
    try:
        ds = dc.open(did)
    except Exception as e:
        print("  open failed:", e)
        continue
    print(f"  opened in {time.time() - t:.1f} s")
    print("  dims:", dict(ds.sizes))
    for c in ds.coords:
        v = ds[c]
        if v.size <= 6:
            print(f"  coord {c}: {v.values}")
        else:
            print(f"  coord {c}: {v.values[0]} … {v.values[-1]} ({v.size})")
    for name, v in ds.data_vars.items():
        print(f"  var {name}: dims={v.dims} units={v.attrs.get('units')} long={v.attrs.get('long_name')} "
              f"step={v.attrs.get('step_type')} chunks={v.encoding.get('chunks')}")
    if "init_time" not in ds.dims:
        continue
    last = ds.init_time.values[-1]
    print("  latest init_time:", last)
    lon_q = lon if float(ds.longitude.min()) < 0 else (lon % 360)
    for name in [n for n in ("precipitation_surface", "temperature_2m") if n in ds]:
        t = time.time()
        sel = ds[name].sel(init_time=last).sel(latitude=lat, longitude=lon_q, method="nearest")
        a = sel.load()
        print(f"  read {name} for {len(resorts)} resorts, latest init: {time.time() - t:.1f} s, shape {a.shape}, "
              f"min {float(np.nanmin(a)):.4g} max {float(np.nanmax(a)):.4g} nan {int(np.isnan(a.values).sum())}")
        # one resort, member 0 or first, first 12 leads: to see whether precip is a rate, step or accumulation
        sub = a.isel(resort=[i for i, r in enumerate(resorts) if r["id"] in ("alta", "zermatt", "niseko")])
        if "ensemble_member" in sub.dims:
            sub = sub.isel(ensemble_member=0)
        print("   sample (alta/zermatt/niseko, member 0, first 10 leads):")
        print("  ", np.array2string(sub.isel(lead_time=slice(0, 10)).values, precision=4, max_line_width=200))
    sys.stdout.flush()
