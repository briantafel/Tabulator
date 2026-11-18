#!/usr/bin/env python3
"""More forecast models at our resort points: HRRR precipitation, Canada's HRDPS, NOAA's AIGEFS.

    python3 scripts/archive/extra_models.py <workDir> [--dry-run] [--only MODEL] [--cycle YYYYMMDDHH] [--probe]

Added 2026-11-18. Brian compared our model list with OpenSnow's (EPS, ECMWF,
AIFS, HRRR, GFS, AIGEFS, ICON, RDPS, GDPS). Three gaps were worth closing for
accuracy (global ICON was judged low value and left out):

  noaa-hrrr / hrrr     HRRR 3 km surface file (wrfsfc), 00/06/12/18z to 48 h.
                       Until now we archived HRRR's upper air only, not its
                       precipitation. AWS keeps HRRR from 2014: backfillable.
  msc-hrdps / hrdps    Canada's HRDPS 2.5 km (MSC Datamart), 00/06/12/18z to
                       48 h, every resort on its grid (Canada + northern US).
                       The Datamart keeps about a day: collected live only.
  noaa-aigefs / aigefs NOAA's AI GEFS (operational Dec 2025), NOMADS. NOMADS
                       keeps about a month: collected live only. (--probe
                       prints its file layout; see AIGEFS below.)

Rows match the NBM collector (6 h blocks ending 00/06/12/18 UTC, period_label
null), so the verification table scores them with no special case:
  precip          liquid-equivalent precipitation in the block (mm)
  snow            the model's own snowfall in the block (cm), HRRR only
  temp_min/max    over the block's hourly 2 m temperatures (°C), hourly models
                  only, and only when ≥ 5 of the 6 hours are present
  wind_speed_max  over the block's hourly 10 m winds (km/h), hourly models only
Block precipitation is the difference of the model's run-total accumulation
at the block's end and start. A difference below −0.5 mm fails the run (the
field is not what we think); −0.5…0 is packing noise and stored as 0.

Missing values are never zero: a missing message drops that block, loudly
if a whole lead is missing from a complete cycle.
"""
from __future__ import annotations

import gzip
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from regional_eps import grib_messages  # noqa: E402
from upper_air import (bucket, exists, get_range, grid_from, http, iso, log, merge_ranges,  # noqa: E402
                       nearest, parse_noaa_idx)

ROOT = Path(__file__).resolve().parents[2]
PARSER_VERSION = "extra-models-1"
TIME_LIMIT_S = 50 * 60
BLOCK_H = 6
HRRR_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
MSC_ROOTS = ("https://dd.weather.gc.ca/{d}/WXO-DD/model_hrdps/continental/2.5km",
             "https://dd.weather.gc.ca/model_hrdps/continental/2.5km")
NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com"

MODELS = {
    "hrrr": dict(source="noaa-hrrr", cycles=(0, 6, 12, 18), last=48, ready_h=3, max_km=3.0, keep_days=3),
    "hrdps": dict(source="msc-hrdps", cycles=(0, 6, 12, 18), last=48, ready_h=5, max_km=3.0, keep_days=1),
    "aigefs": dict(source="noaa-aigefs", cycles=(0, 6, 12, 18), last=240, ready_h=6, max_km=20.0, keep_days=5),
}
PLAUSIBLE = {"precip": (0, 300), "snow": (0, 400), "temp_min": (-60, 45), "temp_max": (-60, 45),
             "wind_speed_max": (0, 400)}


