#!/usr/bin/env python3
"""NOAA National Blend of Models (NBM) at our resort points: the US baseline.

    python3 scripts/archive/nbm.py <workDir> [--dry-run] [--cycle YYYYMMDDHH]

Added 2026-11-11 (claude/lean-data-plan.md, Phase 1). NBM is NOAA's own
bias-corrected, calibrated blend of ~30 models. It is the bar Tabulator has to
beat at US resorts, and also an input. Read from NOAA's free AWS bucket
(noaa-nbm-grib2-pds, NOAA open data, no restrictions; attribution "NOAA
National Blend of Models"). Only the GRIB messages we need are downloaded,
by byte range from each file's .idx.

CONUS 2.5 km grid: US resorts, and southern Canada where the grid reaches
(each resort uses the nearest grid point within MAX_KM). Cycles 00z and 12z,
so 6-hour blocks align with the other sources; the log reports each cycle's
last lead.

Rows: 6-hour blocks aligned to 00/06/12/18 UTC (source "nbm", model "nbm"):
  precip          APCP 6 h accumulation (mm), deterministic (no prob/std lines)
  snow            ASNOW 6 h accumulation (m → cm), NBM's own snow-to-liquid
  temp_min/max    from 2 m TMP at the block's available instants (°C)
  wind_speed_max  from 10 m WIND at the block's instants (km/h)
issued_at is the exact cycle time. A block without its 6 h APCP is not
written: missing is not zero. Done markers in the bucket (nbm/done/) make
each run collect only new cycles. NBM history on AWS goes back to 2020, so
this can be backfilled later.
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
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from regional_eps import grib_messages  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BUCKET_URL = "https://noaa-nbm-grib2-pds.s3.amazonaws.com"
UA = "tabulator-archive/1.0 (+https://github.com/briantafel/tabulator)"
PARSER_VERSION = "nbm-1"
SOURCE = "nbm"
# 00z/12z: their 6-hour accumulations end on 00/06/12/18 UTC like every other
# source. The log reports each cycle's last lead (extended range check).
CYCLES = (0, 12)
MAX_KM = 3.0
BLOCK_H = 6
TIME_LIMIT_S = 50 * 60
PLAUSIBLE = {"precip": (0, 300), "snow": (0, 400), "temp_min": (-60, 45), "temp_max": (-60, 45),
             "wind_speed_max": (0, 400)}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def http(url: str, headers: dict | None = None, retries: int = 3, timeout: int = 60) -> bytes:
    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(5 * attempt)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:
            last = e
    raise RuntimeError(f"{url}: {last}")


def list_leads(cycle: datetime) -> dict[int, str]:
    """lead hour → grib key for one cycle's CONUS core files."""
    prefix = f"blend.{cycle:%Y%m%d}/{cycle:%H}/core/"
    out, token = {}, None
    while True:
        q = f"?list-type=2&prefix={prefix}&max-keys=1000" + (f"&continuation-token={urllib.request.quote(token)}" if token else "")
        xml = http(BUCKET_URL + "/" + q).decode()
        for key in re.findall(r"<Key>([^<]+)</Key>", xml):
            m = re.search(r"core\.f(\d{3})\.co\.grib2$", key)
            if m:
                out[int(m.group(1))] = key
        nxt = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
        if not nxt:
            return out
        token = nxt.group(1)


def parse_idx(text: str) -> list[tuple[int, int | None, str, str, str]]:
    """(offset, end, var, level, fcst) for DETERMINISTIC lines only. Lines with
    extra fields ("prob >0.254", "ens std dev", percentiles) are skipped."""
    lines = [l for l in text.strip().splitlines() if l]
    rows = []
    for i, line in enumerate(lines):
        f = line.split(":")
        start = int(f[1])
        end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else None
        extra = [x for x in f[6:] if x.strip()]
        if extra:
            continue
        rows.append((start, end, f[3], f[4], f[5]))
    return rows


def pick(idx, var: str, level: str, fcst: str):
    for start, end, v, lv, fc in idx:
        if v == var and lv == level and fc == fcst:
            return start, end
    return None


def fetch_field(key: str, rng) -> np.ndarray:
    start, end = rng
    hdr = {"Range": f"bytes={start}-{end}" if end is not None else f"bytes={start}-"}
    raw = http(f"{BUCKET_URL}/{key}", headers=hdr)
    for _, vals in grib_messages(raw):
        return np.asarray(vals)
    raise RuntimeError(f"no GRIB message in {key} bytes {start}-{end}")


