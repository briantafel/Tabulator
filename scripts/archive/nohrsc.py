#!/usr/bin/env python3
"""NOHRSC National Gridded Snowfall Analysis (v2) at our resort points: snow truth.

    python3 scripts/archive/nohrsc.py <workDir> [--dry-run] [--probe] [--from YYYY-MM-DD --to YYYY-MM-DD]

Added 2026-11-17 (claude/state-2026-11-16-blend-gap.md). NOAA/NWS NOHRSC's
24-hour snowfall analysis: CoCoRaHS / COOP / other snowfall reports
interpolated onto a ~4 km CONUS grid, with Stage IV precipitation, HRRR/RAP
and a snow-to-liquid climatology as the background between stations. Public
domain (US Government); cite "NOAA/NWS NOHRSC National Snowfall Analysis".

What it is and isn't. It measures NEW snow over 24 h (no settling, unlike
SNOTEL depth gain), and it reaches the mountain between stations. But in the
mountains it is mostly its background (radar is poor there, reports are
sparse and low), and the reports it does use include CoCoRaHS, so it is NOT
independent of our board truth. kind = "analysis": verification treats it as
second-tier truth, beside SNOTEL and the boards, never instead of them.

Files: https://ftp.nohrsc.noaa.gov/snowfall/data/YYYYMM/sfav2_CONUS_24h_YYYYMMDD12.nc
(24 h ending 12 UTC). The pattern was inferred from the site's 6 h PNG names
and is checked on every run: if the file is missing the month's directory
listing is printed and the run fails (failures are loud). --probe prints the
NetCDF's variables, units and grid for one day and writes nothing.

Rows (source "nohrsc-snowfall", tier "mid", period_label "24h"):
  snowfall_24h          the cell at the resort point (cm)
  snowfall_24h_max_5x5  max over the 5x5 cells around it (~20 km): a rough
                        stand-in for upper-mountain snowfall, like SNODAS's
No value is written for a cell that is missing / fill (missing is not zero).
Analyses are re-issued for 72 h after the period ends, so a day is marked
done (nohrsc/done/) only once it is 3 days old; younger days are re-fetched
and the newest fetched_at wins in verify.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BASE = "https://ftp.nohrsc.noaa.gov/snowfall/data"
UA = "tabulator-archive/1.0 (+https://github.com/briantafel/tabulator)"
SOURCE = "nohrsc-snowfall"
PARSER_VERSION = "nohrsc-sf-1"
LIVE_DAYS = 6
FINAL_AFTER = timedelta(days=3)
HALF = 2  # 5x5
TIME_LIMIT_S = 50 * 60
PLAUSIBLE_CM = (0, 300)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def http(url: str, retries: int = 3, timeout: int = 120) -> bytes:
    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(5 * attempt)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:
            last = e
    raise RuntimeError(f"{url}: {last}")


def url_for(end: datetime) -> str:
    return f"{BASE}/{end:%Y%m}/sfav2_CONUS_24h_{end:%Y%m%d%H}.nc"


def listing_hint(end: datetime) -> str:
    try:
        html = http(f"{BASE}/{end:%Y%m}/", retries=1).decode("latin1")
        names = sorted({n for n in __import__("re").findall(r"sfav2_[A-Za-z0-9_]+\.[a-z0-9]+", html) if "24h" in n})
        return "24h files in that month's listing: " + (", ".join(names[:12]) or "none")
    except Exception as e:
        return f"(listing unavailable: {e})"


def open_grid(raw: bytes, work: Path, name: str):
    import netCDF4  # noqa: PLC0415  (installed in the workflow only)
    p = work / name
    p.write_bytes(raw)
    ds = netCDF4.Dataset(p)
    return ds


def find_var(ds):
    """The snowfall variable: the one 2-D (or 3-D with a length-1 time) data variable on lat/lon."""
    # Checked 2026-11-17 (probe run 44096687882): Data(lat, lon) in metres, plus lat_bounds / lon_bounds.
    cands = [v for k, v in ds.variables.items() if v.ndim >= 2 and not k.lower().endswith("_bounds")
             and k.lower() not in ("lat", "lon", "latitude", "longitude", "crs")]
    if len(cands) != 1:
        raise RuntimeError(f"expected one data variable, found {[(v.name, v.dimensions) for v in cands]}")
    return cands[0]


def coords(ds):
    lat = next((ds.variables[k][:] for k in ("lat", "latitude") if k in ds.variables), None)
    lon = next((ds.variables[k][:] for k in ("lon", "longitude") if k in ds.variables), None)
    if lat is None or lon is None:
        raise RuntimeError(f"no lat/lon coordinate variables: {list(ds.variables)}")
    return np.asarray(lat, float), np.asarray(lon, float)


def to_cm(units: str) -> float:
    u = (units or "").strip().lower()
    if u in ("m", "meter", "meters", "metre", "metres"):
        return 100.0
    if u in ("cm",):
        return 1.0
    if u in ("mm",):
        return 0.1
    if u in ("in", "inch", "inches"):
        return 2.54
    raise RuntimeError(f"unknown snowfall units '{units}' — check the file before archiving")


def extract(ds, resorts: list[dict]) -> dict[str, tuple[float | None, float | None]]:
    var = find_var(ds)
    grid = np.ma.filled(np.ma.masked_invalid(np.ma.asarray(var[:], dtype=float)), np.nan).squeeze()
    if grid.ndim != 2:
        raise RuntimeError(f"snowfall grid has shape {grid.shape}")
    grid = grid * to_cm(getattr(var, "units", ""))
    lat, lon = coords(ds)
    if lat.ndim != 1 or lon.ndim != 1:
        raise RuntimeError("expected 1-D lat/lon (regular lat-lon grid)")
    out = {}
    for r in resorts:
        la, lo = r["latlon"]
        i, j = int(np.abs(lat - la).argmin()), int(np.abs(lon - lo).argmin())
        if abs(lat[i] - la) > 0.1 or abs(lon[j] - lo) > 0.1:
            continue  # outside the grid (Canada)
        cell = grid[i, j]
        box = grid[max(i - HALF, 0): i + HALF + 1, max(j - HALF, 0): j + HALF + 1]
        mx = np.nanmax(box) if np.isfinite(box).any() else np.nan
        out[r["id"]] = (None if not math.isfinite(cell) or cell < 0 else float(cell),
                        None if not math.isfinite(mx) or mx < 0 else float(mx))
    return out


def bucket(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint] + ([] if args[:1] == ("ls",) else ["--only-show-errors"]),
                          capture_output=True, text=True)


def main() -> int:
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 2
    work, dry, probe = Path(a[0]), "--dry-run" in a, "--probe" in a
    work.mkdir(parents=True, exist_ok=True)
    started = time.time()
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    for r in resorts:
        r["latlon"] = r.get("latlon") or r.get("nws")
    resorts = [r for r in resorts if 24 < r["latlon"][0] < 53 and -126 < r["latlon"][1] < -66]
    now = datetime.now(timezone.utc)
    if "--from" in a:
        d0 = datetime.strptime(a[a.index("--from") + 1], "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
        d1 = datetime.strptime(a[a.index("--to") + 1], "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
        ends = [d0 + timedelta(days=k) for k in range((d1 - d0).days + 1)]
    else:
        last = now.replace(hour=12, minute=0, second=0, microsecond=0)
        if last > now - timedelta(hours=2):
            last -= timedelta(days=1)
        ends = [last - timedelta(days=k) for k in range(LIVE_DAYS)][::-1]

    if probe:
        end = ends[-1]
        u = url_for(end)
        log(f"probe {u}")
        try:
            raw = http(u)
        except urllib.error.HTTPError as e:
            log(f"HTTP {e.code}. {listing_hint(end)}")
            return 1
        ds = open_grid(raw, work, "probe.nc")
        for k, v in ds.variables.items():
            log(f"  {k}: dims={v.dimensions} shape={v.shape} units={getattr(v, 'units', '')!r} "
                f"long_name={getattr(v, 'long_name', '')!r}")
        pts = extract(ds, resorts)
        log(f"  {len(pts)} of {len(resorts)} resorts on the grid; sample: "
            + ", ".join(f"{k}={v[0]}/{v[1]}" for k, v in list(pts.items())[:8]))
        return 0

    done = set()
    if os.environ.get("R2_BUCKET"):
        r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/nohrsc/done/")
        if r.returncode and (r.returncode != 1 or r.stderr.strip()):
            raise RuntimeError(f"listing done markers failed (exit {r.returncode}): {r.stderr.strip()[-300:]}")
        done = {l.split()[-1][:-5] for l in r.stdout.splitlines() if l.strip().endswith(".json")}
    gh = os.environ.get("GITHUB_RUN_ID", "local")
    fetched_at = iso(now)
    ok, waiting, failures = [], [], []
    for end in ends:
        key = f"nohrsc-{end:%Y%m%d%H}"
        if key in done:
            continue
        if time.time() - started > TIME_LIMIT_S:
            waiting.append(f"{key}: time limit")
            continue
        try:
            try:
                raw = http(url_for(end))
            except urllib.error.HTTPError as e:
                if e.code == 404 and now - end < timedelta(hours=30):
                    waiting.append(f"{key}: not published yet")
                    continue
                raise RuntimeError(f"HTTP {e.code} for {url_for(end)}. {listing_hint(end)}")
            ds = open_grid(raw, work, f"{key}.nc")
            pts = extract(ds, resorts)
            ds.close()
            if not pts:
                raise RuntimeError("no resort fell on the grid — check lat/lon handling")
            run_id = f"{end:%Y-%m-%dT%H%M}Z-nohrsc-{gh}"
            rows = []
            for rid, (cell, mx) in pts.items():
                r0 = next(r for r in resorts if r["id"] == rid)
                for variable, v in (("snowfall_24h", cell), ("snowfall_24h_max_5x5", mx)):
                    if v is None:
                        continue
                    if not PLAUSIBLE_CM[0] <= v <= PLAUSIBLE_CM[1]:
                        raise RuntimeError(f"implausible {variable} {v:.1f} cm at {rid}")
                    rows.append({
                        "source": SOURCE, "kind": "analysis", "resort_id": rid, "tier": "mid", "elevation_m": None,
                        "lat": round(r0["latlon"][0], 4), "lon": round(r0["latlon"][1], 4), "station_id": f"nohrsc:{rid}",
                        "issued_at": None, "fetched_at": fetched_at, "valid_start": iso(end - timedelta(days=1)),
                        "valid_end": iso(end), "period_label": "24h", "variable": variable, "value": round(v, 2),
                        "value_text": None, "unit": "cm", "model": None, "member": None, "run_id": run_id,
                        "parser_version": PARSER_VERSION,
                    })
            d = work / run_id
            (d / "rows").mkdir(parents=True, exist_ok=True)
            with gzip.open(d / "rows" / f"{SOURCE}.ndjson.gz", "wt") as f:
                for row in rows:
                    f.write(json.dumps(row) + "\n")
            subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"),
                            run_id, end.strftime("%Y-%m")], check=True)
            if not dry:
                b = os.environ["R2_BUCKET"]
                r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
                if r.returncode:
                    raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
                if now - end >= FINAL_AFTER:
                    (d / "done.json").write_text(json.dumps({"end": iso(end), "rows": len(rows), "run_id": run_id}))
                    r = bucket("cp", str(d / "done.json"), f"s3://{b}/nohrsc/done/{key}.json")
                    if r.returncode:
                        raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")
            snowy = sum(1 for v in pts.values() if v[0] and v[0] >= 2.5)
            ok.append(f"{key}: {len(rows)} rows, {len(pts)} resorts, {snowy} with ≥2.5 cm" + (" (dry run)" if dry else ""))
            log(f"  ✓ {ok[-1]}")
        except Exception as e:
            failures.append(f"{key}: {e}")
            log(f"  ✗ {key}: {e}")
    report = "\n".join(["NOHRSC snowfall:"] + [f"  ✓ {o}" for o in ok] + [f"  … {w}" for w in waiting]
                       + [f"  ✗ {f}" for f in failures] + ([] if ok or waiting or failures else ["  nothing new"]))
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### NOHRSC snowfall\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