# ---------------------------------------------------------------- blocks
def build_blocks(cycle: datetime, acc: dict[int, dict[str, np.ndarray]], inst: dict[int, dict[str, np.ndarray]],
                 last: int) -> list[tuple[datetime, datetime, str, str, np.ndarray]]:
    """(start, end, variable, unit, values) per 6 h block.

    acc: lead → {"precip" mm, "snow" cm} accumulated since the run started
         (lead 0 is zero by definition).
    inst: lead → {"t" °C, "wind" km/h} instants (hourly models)."""
    out = []
    for end_lead in range(BLOCK_H, last + 1, BLOCK_H):
        start_lead = end_lead - BLOCK_H
        a1 = acc.get(end_lead)
        a0 = acc.get(start_lead) if start_lead else {k: 0.0 for k in (a1 or {})}
        if not a1 or a0 is None:
            continue
        start, end = cycle + timedelta(hours=start_lead), cycle + timedelta(hours=end_lead)
        for var, unit in (("precip", "mm"), ("snow", "cm")):
            if var in a1 and var in a0:
                d = np.asarray(a1[var], dtype=float) - np.asarray(a0[var], dtype=float)
                fin = d[np.isfinite(d)]
                if fin.size and fin.min() < -0.5:
                    raise RuntimeError(f"{var} block {start_lead}–{end_lead} h goes negative ({fin.min():.2f}) — "
                                       "the field is not a run-total accumulation")
                out.append((start, end, var, unit, np.where(d < 0, 0.0, d)))
        hours = [inst[l] for l in range(start_lead + 1, end_lead + 1) if l in inst]
        t = [h["t"] for h in hours if "t" in h]
        if len(t) >= 5:
            out.append((start, end, "temp_min", "C", np.nanmin(t, axis=0)))
            out.append((start, end, "temp_max", "C", np.nanmax(t, axis=0)))
        w = [h["wind"] for h in hours if "wind" in h]
        if len(w) >= 5:
            out.append((start, end, "wind_speed_max", "km/h", np.nanmax(w, axis=0)))
    return out


# ---------------------------------------------------------------- HRRR (wrfsfc)
def hrrr_picks(idx: list[dict], lead: int) -> list[tuple[dict, str, str, object]]:
    inst_fc = {"anl", "0 hour fcst"} if lead == 0 else {f"{lead} hour fcst"}
    acc_fc = f"0-{lead} hour acc fcst"
    out = []
    for e in idx:
        key = (e["var"], e["level"])
        if e["fcst"] in inst_fc and key == ("TMP", "2 m above ground"):
            out.append((e, "t", "C", lambda a: a - 273.15))
        elif e["fcst"] in inst_fc and key in (("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")):
            out.append((e, e["var"][0].lower(), "m/s", lambda a: a))
        elif lead % BLOCK_H == 0 and e["fcst"] == acc_fc and key == ("APCP", "surface"):
            out.append((e, "precip", "mm", lambda a: a))
        elif lead % BLOCK_H == 0 and e["fcst"] == acc_fc and key == ("ASNOW", "surface"):
            out.append((e, "snow", "cm", lambda a: a * 100.0))  # m → cm
    return out


def collect_hrrr(cfg, cycle, resorts, deadline):
    leads = list(range(1, cfg["last"] + 1))
    url = lambda l: f"{HRRR_URL}/hrrr.{cycle:%Y%m%d}/conus/hrrr.t{cycle:%H}z.wrfsfcf{l:02d}.grib2"
    if not exists(url(cfg["last"]) + ".idx"):
        raise FileNotFoundError("cycle not complete on the bucket yet")

    def index(l):
        return l, hrrr_picks(parse_noaa_idx(http(url(l) + ".idx").decode()), l)

    with ThreadPoolExecutor(max_workers=16) as pool:
        picks = dict(pool.map(index, leads))
    for l, p in picks.items():
        need = {"t", "u", "v"} | ({"precip"} if l % BLOCK_H == 0 else set())
        have = {v for _, v, _, _ in p}
        if not need <= have:
            raise RuntimeError(f"f{l:02d}: missing {sorted(need - have)} in the .idx — the inventory format may have changed")
    e0 = picks[1][0][0]
    lat, lon = grid_from(get_range(url(1), e0["start"], e0["end"]))
    return fetch_points(cfg, resorts, lat, lon,
                        [(l, url(l), g) for l, p in picks.items() for g in merge_ranges(p)], deadline)