def grid_points(key: str, rng, resorts: list[dict]) -> dict[str, int]:
    import eccodes
    import tempfile
    start, end = rng
    raw = http(f"{BUCKET_URL}/{key}", headers={"Range": f"bytes={start}-{end}"})
    with tempfile.NamedTemporaryFile(suffix=".grib2") as f:
        f.write(raw)
        f.flush()
        with open(f.name, "rb") as fh:
            gid = eccodes.codes_grib_new_from_file(fh)
            lat = np.asarray(eccodes.codes_get_array(gid, "latitudes"))
            lon = np.asarray(eccodes.codes_get_array(gid, "longitudes"))
            eccodes.codes_release(gid)
    lon = np.where(lon > 180, lon - 360, lon)
    out = {}
    for r in resorts:
        la, lo = r["latlon"]
        if not (lat.min() - 0.5 <= la <= lat.max() + 0.5 and lon.min() - 0.5 <= lo <= lon.max() + 0.5):
            continue
        box = np.where((np.abs(lat - la) < 0.1) & (np.abs(lon - lo) < 0.15))[0]
        if not len(box):
            continue
        p, q = math.radians(la), math.radians(lo)
        d = 2 * 6371 * np.arcsin(np.sqrt(np.sin((np.radians(lat[box]) - p) / 2) ** 2 +
                                         math.cos(p) * np.cos(np.radians(lat[box])) * np.sin((np.radians(lon[box]) - q) / 2) ** 2))
        i = int(np.argmin(d))
        if d[i] <= MAX_KM:
            out[r["id"]] = (int(box[i]), float(lat[box[i]]), float(lon[box[i]]))
    return out


def collect_cycle(cycle: datetime, resorts: list[dict], fetched_at: str, run_id: str) -> list[dict]:
    leads = list_leads(cycle)
    if not leads:
        raise FileNotFoundError("cycle not on the bucket yet")
    last = max(leads)
    log(f"  cycle {cycle:%Y-%m-%d %H}z: {len(leads)} lead files, last f{last:03d}")
    # The hours we need: every 3 h (instants for temp/wind) and every 6 h (accumulations).
    want = [l for l in sorted(leads) if l >= 1 and (l % 3 == 0)]

    def job(lead):
        key = leads[lead]
        idx = parse_idx(http(f"{BUCKET_URL}/{key}.idx").decode())
        got = {}
        for name, var, level, fc in (("tmp", "TMP", "2 m above ground", f"{lead} hour fcst"),
                                     ("wind", "WIND", "10 m above ground", f"{lead} hour fcst"),
                                     ("apcp", "APCP", "surface", f"{lead - 6}-{lead} hour acc fcst"),
                                     ("asnow", "ASNOW", "surface", f"{lead - 6}-{lead} hour acc fcst")):
            if name in ("apcp", "asnow") and lead % 6:
                continue
            rng = pick(idx, var, level, fc)
            if rng:
                got[name] = (key, rng)
        return lead, got

    with ThreadPoolExecutor(max_workers=8) as pool:
        index = dict(pool.map(job, want))
    first = next((g["tmp"] for _, g in sorted(index.items()) if "tmp" in g), None)
    if not first:
        raise RuntimeError("no 2 m temperature found in any .idx — the inventory format may have changed")
    pts = grid_points(*first, resorts)
    if not pts:
        raise RuntimeError("no resort inside the NBM CONUS grid")
    ids = list(pts)
    cells = np.array([pts[i][0] for i in ids])
    log(f"  {len(ids)} resorts on the grid")

    def fetch(item):
        lead, name, (key, rng) = item
        return lead, name, fetch_field(key, rng)[cells]

    items = [(lead, name, kr) for lead, g in index.items() for name, kr in g.items()]
    vals: dict[int, dict[str, np.ndarray]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for lead, name, arr in pool.map(fetch, items):
            vals.setdefault(lead, {})[name] = arr
    log(f"  fetched {len(items)} fields")

    rows = []
    for lead in sorted(vals):
        if lead % 6 or "apcp" not in vals[lead]:
            continue
        end = cycle + timedelta(hours=lead)
        start = end - timedelta(hours=BLOCK_H)
        if start.hour % BLOCK_H:
            continue
        inst = [vals[l] for l in vals if lead - 6 < l <= lead]
        out = {"precip": (vals[lead]["apcp"], "mm")}
        if "asnow" in vals[lead]:
            out["snow"] = (vals[lead]["asnow"] * 100.0, "cm")
        t = [v["tmp"] - 273.15 for v in inst if "tmp" in v]
        if t:
            out["temp_min"] = (np.min(t, axis=0), "C")
            out["temp_max"] = (np.max(t, axis=0), "C")
        w = [v["wind"] * 3.6 for v in inst if "wind" in v]
        if w:
            out["wind_speed_max"] = (np.max(w, axis=0), "km/h")
        for variable, (arr, unit) in out.items():
            for k, rid in enumerate(ids):
                v = float(arr[k])
                if not math.isfinite(v) or v > 1e19:  # GRIB missing value
                    continue
                rows.append({
                    "source": SOURCE, "kind": "forecast", "resort_id": rid, "tier": "mid", "elevation_m": None,
                    "lat": round(pts[rid][1], 4), "lon": round(pts[rid][2], 4), "station_id": None,
                    "issued_at": iso(cycle), "fetched_at": fetched_at, "valid_start": iso(start), "valid_end": iso(end),
                    "period_label": None, "variable": variable, "value": round(v, 2), "value_text": None, "unit": unit,
                    "model": "nbm", "member": None, "run_id": run_id, "parser_version": PARSER_VERSION,
                })
    return rows


def check_plausible(rows: list[dict]) -> None:
    by: dict[str, list[float]] = {}
    for r in rows:
        by.setdefault(r["variable"], []).append(r["value"])
    bad = []
    for var, vals in sorted(by.items()):
        lo, hi = min(vals), max(vals)
        log(f"    {var}: min {lo:.2f} max {hi:.2f} mean {sum(vals) / len(vals):.2f} ({len(vals)})")
        b = PLAUSIBLE.get(var)
        if b and (lo < b[0] or hi > b[1]):
            bad.append(f"{var} outside {b} (min {lo:.2f}, max {hi:.2f})")
    if bad:
        raise RuntimeError("implausible values — not archived: " + "; ".join(bad))


def bucket(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint, "--only-show-errors"], capture_output=True, text=True)


