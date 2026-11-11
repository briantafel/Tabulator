#!/usr/bin/env python3
"""Upper-air profiles at our resort points: HRRR, GEFS and ECMWF open data.

    python3 scripts/archive/upper_air.py <workDir> [--dry-run] [--only MODEL] [--cycle YYYYMMDDHH]

Added 2026-11-11 (claude/upper-air-plan.md, items 2–5). The per-tier snow
line (wet-bulb) and our own snow-to-liquid ratio both need temperature AND
humidity at several heights. The free ensembles we already archive from
dynamical.org lack humidity aloft (IFS ENS) or any pressure-level T/RH
(GEFS). These three public sources fill that gap. All three keep their history
on AWS long term, so a late or skipped run loses nothing, and each can be
backfilled later with --cycle.

Models (source / model):
  noaa-hrrr / hrrr        HRRR 3 km, wrfprs, 00/06/12/18z to 48 h. CONUS + southern
                          Canada (the grid's north edge is ~50.5°N in the BC
                          interior; the log names North American resorts outside).
  noaa-gefs / gefs        GEFS 0.5° pgrb2a, control + 30 members, 00z+12z to 240 h.
                          Same file layout as the GEFSv12 reforecast (training set).
  ecmwf-opendata / ifs-hres  ECMWF IFS 0.25° deterministic (oper), 00z+12z to 240 h.
  ecmwf-opendata / ifs-ens   ECMWF IFS ENS 0.25° (enfo), control + 50 members, 00z.
GEFS and ECMWF are global, so they run for all resorts; HRRR for those on its grid.

Only the GRIB messages we need are downloaded, by byte range from each file's
index (.idx for NOAA, JSON .index for ECMWF). Adjacent messages are fetched in
one request. Every message decoded is matched to its index entry by order; a
count mismatch fails the run.

Rows are INSTANTS (valid_start == valid_end, period_label "instant") at
00/06/12/18 UTC, same shape as the regional-eps profile rows:
  t_<p>hpa   temperature (°C)
  rh_<p>hpa  relative humidity (%). NOAA: over water. ECMWF: over water above
             0 °C, over ice below −23 °C, blended between (can exceed 100 %)
  q_<p>hpa   specific humidity (g/kg), only where a model has no RH at that level
  z_<p>hpa   geopotential height (m)
  psfc       surface pressure at the model cell (hPa): tells which levels are
             below the model's ground there
  freezing_level  HRRR's 0 °C isotherm height (m above sea level), when present
elevation_m is the model cell's surface height when the file carries it, else
null. Values are the raw model values at the nearest cell (no downscaling);
per-tier interpolation and wet-bulb are derived later.

Levels: whichever of PROFILE_LEVELS each model publishes (HRRR has all;
GEFS pgrb2a has 1000/925/850/700/500; the ECMWF ENS open set is smaller than
HRES). Each run logs the levels it found per variable. A model with no
humidity at any level fails loudly: without humidity there is no wet-bulb.

Licences: NOAA open data (no restrictions; attribution "NOAA"). ECMWF open
data, CC BY 4.0 ("Source: ECMWF").
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
UA = "tabulator-archive/1.0 (+https://github.com/briantafel/tabulator)"
PARSER_VERSION = "upper-air-1"
TIME_LIMIT_S = 50 * 60
BLOCK_H = 6
PROFILE_LEVELS = (1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500)

HRRR_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
GEFS_URL = "https://noaa-gefs-pds.s3.amazonaws.com"
ECMWF_URL = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"


def leads_6h(last: int, step_after: dict | None = None) -> list[int]:
    """0..last every 6 h; step_after={156: 12} switches to 12-hourly from 156 h."""
    out, h = [], 0
    while h <= last:
        out.append(h)
        step = 6
        for start, s in (step_after or {}).items():
            if h >= start:
                step = s
        h += step
    return out


MODELS = {
    "hrrr": dict(source="noaa-hrrr", kind="noaa", cycles=(0, 6, 12, 18), max_km=3.0, leads=leads_6h(48), ready_h=3),
    "gefs": dict(source="noaa-gefs", kind="noaa", cycles=(0, 12), max_km=40.0, leads=leads_6h(240), ready_h=6),
    "ifs-hres": dict(source="ecmwf-opendata", kind="ecmwf", stream="oper", cycles=(0, 12), max_km=20.0, gap=4_000_000, workers=8,
                     leads=leads_6h(240, {156: 12}), ready_h=8),
    "ifs-ens": dict(source="ecmwf-opendata", kind="ecmwf", stream="enfo", cycles=(0,), max_km=20.0, gap=1_000_000,
                    chunk=6, workers=6,  # ~3 GB / ~9 min per chunk; S3 throttles (503) above this
                    leads=leads_6h(240, {156: 12}), ready_h=9),
}

# NOAA idx variable names → our prefix, unit, transform
NOAA_VARS = {"TMP": ("t", "C", lambda a: a - 273.15), "RH": ("rh", "%", lambda a: a),
             "HGT": ("z", "m", lambda a: a)}
# ECMWF params → our prefix, unit, transform (q only where a level has no r).
# ECMWF's r is relative to WATER above 0 °C, to ICE below −23 °C, with IFS's
# documented quadratic blend between, so it can exceed 100 % in cold air (first
# live run: 112 % at 500 hPa). That blend is exact and invertible, so wet-bulb
# code converts r back to vapour pressure with the same formula; q would be a
# duplicate.
ECMWF_VARS = {"t": ("t", "C", lambda a: a - 273.15), "r": ("rh", "%", lambda a: a),
              "gh": ("z", "m", lambda a: a), "q": ("q", "g/kg", lambda a: a * 1000.0)}

PLAUSIBLE = {"psfc": (400, 1100), "freezing_level": (-500, 7000)}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def http(url: str, headers: dict | None = None, retries: int = 6, timeout: int = 90) -> bytes:
    """GET with retries; 503/429 (S3 'slow down') back off up to ~2 min in total."""
    import random
    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(min(60, 3 * 2 ** attempt) + random.random() * 5)
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


def exists(url: str) -> bool:
    try:
        http(url, headers={"Range": "bytes=0-0"}, retries=1)
        return True
    except urllib.error.HTTPError:
        return False


# ---------------------------------------------------------------- indexes
def parse_noaa_idx(text: str) -> list[dict]:
    """Every line of a NOAA .idx as {start, end, var, level, fcst, extra}.
    GEFS lines end with 'ENS=+1' etc.; that goes in extra (kept, not skipped)."""
    lines = [l for l in text.strip().splitlines() if l.strip()]
    out = []
    for i, line in enumerate(lines):
        f = line.split(":")
        start = int(f[1])
        end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else None
        out.append({"start": start, "end": end, "var": f[3], "level": f[4], "fcst": f[5],
                    "extra": ":".join(x for x in f[6:] if x.strip())})
    return out


def noaa_fcst(lead: int) -> set[str]:
    return {"anl", "0 hour fcst"} if lead == 0 else {f"{lead} hour fcst"}


def select_noaa(idx: list[dict], lead: int) -> list[tuple[dict, str, str, object]]:
    """(entry, variable, unit, transform) for the profile messages we keep."""
    fc = noaa_fcst(lead)
    out = []
    for e in idx:
        if e["fcst"] not in fc:
            continue
        m = re.fullmatch(r"(\d+) mb", e["level"])
        if m and e["var"] in NOAA_VARS and int(m.group(1)) in PROFILE_LEVELS:
            p, unit, tf = NOAA_VARS[e["var"]]
            out.append((e, f"{p}_{int(m.group(1))}hpa", unit, tf))
        elif e["var"] == "PRES" and e["level"] == "surface":
            out.append((e, "psfc", "hPa", lambda a: a / 100.0))
        elif e["var"] == "HGT" and e["level"] == "surface":
            out.append((e, "@orog", "m", lambda a: a))
        elif e["var"] == "HGT" and e["level"] == "0C isotherm":
            out.append((e, "freezing_level", "m", lambda a: a))
    return out


def parse_ecmwf_index(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if line.strip():
            d = json.loads(line)
            d["start"] = int(d["_offset"])
            d["end"] = int(d["_offset"]) + int(d["_length"]) - 1
            out.append(d)
    return out


def select_ecmwf(idx: list[dict]) -> list[tuple[dict, str, str, object]]:
    """Pressure-level t/r/gh (q only where that level has no r) and surface pressure."""
    have_r = {(e.get("number"), e.get("levelist")) for e in idx if e.get("param") == "r" and e.get("levtype") == "pl"}
    out = []
    for e in idx:
        if e.get("type") not in ("cf", "pf", "fc"):
            continue  # skip ensemble mean / std products
        if e.get("levtype") == "pl" and e.get("param") in ECMWF_VARS:
            lv = int(e["levelist"])
            if lv not in PROFILE_LEVELS:
                continue
            if e["param"] == "q" and (e.get("number"), e.get("levelist")) in have_r:
                continue
            p, unit, tf = ECMWF_VARS[e["param"]]
            out.append((e, f"{p}_{lv}hpa", unit, tf))
        elif e.get("levtype") == "sfc" and e.get("param") == "sp":
            out.append((e, "psfc", "hPa", lambda a: a / 100.0))
    return out


def merge_ranges(picks: list[tuple[dict, str, str, object]], entries: list[dict] | None = None,
                 gap: int = 0) -> list[list[tuple]]:
    """Group wanted messages into byte spans so one request fetches several.
    With entries (the file's full index) and gap > 0, a span may also cover
    unwanted messages between wanted ones, up to `gap` bytes in a row; those
    come back as None placeholders so every decoded message still lines up
    with its index entry by order."""
    picks = sorted(picks, key=lambda p: p[0]["start"])
    if not entries or gap <= 0:
        groups: list[list[tuple]] = []
        for p in picks:
            if groups and groups[-1][-1][0]["end"] is not None and groups[-1][-1][0]["end"] + 1 == p[0]["start"]:
                groups[-1].append(p)
            else:
                groups.append([p])
        return groups
    wanted = {p[0]["start"]: p for p in picks}
    order = sorted(entries, key=lambda e: e["start"])
    groups, cur, skipped = [], [], []
    for e in order:
        p = wanted.get(e["start"])
        if p is None:
            if cur:
                skipped.append(e)
            continue
        if cur and (skipped and sum(x["end"] - x["start"] + 1 for x in skipped) > gap):
            groups.append(cur)
            cur = []
        elif cur and skipped:
            cur.extend((x, None, None, None) for x in skipped)
        skipped = []
        cur.append(p)
    if cur:
        groups.append(cur)
    return groups


def member_of(model: str, url: str, entry: dict) -> int | None:
    if model == "hrrr" or model == "ifs-hres":
        return None
    if model == "gefs":
        m = re.search(r"ge(c|p)(\d\d)\.", url)
        return 0 if m.group(1) == "c" else int(m.group(2))
    return 0 if entry.get("type") == "cf" else int(entry.get("number"))


# ---------------------------------------------------------------- grid
def nearest(lat: np.ndarray, lon: np.ndarray, resorts: list[dict], max_km: float) -> dict[str, tuple[int, float, float]]:
    lon = np.where(lon > 180, lon - 360, lon)
    out = {}
    win = max(0.2, max_km / 80.0)
    for r in resorts:
        la, lo = r["latlon"]
        box = np.where((np.abs(lat - la) < win) & (np.abs(lon - lo) < win * 1.6))[0]
        if not len(box):
            continue
        p, q = math.radians(la), math.radians(lo)
        d = 2 * 6371 * np.arcsin(np.sqrt(np.sin((np.radians(lat[box]) - p) / 2) ** 2 +
                                         math.cos(p) * np.cos(np.radians(lat[box])) * np.sin((np.radians(lon[box]) - q) / 2) ** 2))
        i = int(np.argmin(d))
        if d[i] <= max_km:
            out[r["id"]] = (int(box[i]), float(lat[box[i]]), float(lon[box[i]]))
    return out


def grid_from(raw: bytes) -> tuple[np.ndarray, np.ndarray]:
    import eccodes
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".grib2") as f:
        f.write(raw)
        f.flush()
        with open(f.name, "rb") as fh:
            gid = eccodes.codes_grib_new_from_file(fh)
            try:
                return (np.asarray(eccodes.codes_get_array(gid, "latitudes")),
                        np.asarray(eccodes.codes_get_array(gid, "longitudes")))
            finally:
                eccodes.codes_release(gid)


def get_range(url: str, start: int, end: int | None) -> bytes:
    return http(url, headers={"Range": f"bytes={start}-{end}" if end is not None else f"bytes={start}-"})


# ---------------------------------------------------------------- files per model
def files_for(model: str, cfg: dict, cycle: datetime, leads: list[int] | None = None) -> list[tuple[int, str, str]]:
    """(lead, grib url, index url) for every file one cycle (or chunk) needs."""
    d, h = f"{cycle:%Y%m%d}", f"{cycle:%H}"
    leads = cfg["leads"] if leads is None else leads
    out = []
    if model == "hrrr":
        for l in leads:
            u = f"{HRRR_URL}/hrrr.{d}/conus/hrrr.t{h}z.wrfprsf{l:02d}.grib2"
            out.append((l, u, u + ".idx"))
    elif model == "gefs":
        for mem in ["gec00"] + [f"gep{n:02d}" for n in range(1, 31)]:
            for l in leads:
                u = f"{GEFS_URL}/gefs.{d}/{h}/atmos/pgrb2ap5/{mem}.t{h}z.pgrb2a.0p50.f{l:03d}"
                out.append((l, u, u + ".idx"))
    else:
        typ = "ef" if cfg["stream"] == "enfo" else "fc"
        for l in leads:
            u = f"{ECMWF_URL}/{d}/{h}z/ifs/0p25/{cfg['stream']}/{d}{h}0000-{l}h-{cfg['stream']}-{typ}.grib2"
            out.append((l, u, u[:-len(".grib2")] + ".index"))
    return out


def chunks(cfg: dict) -> list[list[int]]:
    """Lead groups archived as separate units (own done marker). One unit for
    most models; the ECMWF ensemble is too big for one job (>45 min)."""
    n = cfg.get("chunk")
    leads = cfg["leads"]
    return [leads] if not n else [leads[i:i + n] for i in range(0, len(leads), n)]


def collect_cycle(model: str, cfg: dict, cycle: datetime, resorts: list[dict], fetched_at: str, run_id: str,
                  deadline: float, leads: list[int] | None = None):
    # The cycle counts as ready when its LAST file's index is up (the run is complete).
    whole = files_for(model, cfg, cycle)
    last_lead = max(l for l, _, _ in whole)
    if not any(exists(i) for l, _, i in whole if l == last_lead):
        raise FileNotFoundError("cycle not complete on the bucket yet")
    files = files_for(model, cfg, cycle, leads)
    t0 = time.time()

    def index_job(f):
        lead, url, iurl = f
        try:
            text = http(iurl).decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return f, None
            raise
        idx = parse_noaa_idx(text) if cfg["kind"] == "noaa" else parse_ecmwf_index(text)
        picks = select_noaa(idx, lead) if cfg["kind"] == "noaa" else select_ecmwf(idx)
        entries[f[1]] = idx
        return f, picks

    entries: dict[str, list[dict]] = {}
    workers = cfg.get("workers", 16)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        indexed = list(pool.map(index_job, files))
    missing = [f"{l}h {u.rsplit('/', 1)[-1]}" for (l, u, _), p in indexed if p is None]
    if missing:
        raise RuntimeError(f"{len(missing)} of {len(files)} files missing from a complete cycle (first: {missing[0]})")
    empty = [f"{l}h" for (l, _, _), p in indexed if not p]
    if empty:
        raise RuntimeError(f"no profile messages in {len(empty)} files (first lead {empty[0]}) — the index format may have changed")

    # What we found, per variable family and level (logged; humidity is required).
    found: dict[str, set] = {}
    for _, picks in indexed:
        for _, v, _, _ in picks:
            m = re.match(r"(\w+?)_(\d+)hpa$", v)
            found.setdefault(m.group(1) if m else v, set()).add(int(m.group(2)) if m else 0)
    log("    levels found: " + "; ".join(f"{k} {sorted(v) if k in ('t', 'rh', 'q', 'z') else ''}".strip()
                                         for k, v in sorted(found.items())))
    if not ({"rh", "q"} & set(found)):
        raise RuntimeError("no humidity (RH or q) at any pressure level — no wet-bulb possible from this model")

    # Grid: decode one message for its coordinates.
    (lead0, url0, _), picks0 = indexed[0]
    e0 = picks0[0][0]
    lat, lon = grid_from(get_range(url0, e0["start"], e0["end"]))
    pts = nearest(lat, lon, resorts, cfg["max_km"])
    if not pts:
        raise RuntimeError("no resort inside the model grid")
    outside = [r["id"] for r in resorts if r["id"] not in pts and r["latlon"][0] > 15 and -170 < r["latlon"][1] < -50]
    log(f"    {len(pts)} resorts on the grid" + (f"; North American resorts outside: {', '.join(outside)}" if outside else ""))
    ids = list(pts)
    cells = np.array([pts[i][0] for i in ids])
    del lat, lon

    jobs = [(lead, url, group) for (lead, url, _), picks in indexed
            for group in merge_ranges(picks, entries.get(url), cfg.get("gap", 0))]
    entries.clear()
    log(f"    {sum(len(p) for _, p in indexed)} messages in {len(jobs)} requests from {len(files)} files")

    def fetch(job):
        lead, url, group = job
        if time.time() > deadline:
            raise TimeoutError("time limit")
        raw = get_range(url, group[0][0]["start"], group[-1][0]["end"])
        msgs = [np.asarray(v, dtype=float)[cells] for _, v in grib_messages(raw)]
        if len(msgs) != len(group):
            raise RuntimeError(f"{url.rsplit('/', 1)[-1]}: {len(msgs)} GRIB messages for {len(group)} index entries")
        return lead, url, group, msgs, len(raw)

    orog: dict[str, float] = {}
    pending: list[tuple] = []
    nbytes = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for lead, url, group, msgs, n in pool.map(fetch, jobs):
            nbytes += n
            for (entry, variable, unit, tf), arr in zip(group, msgs):
                if variable is None:
                    continue  # unwanted message inside a span
                if variable == "@orog":
                    for k, rid in enumerate(ids):
                        if math.isfinite(arr[k]) and abs(arr[k]) < 1e19:
                            orog[rid] = float(arr[k])
                    continue
                pending.append((lead, member_of(model, url, entry), variable, unit, tf(arr)))
    log(f"    fetched {nbytes / 1e6:.0f} MB in {time.time() - t0:.0f} s")

    meta = {"ids": ids, "pts": pts, "orog": orog, "issued": iso(cycle), "source": cfg["source"], "model": model,
            "fetched_at": fetched_at, "run_id": run_id}
    return pending, meta


def iter_rows(pending: list[tuple], meta: dict):
    """Rows one at a time (a GEFS cycle is ~2 M rows; never all in memory)."""
    ids, pts, orog = meta["ids"], meta["pts"], meta["orog"]
    issued = datetime.strptime(meta["issued"], "%Y-%m-%dT%H:%M:%SZ")
    for lead, member, variable, unit, arr in pending:
        stamp = iso(issued + timedelta(hours=lead))
        for k, rid in enumerate(ids):
            v = float(arr[k])
            if not math.isfinite(v) or abs(v) > 1e19:
                continue  # GRIB missing: no row, never zero
            yield {
                "source": meta["source"], "kind": "forecast", "resort_id": rid, "tier": "mid",
                "elevation_m": int(round(orog[rid])) if rid in orog else None,
                "lat": round(pts[rid][1], 4), "lon": round(pts[rid][2], 4), "station_id": None,
                "issued_at": meta["issued"], "fetched_at": meta["fetched_at"], "valid_start": stamp, "valid_end": stamp,
                "period_label": "instant", "variable": variable, "value": round(v, 2), "value_text": None,
                "unit": unit, "model": meta["model"], "member": member, "run_id": meta["run_id"],
                "parser_version": PARSER_VERSION,
            }


def bounds(variable: str):
    if variable in PLAUSIBLE:
        return PLAUSIBLE[variable]
    if variable.startswith("t_"):
        return (-90, 45)
    if variable.startswith("rh_"):
        return (-5, 130)  # ECMWF r is over ice in cold air (can exceed 100 %); down to ~−3 % is packing noise in dry air
    if variable.startswith("q_"):
        return (0, 40)
    if variable.startswith("z_"):
        return (-1000, 7000)
    return None


def check_plausible(pending: list[tuple]) -> int:
    """Bounds per variable on the arrays (missing values ignored). Returns the
    number of finite values, i.e. the row count."""
    parts: dict[str, list[np.ndarray]] = {}
    for _, _, variable, _, arr in pending:
        a = np.asarray(arr, dtype=float)
        parts.setdefault(variable, []).append(a[np.isfinite(a) & (np.abs(a) < 1e19)])
    by = {k: np.concatenate(v) for k, v in parts.items()}
    by = {k: v for k, v in by.items() if v.size}
    n = int(sum(v.size for v in by.values()))
    bad = []
    for var, vals in sorted(by.items()):
        lo, hi = float(vals.min()), float(vals.max())
        if not re.search(r"_\d+hpa$", var) or re.search(r"_(850|700|500)hpa$", var):
            log(f"    {var}: min {lo:.2f} max {hi:.2f} mean {float(vals.mean()):.2f} ({vals.size})")
        b = bounds(var)
        if b is None:
            bad.append(f"{var}: no plausibility bounds")
        elif lo < b[0] or hi > b[1]:
            bad.append(f"{var} outside {b} (min {lo:.2f}, max {hi:.2f})")
    # Units sanity on the profile itself: 500 hPa should sit near 5.5 km, 850 hPa near 1.5 km.
    for var, (lo_ok, hi_ok) in (("z_500hpa", (4500, 6200)), ("z_850hpa", (500, 2000))):
        if var in by:
            mean = float(by[var].mean())
            if not lo_ok <= mean <= hi_ok:
                bad.append(f"{var} mean {mean:.0f} m outside {lo_ok}–{hi_ok} (units?)")
    if bad:
        raise RuntimeError("implausible values — not archived: " + "; ".join(bad))
    return n


def bucket(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint] + ([] if args[:1] == ("ls",) else ["--only-show-errors"]), capture_output=True, text=True)


def main() -> int:
    a = sys.argv[1:]
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
    if os.environ.get("R2_BUCKET"):
        r = bucket("ls", f"s3://{os.environ['R2_BUCKET']}/upper-air/done/")
        # 2026-11-11: this listing passed --only-show-errors, which `aws s3 ls` rejects, so it
        # returned nothing and every run re-collected (and re-archived) everything. `ls` of an
        # empty prefix exits 1 with no stderr; anything else is a real failure.
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
        if "--cycle" in a:
            c = a[a.index("--cycle") + 1]
            cands = [datetime.strptime(c, "%Y%m%d%H").replace(tzinfo=timezone.utc)]
        else:
            cands = sorted({datetime(d.year, d.month, d.day, h, tzinfo=timezone.utc)
                            for d in (now - timedelta(days=i) for i in range(3)) for h in cfg["cycles"]}, reverse=True)
            cands = [c for c in cands if timedelta(hours=cfg["ready_h"]) < now - c < timedelta(days=3)]
        units = [(cycle, i, ls) for cycle in cands for i, ls in enumerate(chunks(cfg))]
        for cycle, ci, ls in units:
            key = f"{model}-{cycle:%Y%m%d%H}" + (f"-c{ci}" if cfg.get("chunk") else "")
            if key in done:
                continue
            if any(w.startswith(f"{model}-{cycle:%Y%m%d%H}") for w in waiting + failures):
                continue  # an earlier chunk of this cycle is waiting or failed
            if time.time() - started > TIME_LIMIT_S - 5 * 60:
                waiting.append(f"{key}: time limit (next run continues)")
                continue
            t = time.time()
            log(f"  {key}:" + (f" leads {ls[0]}–{ls[-1]} h" if cfg.get("chunk") else ""))
            try:
                run_id = f"{cycle:%Y-%m-%dT%H%M}Z-{model}-prof-" + (f"c{ci}-" if cfg.get("chunk") else "") + gh
                pending, meta = collect_cycle(model, cfg, cycle, resorts, fetched_at, run_id, started + TIME_LIMIT_S, ls)
                n = check_plausible(pending)
                if not n:
                    raise RuntimeError("no rows built")
                d = work / run_id
                (d / "rows").mkdir(parents=True, exist_ok=True)
                written = 0
                with gzip.open(d / "rows" / f"{cfg['source']}.ndjson.gz", "wt", compresslevel=3) as f:
                    for r in iter_rows(pending, meta):
                        f.write(json.dumps(r) + "\n")
                        written += 1
                if written != n:
                    raise RuntimeError(f"wrote {written} rows, expected {n}")
                del pending
                subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"),
                                run_id, cycle.strftime("%Y-%m")], check=True)
                if not dry:
                    b = os.environ["R2_BUCKET"]
                    r = bucket("cp", str(d / "up"), f"s3://{b}/", "--recursive")
                    if r.returncode:
                        raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
                    (d / "done.json").write_text(json.dumps({"cycle": iso(cycle), "leads": ls, "rows": n, "run_id": run_id}))
                    r = bucket("cp", str(d / "done.json"), f"s3://{b}/upper-air/done/{key}.json")
                    if r.returncode:
                        raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")
                ok.append(f"{key}: {n} rows in {time.time() - t:.0f} s" + (" (dry run)" if dry else ""))
                log(f"  ✓ {ok[-1]}")
                if dry and (not cfg.get("chunk") or ci >= 1):
                    break  # a dry run measures one cycle (two chunks) per model
            except FileNotFoundError as e:
                waiting.append(f"{key}: {e}")
            except TimeoutError:
                waiting.append(f"{key}: time limit (next run continues)")
            except Exception as e:
                failures.append(f"{key}: {e}")
                log(f"  ✗ {key}: {e}")
    report = "\n".join(["Upper-air profiles:"] + [f"  ✓ {o}" for o in ok] + [f"  … {w}" for w in waiting]
                       + [f"  ✗ {f}" for f in failures] + ([] if ok or waiting or failures else ["  nothing new"]))
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### Upper-air profiles\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