def fetch_points(cfg, resorts, lat, lon, jobs, deadline, workers=16):
    """Byte-range jobs → (ids, pts, {lead: {name: values at resorts}})."""
    pts = nearest(lat, lon, resorts, cfg["max_km"])
    if not pts:
        raise RuntimeError("no resort inside the model grid")
    ids = list(pts)
    cells = np.array([pts[i][0] for i in ids])

    def fetch(job):
        lead, u, group = job
        if time.time() > deadline:
            raise TimeoutError("time limit")
        raw = get_range(u, group[0][0]["start"], group[-1][0]["end"])
        msgs = [np.asarray(v, dtype=float)[cells] for _, v in grib_messages(raw)]
        if len(msgs) != len(group):
            raise RuntimeError(f"{u.rsplit('/', 1)[-1]}: {len(msgs)} GRIB messages for {len(group)} index entries")
        return lead, group, msgs, len(raw)

    vals: dict[int, dict[str, np.ndarray]] = {}
    nbytes, t0 = 0, time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for lead, group, msgs, n in pool.map(fetch, jobs):
            nbytes += n
            for (_, name, _, tf), arr in zip(group, msgs):
                if name is None:
                    continue
                arr = np.where(np.abs(arr) > 1e19, np.nan, arr)
                vals.setdefault(lead, {})[name] = tf(arr)
    log(f"    {len(ids)} resorts on the grid; fetched {nbytes / 1e6:.0f} MB in {time.time() - t0:.0f} s")
    return ids, pts, vals


def split(vals: dict[int, dict[str, np.ndarray]]):
    """Per-lead fields → (accumulations, instants with wind speed in km/h)."""
    acc, inst = {}, {}
    for l, f in vals.items():
        a = {k: f[k] for k in ("precip", "snow") if k in f}
        if a:
            acc[l] = a
        i = {}
        if "t" in f:
            i["t"] = f["t"]
        if "u" in f and "v" in f:
            i["wind"] = np.hypot(f["u"], f["v"]) * 3.6
        elif "wind" in f:
            i["wind"] = f["wind"] * 3.6
        if i:
            inst[l] = i
    return acc, inst


# ---------------------------------------------------------------- HRDPS (MSC Datamart)
HRDPS_FILES = (("TMP", "AGL-2m", "t", lambda a: a - 273.15), ("WIND", "AGL-10m", "wind", lambda a: a),
               ("APCP", "Sfc", "precip", lambda a: a))


def hrdps_url(root: str, cycle: datetime, lead: int, var: str, level: str) -> str:
    base = root.format(d=f"{cycle:%Y%m%d}")
    return (f"{base}/{cycle:%H}/{lead:03d}/{cycle:%Y%m%dT%HZ}_MSC_HRDPS_{var}_{level}_RLatLon0.0225_PT{lead:03d}H.grib2")


def collect_hrdps(cfg, cycle, resorts, deadline):
    root = next((r for r in MSC_ROOTS if exists(hrdps_url(r, cycle, cfg["last"], "APCP", "Sfc"))), None)
    if root is None:
        raise FileNotFoundError("cycle not complete on the Datamart (or older than its ~1 day)")
    jobs = []
    for l in range(1, cfg["last"] + 1):
        for var, level, name, tf in HRDPS_FILES:
            if name == "precip" and l % BLOCK_H:
                continue
            jobs.append((l, hrdps_url(root, cycle, l, var, level), name, tf))
    lat, lon = grid_from(http(jobs[0][1]))
    pts = nearest(lat, lon, resorts, cfg["max_km"])
    if not pts:
        raise RuntimeError("no resort inside the HRDPS grid")
    ids = list(pts)
    cells = np.array([pts[i][0] for i in ids])
    del lat, lon

    def fetch(job):
        l, u, name, tf = job
        if time.time() > deadline:
            raise TimeoutError("time limit")
        try:
            raw = http(u)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return l, name, None, 0
            raise
        msgs = [np.asarray(v, dtype=float)[cells] for _, v in grib_messages(raw)]
        if len(msgs) != 1:
            raise RuntimeError(f"{u.rsplit('/', 1)[-1]}: {len(msgs)} GRIB messages, expected 1")
        arr = np.where(np.abs(msgs[0]) > 1e19, np.nan, msgs[0])
        return l, name, tf(arr), len(raw)

    vals: dict[int, dict[str, np.ndarray]] = {}
    missing, nbytes, t0 = [], 0, time.time()
    with ThreadPoolExecutor(max_workers=8) as pool:  # MSC asks for moderate load
        for l, name, arr, n in pool.map(fetch, jobs):
            nbytes += n
            if arr is None:
                missing.append(f"{name}@{l}h")
            else:
                vals.setdefault(l, {})[name] = arr
    log(f"    {len(ids)} resorts on the grid ({root.split('/')[3] if '{d}' in root else 'legacy path'}); "
        f"fetched {nbytes / 1e6:.0f} MB in {time.time() - t0:.0f} s")
    if missing:
        raise RuntimeError(f"{len(missing)} files missing from a complete cycle (first: {missing[0]})")
    return ids, pts, vals


