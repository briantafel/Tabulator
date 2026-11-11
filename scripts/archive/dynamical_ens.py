#!/usr/bin/env python3
"""Global ensembles from dynamical.org at our resort points (free, no quota).

    python3 scripts/archive/dynamical_ens.py <workDir> live     [--dry-run] [--only MODEL]
    python3 scripts/archive/dynamical_ens.py <workDir> backfill  <from> <to> [--dry-run] [--only MODEL]

Added 2026-11-11 (claude/lean-data-plan.md, Phase 1). Reads dynamical.org's
Icechunk/Zarr copies on AWS (CC BY 4.0; ECMWF data also under ECMWF's terms;
attribution "… from dynamical.org"). Source "dynamical-ens", one model per
dataset:

  ecmwf_ifs_ens   ECMWF IFS ENS 0.25°, 51 members, 00z, to 360 h, archive from 2024-04-01
  gefs            NOAA GEFS 0.25°, 31 members, 00z, first 384 h kept, archive from 2020-10-01
  ecmwf_aifs_ens  ECMWF AIFS ENS 0.25°, 51 members, 00/06/12/18z, to 360 h, archive from 2025-07-02

Facts from the probe run (2026-11-11): precipitation_surface is a RATE
(kg m-2 s-1) averaged over the interval ending at each lead, so interval
precipitation = rate × interval seconds. Temperatures are °C, winds m s-1.
Grids are 0.25° regular, latitude 90 → -90, longitude -180 → 179.75.

Rows: 6-hour blocks aligned to 00/06/12/18 UTC, the same names as the other
ensemble sources (precip mm, temp_min/temp_max °C, wind_speed_max km/h), plus
snow-to-liquid predictors where the model has them: temp_850_mean,
temp_925_mean, dewpoint_2m_mean (ECMWF), rh_2m_mean and frozen_pct_mean
(GEFS), gust_max (ECMWF IFS). elevation_m is the grid cell's approximate
height from the hypsometric equation (surface vs sea-level pressure), so it
is approximate (±~50 m). issued_at is the exact init time. A block only
partly covered is not written: missing is not zero.

Done markers in the bucket (dynamical/done/<model>-<YYYYMMDDHH>.json) make
every run collect only what is new, so late or skipped runs lose nothing
while dynamical.org keeps the history.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
PARSER_VERSION = "dynamical-ens-1"
SOURCE = "dynamical-ens"
BLOCK_H = 6
TIME_LIMIT_S = 50 * 60
RD, G = 287.05, 9.80665

DATASETS = {
    "ecmwf_ifs_ens": dict(id="ecmwf-ifs-ens-forecast-15-day-0-25-degree", max_h=360,
                          extra={"temperature_850hpa": "temp_850_mean", "temperature_925hpa": "temp_925_mean",
                                 "dew_point_temperature_2m": "dewpoint_2m_mean"}, gust="wind_gust_10m"),
    "gefs": dict(id="noaa-gefs-forecast-35-day", max_h=384,
                 extra={"relative_humidity_2m": "rh_2m_mean", "percent_frozen_precipitation_surface": "frozen_pct_mean"},
                 gust=None),
    "ecmwf_aifs_ens": dict(id="ecmwf-aifs-ens-forecast", max_h=360,
                           extra={"temperature_850hpa": "temp_850_mean", "temperature_925hpa": "temp_925_mean",
                                  "dew_point_temperature_2m": "dewpoint_2m_mean"}, gust=None),
}

PLAUSIBLE = {"precip": (0, 300), "temp_min": (-60, 45), "temp_max": (-60, 45), "wind_speed_max": (0, 400),
             "gust_max": (0, 500), "temp_850_mean": (-60, 40), "temp_925_mean": (-60, 45),
             "dewpoint_2m_mean": (-70, 40), "rh_2m_mean": (0, 100.5), "frozen_pct_mean": (-0.5, 100.5)}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- bucket
def bucket(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint, "--only-show-errors"],
                          capture_output=True, text=True)


def done_markers() -> set[str]:
    if not os.environ.get("R2_BUCKET"):
        return set()
    r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/dynamical/done/")
    return {line.split()[-1][:-5] for line in r.stdout.splitlines() if line.strip().endswith(".json")}


# ---------------------------------------------------------------- rows from one init
def block_start(t: datetime) -> datetime:
    return t.replace(hour=(t.hour // BLOCK_H) * BLOCK_H, minute=0, second=0, microsecond=0)


def build_blocks(model: str, init: datetime, leads_h: list[float], data: dict[str, np.ndarray],
               resorts: list[dict], cell_lat: np.ndarray, cell_lon: np.ndarray, elev: np.ndarray,
               fetched_at: str, run_id: str, extra: dict[str, str], gust: str | None) -> list[dict]:
    """data[var] has shape (lead, member, resort)."""
    n_lead, n_mem, n_res = data["precipitation_surface"].shape
    blocks: dict[datetime, dict] = {}

    def blk(t):
        return blocks.setdefault(t, {"hours": 0.0, "precip": np.zeros((n_mem, n_res)), "t": [], "w": [], "g": [],
                                     **{k: [] for k in extra}})

    for k in range(1, n_lead):
        h0, h1 = leads_h[k - 1], leads_h[k]
        t0, t1 = init + timedelta(hours=h0), init + timedelta(hours=h1)
        b0 = block_start(t0)
        if t1 > b0 + timedelta(hours=BLOCK_H):  # interval crosses a block edge: cannot split a mean rate honestly
            continue
        b = blk(b0)
        b["hours"] += h1 - h0
        rate = data["precipitation_surface"][k]
        b["precip"] = b["precip"] + np.where(np.isnan(rate), np.nan, rate * (h1 - h0) * 3600.0)
        # instants at the END of the interval belong to this block
        b["t"].append(data["temperature_2m"][k])
        b["w"].append(np.hypot(data["wind_u_10m"][k], data["wind_v_10m"][k]) * 3.6)
        if gust and gust in data:
            b["g"].append(data[gust][k] * 3.6)
        for var in extra:
            if var in data:
                v = data[var][k]
                if var == "percent_frozen_precipitation_surface":
                    # NCEP writes -50 for "no precipitation": a code, not a value.
                    v = np.where(v < 0, np.nan, v)
                b[var].append(v)

    out = []  # (variable, unit, valid_start, valid_end, array[member, resort])
    for bstart, b in sorted(blocks.items()):
        if abs(b["hours"] - BLOCK_H) > 1e-6:
            continue
        vals = [("precip", b["precip"], "mm"),
                ("temp_min", np.min(b["t"], axis=0), "C"), ("temp_max", np.max(b["t"], axis=0), "C"),
                ("wind_speed_max", np.max(b["w"], axis=0), "km/h")]
        if b["g"]:
            vals.append(("gust_max", np.max(b["g"], axis=0), "km/h"))
        for var, name in extra.items():
            if b[var]:
                unit = "%" if name in ("rh_2m_mean", "frozen_pct_mean") else "C"
                with np.errstate(all="ignore"):
                    import warnings
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN slice = no precip: no row
                        mean = np.nanmean(b[var], axis=0) if name == "frozen_pct_mean" else np.mean(b[var], axis=0)
                vals.append((name, mean, unit))
        vs, ve = iso(bstart), iso(bstart + timedelta(hours=BLOCK_H))
        for variable, arr, unit in vals:
            out.append((variable, unit, vs, ve, arr))
    return out


def iter_rows(blocks, model, init, resorts, cell_lat, cell_lon, elev, fetched_at, run_id):
    """Archive rows, streamed: a single ECMWF init is ~2.6 million of them."""
    el = [int(round(float(e))) if math.isfinite(float(e)) else None for e in elev]
    for variable, unit, vs, ve, arr in blocks:
        n_mem, n_res = arr.shape
        for m in range(n_mem):
            for r in range(n_res):
                v = float(arr[m, r])
                if not math.isfinite(v):
                    continue
                yield {
                    "source": SOURCE, "kind": "forecast", "resort_id": resorts[r]["id"], "tier": "mid",
                    "elevation_m": el[r], "lat": float(cell_lat[r]), "lon": float(cell_lon[r]), "station_id": None,
                    "issued_at": iso(init), "fetched_at": fetched_at, "valid_start": vs, "valid_end": ve,
                    "period_label": None, "variable": variable, "value": round(v, 2), "value_text": None,
                    "unit": unit, "model": model, "member": m, "run_id": run_id, "parser_version": PARSER_VERSION,
                }


def check_plausible(blocks) -> None:
    by: dict[str, list[np.ndarray]] = {}
    for variable, _, _, _, arr in blocks:
        by.setdefault(variable, []).append(arr.ravel())
    bad = []
    for var, parts in sorted(by.items()):
        vals = np.concatenate(parts)
        vals = vals[np.isfinite(vals)]
        if not len(vals):
            continue
        lo, hi = float(vals.min()), float(vals.max())
        log(f"    {var}: min {lo:.2f} max {hi:.2f} mean {float(vals.mean()):.2f} ({len(vals)})")
        b = PLAUSIBLE.get(var)
        if b and (lo < b[0] or hi > b[1]):
            bad.append(f"{var} outside {b} (min {lo:.2f}, max {hi:.2f})")
    if bad:
        raise RuntimeError("implausible values — not archived: " + "; ".join(bad))


# ---------------------------------------------------------------- read one init
def read_init(ds, model: str, cfg: dict, init: datetime, resorts: list[dict], lat, lon, fetched_at: str, run_id: str):
    import xarray as xr  # noqa: F401
    sel = ds.sel(init_time=np.datetime64(init.replace(tzinfo=None), "ns"))
    lead_ns = sel.lead_time.values.astype("timedelta64[s]").astype(float) / 3600.0
    keep = lead_ns <= cfg["max_h"]
    sel = sel.isel(lead_time=np.where(keep)[0])
    leads_h = list(lead_ns[keep])
    pts = sel.sel(latitude=lat, longitude=lon, method="nearest")
    names = ["precipitation_surface", "temperature_2m", "wind_u_10m", "wind_v_10m",
             "pressure_surface", "pressure_reduced_to_mean_sea_level", *cfg["extra"]]
    if cfg["gust"]:
        names.append(cfg["gust"])
    data = {}
    for n in names:
        if n in pts:
            data[n] = pts[n].transpose("lead_time", "ensemble_member", "resort").values.astype("float64")
    missing = [n for n in ("precipitation_surface", "temperature_2m", "wind_u_10m", "wind_v_10m") if n not in data]
    if missing:
        raise RuntimeError(f"required variables missing: {missing}")
    if np.all(np.isnan(data["precipitation_surface"][1:])):
        raise RuntimeError("precipitation is all missing (init not fully published?)")
    # Approximate grid height from surface vs sea-level pressure (hypsometric),
    # averaged over members and the first day's instants.
    elev = np.full(len(resorts), np.nan)
    if "pressure_surface" in data and "pressure_reduced_to_mean_sea_level" in data:
        k = slice(0, min(9, len(leads_h)))
        ps = np.nanmean(data["pressure_surface"][k], axis=(0, 1))
        pm = np.nanmean(data["pressure_reduced_to_mean_sea_level"][k], axis=(0, 1))
        tk = np.nanmean(data["temperature_2m"][k], axis=(0, 1)) + 273.15
        elev = RD * tk / G * np.log(pm / ps)
    blocks = build_blocks(model, init, leads_h, data, resorts, pts.latitude.values, pts.longitude.values, elev,
                          fetched_at, run_id, cfg["extra"], cfg["gust"])
    return blocks, (pts.latitude.values, pts.longitude.values, elev)


def write_and_upload(work: Path, model: str, init: datetime, rows, run_id: str, dry: bool) -> int:
    d = work / run_id
    (d / "rows").mkdir(parents=True, exist_ok=True)
    n = 0
    with gzip.open(d / "rows" / f"{SOURCE}.ndjson.gz", "wt", compresslevel=3) as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
            n += 1
    subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"),
                    run_id, init.strftime("%Y-%m")], check=True)
    marker = d / "done.json"
    marker.write_text(json.dumps({"model": model, "init": iso(init), "rows": n, "run_id": run_id}))
    if dry:
        log(f"    dry run: {n} rows built, nothing uploaded")
        return n
    b = os.environ["R2_BUCKET"]
    r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
    if r.returncode:
        raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
    r = bucket("cp", str(marker), f"s3://{b}/dynamical/done/{model}-{init:%Y%m%d%H}.json")
    if r.returncode:
        raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")
    import shutil
    shutil.rmtree(d, ignore_errors=True)
    return n


def main() -> int:
    a = sys.argv[1:]
    if len(a) < 2 or a[1] not in ("live", "backfill"):
        print(__doc__)
        return 2
    import dynamical_catalog as dc
    import xarray as xr
    dc.identify("tabulator snow-forecast archive (github.com/briantafel/tabulator)")
    work, mode = Path(a[0]), a[1]
    dry = "--dry-run" in a
    only = a[a.index("--only") + 1] if "--only" in a else None
    started = time.time()
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    lat = xr.DataArray([(r.get("latlon") or r["nws"])[0] for r in resorts], dims="resort")
    lon = xr.DataArray([(r.get("latlon") or r["nws"])[1] for r in resorts], dims="resort")
    done = done_markers()
    now = datetime.now(timezone.utc)
    fetched_at = iso(now)
    gh = os.environ.get("GITHUB_RUN_ID", "local")
    if mode == "backfill":
        lo = datetime.fromisoformat(a[2]).replace(tzinfo=timezone.utc)
        hi = datetime.fromisoformat(a[3]).replace(tzinfo=timezone.utc)
    else:
        lo, hi = now - timedelta(days=3), now
    ok, failures, left = [], [], 0
    for model, cfg in DATASETS.items():
        if only and model != only:
            continue
        ds = dc.open(cfg["id"])
        inits = [datetime.fromtimestamp(t.astype("datetime64[s]").astype(int), timezone.utc) for t in ds.init_time.values]
        todo = [t for t in inits if lo <= t <= hi and f"{model}-{t:%Y%m%d%H}" not in done]
        log(f"{model}: {len(todo)} init(s) to collect in {iso(lo)} … {iso(hi)}")
        for init in sorted(todo, reverse=(mode == "live")):
            if time.time() - started > TIME_LIMIT_S:
                left += 1
                continue
            key = f"{model}-{init:%Y%m%d%H}"
            t = time.time()
            try:
                run_id = f"{init:%Y-%m-%dT%H%M}Z-{model}-{gh}"
                blocks, (clat, clon, elev) = read_init(ds, model, cfg, init, resorts, lat, lon, fetched_at, run_id)
                if not blocks:
                    raise RuntimeError("no complete 6-hour blocks")
                check_plausible(blocks)
                n = write_and_upload(work, model, init,
                                     iter_rows(blocks, model, init, resorts, clat, clon, elev, fetched_at, run_id),
                                     run_id, dry)
                ok.append(f"{key}: {n} rows")
                log(f"  ✓ {key}: {n} rows in {time.time() - t:.0f} s")
            except Exception as e:
                # In live mode the newest init may still be publishing: that is a wait, not a failure.
                if mode == "live" and now - init < timedelta(hours=10) and "all missing" in str(e):
                    log(f"  … {key}: not fully published yet")
                    continue
                failures.append(f"{key}: {e}")
                log(f"  ✗ {key}: {e}")
    lines = [f"dynamical.org ensembles ({mode}):", f"  ✓ {len(ok)} init(s) archived"] + [f"    {o}" for o in ok[-12:]]
    if left:
        lines.append(f"  … {left} init(s) left for the next run (time limit)")
    lines += [f"  ✗ {f}" for f in failures]
    report = "\n".join(lines)
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### dynamical.org ensembles\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