def main() -> int:
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 2
    work, dry = Path(a[0]), "--dry-run" in a
    started = time.time()
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    for r in resorts:
        r["latlon"] = r.get("latlon") or r.get("nws")
    resorts = [r for r in resorts if 15 < r["latlon"][0] < 60 and -140 < r["latlon"][1] < -50]  # North America only
    done = set()
    if os.environ.get("R2_BUCKET"):
        r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/nbm/done/")
        done = {l.split()[-1][:-5] for l in r.stdout.splitlines() if l.strip().endswith(".json")}
    now = datetime.now(timezone.utc)
    if "--cycle" in a:
        c = a[a.index("--cycle") + 1]
        cands = [datetime.strptime(c, "%Y%m%d%H").replace(tzinfo=timezone.utc)]
    else:
        cands = sorted({datetime(d.year, d.month, d.day, h, tzinfo=timezone.utc)
                        for d in (now - timedelta(days=i) for i in range(3)) for h in CYCLES}, reverse=True)
        cands = [c for c in cands if timedelta(hours=3) < now - c < timedelta(days=3)]
    gh = os.environ.get("GITHUB_RUN_ID", "local")
    fetched_at = iso(now)
    ok, waiting, failures = [], [], []
    for cycle in cands:
        key = f"nbm-{cycle:%Y%m%d%H}"
        if key in done:
            continue
        if time.time() - started > TIME_LIMIT_S:
            waiting.append(f"{key}: time limit")
            continue
        t = time.time()
        try:
            run_id = f"{cycle:%Y-%m-%dT%H%M}Z-nbm-{gh}"
            rows = collect_cycle(cycle, resorts, fetched_at, run_id)
            if not rows:
                raise RuntimeError("no rows built")
            check_plausible(rows)
            d = work / run_id
            (d / "rows").mkdir(parents=True, exist_ok=True)
            with gzip.open(d / "rows" / f"{SOURCE}.ndjson.gz", "wt") as f:
                for r in rows:
                    f.write(json.dumps(r) + "\n")
            subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"),
                            run_id, cycle.strftime("%Y-%m")], check=True)
            if not dry:
                b = os.environ["R2_BUCKET"]
                r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
                if r.returncode:
                    raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
                (d / "done.json").write_text(json.dumps({"cycle": iso(cycle), "rows": len(rows), "run_id": run_id}))
                r = bucket("cp", str(d / "done.json"), f"s3://{b}/nbm/done/{key}.json")
                if r.returncode:
                    raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")
            ok.append(f"{key}: {len(rows)} rows" + (" (dry run)" if dry else ""))
            log(f"  ✓ {key}: {len(rows)} rows in {time.time() - t:.0f} s")
        except FileNotFoundError:
            waiting.append(f"{key}: not on the bucket yet")
        except Exception as e:
            failures.append(f"{key}: {e}")
            log(f"  ✗ {key}: {e}")
    report = "\n".join(["NBM:"] + [f"  ✓ {o}" for o in ok] + [f"  … {w}" for w in waiting] + [f"  ✗ {f}" for f in failures]
                       + ([] if ok or waiting or failures else ["  nothing new"]))
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### NBM\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