# ---------------------------------------------------------------- AIGEFS (NOMADS)
def probe_aigefs() -> None:
    """Print what NOMADS (and any AWS mirror) holds for AIGEFS, so the
    collector can be written against the real layout."""
    import html
    now = datetime.now(timezone.utc)
    for name in ("aigefs", "aigfs", "hgefs"):
        u = f"{NOMADS}/{name}/prod/"
        try:
            text = http(u, retries=1).decode(errors="replace")
            dirs = re.findall(r'href="([^"?/][^"]*/)"', text)
            log(f"{u}: {dirs[-4:]}")
        except Exception as e:
            log(f"{u}: {e}")
            continue
        if not dirs:
            continue
        day = dirs[-1]
        try:
            sub = http(u + day, retries=1).decode(errors="replace")
            hours = re.findall(r'href="([^"?/][^"]*/)"', sub)
            log(f"  {day}: {hours}")
            path = u + day + (hours[0] if hours else "")
            for _ in range(5):  # walk down the first branch to the files
                sub = http(path, retries=1).decode(errors="replace")
                links = [html.unescape(x) for x in re.findall(r'href="([^"?][^"]*)"', sub) if not x.startswith("/")]
                files = [x for x in links if not x.endswith("/")]
                log(f"  {path}: {len(links)} entries; first {links[:8]}")
                if files:
                    log(f"  sample files: {files[:6]} … {files[-4:]}")
                    idx = next((f for f in files if f.endswith(".idx")), None)
                    if idx:
                        text = http(path + idx, retries=1).decode(errors="replace")
                        log("  sample .idx:\n    " + "\n    ".join(text.splitlines()[:40]))
                    break
                path += links[0]
        except Exception as e:
            log(f"  walk failed: {e}")
    for b in ("noaa-nws-aigefs-pds", "noaa-aigefs-pds", "noaa-nws-aigfs-pds", "noaa-aigfs-pds", "noaa-oar-mlwp-data"):
        try:
            text = http(f"https://{b}.s3.amazonaws.com/?list-type=2&max-keys=5&delimiter=/", retries=0).decode()
            log(f"s3 {b}: {re.findall(r'<Prefix>([^<]*)</Prefix>', text)[:8]}")
        except Exception as e:
            log(f"s3 {b}: {e}")
    log(f"probe done {iso(now)}")


def collect_aigefs(cfg, cycle, resorts, deadline):
    raise RuntimeError("AIGEFS collection is not written yet — run --probe and implement against the layout it prints")


COLLECT = {"hrrr": collect_hrrr, "hrdps": collect_hrdps, "aigefs": collect_aigefs}


# ---------------------------------------------------------------- rows
def to_rows(model, cfg, cycle, ids, pts, vals, fetched_at, run_id):
    acc, inst = split(vals)
    blocks = build_blocks(cycle, acc, inst, cfg["last"])
    rows, bad = [], []
    for start, end, var, unit, arr in blocks:
        fin = arr[np.isfinite(arr)]
        lo, hi = PLAUSIBLE[var]
        if fin.size and (fin.min() < lo or fin.max() > hi):
            bad.append(f"{var} outside {(lo, hi)} (min {fin.min():.2f}, max {fin.max():.2f})")
        for k, rid in enumerate(ids):
            v = float(arr[k])
            if not math.isfinite(v):
                continue
            rows.append({
                "source": cfg["source"], "kind": "forecast", "resort_id": rid, "tier": "mid", "elevation_m": None,
                "lat": round(pts[rid][1], 4), "lon": round(pts[rid][2], 4), "station_id": None,
                "issued_at": iso(cycle), "fetched_at": fetched_at, "valid_start": iso(start), "valid_end": iso(end),
                "period_label": None, "variable": var, "value": round(v, 2), "value_text": None, "unit": unit,
                "model": model, "member": None, "run_id": run_id, "parser_version": PARSER_VERSION,
            })
    if bad:
        raise RuntimeError("implausible values — not archived: " + "; ".join(sorted(set(bad))))
    have = {r["variable"] for r in rows}
    if "precip" not in have:
        raise RuntimeError("no precipitation blocks built")
    for var in sorted(have):
        v = [r["value"] for r in rows if r["variable"] == var]
        log(f"    {var}: {len(v)} rows, min {min(v):.2f} max {max(v):.2f} mean {sum(v) / len(v):.2f}")
    return rows


def main() -> int:
    a = sys.argv[1:]
    if "--probe" in a:
        probe_aigefs()
        return 0
    if not a:
        print(__doc__)
        return 2
    work, dry = Path(a[0]), "--dry-run" in a
    only = a[a.index("--only") + 1] if "--only" in a else None
    if only and only not in MODELS:
        log(f"unknown model {only}; one of {', '.join(MODELS)}")
        return 2
    started = time.time()
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    for r in resorts:
        r["latlon"] = r.get("latlon") or r.get("nws")
    done = set()
    if os.environ.get("R2_BUCKET") and not dry:
        r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/extra-models/done/")
        if r.returncode and (r.returncode != 1 or r.stderr.strip()):
            raise RuntimeError(f"listing done markers failed (exit {r.returncode}): {r.stderr.strip()[-300:]}")
        done = {l.split()[-1][:-5] for l in r.stdout.splitlines() if l.strip().endswith(".json")}
    now = datetime.now(timezone.utc)
    gh = os.environ.get("GITHUB_RUN_ID", "local")
    fetched_at = iso(now)
    ok, waiting, failures = [], [], []
    for model, cfg in MODELS.items():
        if only and model != only:
            continue
        if model == "aigefs" and not only:
            continue  # not written yet (see probe)
        if "--cycle" in a:
            cands = [datetime.strptime(a[a.index("--cycle") + 1], "%Y%m%d%H").replace(tzinfo=timezone.utc)]
        else:
            days = cfg["keep_days"]
            cands = sorted({datetime(d.year, d.month, d.day, h, tzinfo=timezone.utc)
                            for d in (now - timedelta(days=i) for i in range(days + 1)) for h in cfg["cycles"]}, reverse=True)
            cands = [c for c in cands if timedelta(hours=cfg["ready_h"]) < now - c < timedelta(days=days)]
        for cycle in cands:
            key = f"{model}-{cycle:%Y%m%d%H}"
            if key in done:
                continue
            if time.time() - started > TIME_LIMIT_S - 5 * 60:
                waiting.append(f"{key}: time limit (next run continues)")
                continue
            t = time.time()
            log(f"  {key}:")
            try:
                run_id = f"{cycle:%Y-%m-%dT%H%M}Z-{model}-sfc-{gh}"
                ids, pts, vals = COLLECT[model](cfg, cycle, resorts, started + TIME_LIMIT_S)
                rows = to_rows(model, cfg, cycle, ids, pts, vals, fetched_at, run_id)
                d = work / run_id
                (d / "rows").mkdir(parents=True, exist_ok=True)
                with gzip.open(d / "rows" / f"{cfg['source']}.ndjson.gz", "wt") as f:
                    for r in rows:
                        f.write(json.dumps(r) + "\n")
                subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"),
                                str(d / "up/archive"), run_id, cycle.strftime("%Y-%m")], check=True)
                if not dry:
                    b = os.environ["R2_BUCKET"]
                    r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
                    if r.returncode:
                        raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
                    (d / "done.json").write_text(json.dumps({"cycle": iso(cycle), "rows": len(rows), "run_id": run_id}))
                    r = bucket("cp", str(d / "done.json"), f"s3://{b}/extra-models/done/{key}.json")
                    if r.returncode:
                        raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")
                ok.append(f"{key}: {len(rows)} rows in {time.time() - t:.0f} s" + (" (dry run)" if dry else ""))
                log(f"  ✓ {ok[-1]}")
                if dry:
                    break
            except FileNotFoundError as e:
                waiting.append(f"{key}: {e}")
            except TimeoutError:
                waiting.append(f"{key}: time limit (next run continues)")
            except Exception as e:
                failures.append(f"{key}: {e}")
                log(f"  ✗ {key}: {e}")
    report = "\n".join(["More models (HRRR precip, HRDPS, AIGEFS):"] + [f"  ✓ {o}" for o in ok]
                       + [f"  … {w}" for w in waiting] + [f"  ✗ {f}" for f in failures]
                       + ([] if ok or waiting or failures else ["  nothing new"]))
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### More models\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
