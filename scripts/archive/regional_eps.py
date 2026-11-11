#!/usr/bin/env python3
"""Regional European ensembles, straight from the weather services (free).

    python3 scripts/archive/regional_eps.py <workDir> [--dry-run] [--only MODEL]

Added 2026-11-11 (claude/lean-data-plan.md). Both services keep files for
only ~24 hours, so a model run we don't collect is lost for good. Each
invocation looks for every target run that is complete and not yet archived
(done markers in the bucket), so a late or skipped invocation loses nothing
while the run is still on the server.

Models (source / model):
  dwd-icon-eps / icon-eu-eps    DWD ICON-EU-EPS, 40 members, 00z+12z to 120 h
  dwd-icon-eps / icon-d2-eps    DWD ICON-D2-EPS, 20 members, 03z (45 h) + 15z (27 h)
  meteoswiss-icon-eps / icon-ch2-eps   MeteoSwiss ICON-CH2-EPS, 21 members + ctrl, 00z+12z to 120 h
  meteoswiss-icon-eps / icon-ch1-eps   MeteoSwiss ICON-CH1-EPS, 11 members + ctrl, 00z+12z to 33 h

Only our resort points are kept. Each resort uses the model's nearest grid
cell, if one lies within the model's domain (MAX_KM); elevation_m is that
cell's own surface height, so temperatures are the model's at the model's
height (no downscaling). Rows are 6-hour blocks aligned to 00/06/12/18 UTC,
with the same variable names as open-meteo-ensemble where the meaning is the
same, plus snow_we (the model's own snowfall, water equivalent, mm).
issued_at is the model run time (exact).

Licences: DWD open data (attribution "Deutscher Wetterdienst"); MeteoSwiss
Open Government Data ("Source: MeteoSwiss").

Upper-air profiles (added 2026-11-11, claude/upper-air-plan.md): after the
surface pass, a second pass archives each run's vertical profile at the
resort cells, separately (own run_id suffix "-prof", own done marker
"<model>+profile-<run>"), so a profile problem never costs the surface rows
and a failed profile retries while the files are still up. These fields are
the only free 1–2 km ensemble profiles for the Alps and are unrecoverable
after ~24 h. Rows are INSTANTS (valid_start == valid_end, period_label
"instant") at 00/06/12/18 UTC:
  DWD          t_<p>hpa (°C), rh_<p>hpa (%, D2) or q_<p>hpa (g/kg, EU),
               z_<p>hpa (m, from fi / g0) at PROFILE_LEVELS present on the server
  MeteoSwiss   freezing_level (m, HZEROCL) and snow_limit (m, SNOWLMT) when the
               STAC offers them; the run also logs every variable the STAC has,
               so pressure-level T/RELHUM/FI can be added once their layout is known.

FAIL LOUDLY: a target run that is on the server but cannot be collected makes
the exit code non-zero. Missing variables are logged; missing precipitation
fails the run.
"""
from __future__ import annotations

import bz2
import gzip
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
T0 = time.time()
UA = "tabulator-archive/1.0 (+https://github.com/briantafel/tabulator)"
PARSER_VERSION = "regional-eps-1"
PROFILE_PARSER_VERSION = "regional-eps-profile-1"
G0 = 9.80665
# Levels that bracket resort tiers (~500–4000 m) plus 500 hPa for the dendritic
# layer. Only the ones each server actually publishes are fetched.
PROFILE_LEVELS = (1000, 950, 925, 900, 850, 800, 750, 700, 650, 600, 500)
# our profile var → (DWD dir, row prefix, unit, transform)
DWD_PROFILE = {
    "t": ("t", "t", "C", lambda a: a - 273.15),
    "relhum": ("relhum", "rh", "%", lambda a: a),
    "qv": ("qv", "q", "g/kg", lambda a: a * 1000.0),
    "fi": ("fi", "z", "m", lambda a: a / G0),
}
# MeteoSwiss single-level heights; −999-style fills (no 0 °C level / below ground) are dropped.
CH_PROFILE = {"HZEROCL": ("freezing_level", "m"), "SNOWLMT": ("snow_limit", "m")}
TIME_LIMIT_S = 50 * 60
BLOCK_H = 6

DWD = "https://opendata.dwd.de/weather/nwp"
STAC = "https://data.geo.admin.ch/api/stac/v1/search"

# Variables: our name → (DWD dir, MeteoSwiss name). Accumulated ones are
# differenced lead to lead.
VARS = {
    "tot_prec": ("tot_prec", "TOT_PREC", True),
    "snow_gsp": ("snow_gsp", "SNOW_GSP", True),
    "snow_con": ("snow_con", "SNOW_CON", True),
    "t_2m": ("t_2m", "T_2M", False),
    "u_10m": ("u_10m", "U_10M", False),
    "v_10m": ("v_10m", "V_10M", False),
}
REQUIRED = {"tot_prec"}

MODELS = {
    "icon-eu-eps": dict(source="dwd-icon-eps", kind="dwd", runs=(0, 12), max_km=25.0, profile_max_lead=72,
                        leads=lambda h: list(range(0, 49)) + list(range(51, 73, 3)) + list(range(78, 121, 6))),
    # ~37 MB per file: no wind here (the EU and Swiss models carry it).
    "icon-d2-eps": dict(source="dwd-icon-eps", kind="dwd", runs=(3, 15), max_km=5.0, profile_max_lead=48,
                        vars=("tot_prec", "snow_gsp", "snow_con", "t_2m"),
                        leads=lambda h: list(range(0, 46 if h == 3 else 28))),
    "icon-ch2-eps": dict(source="meteoswiss-icon-eps", kind="ch", collection="ch.meteoschweiz.ogd-forecasting-icon-ch2",
                         runs=(0, 12), max_km=5.0, profile_max_lead=120, leads=lambda h: list(range(0, 121))),
    "icon-ch1-eps": dict(source="meteoswiss-icon-eps", kind="ch", collection="ch.meteoschweiz.ogd-forecasting-icon-ch1",
                         runs=(0, 12), max_km=3.0, profile_max_lead=33, leads=lambda h: list(range(0, 34))),
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http(url: str, data: bytes | None = None, retries: int = 3, timeout: int = 60) -> bytes:
    last = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(5 * attempt)
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **({"Content-Type": "application/json"} if data else {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            last = e
        except Exception as e:  # network fault: retry
            last = e
    raise RuntimeError(f"{url}: {last}")


# ---------------------------------------------------------------- bucket
def bucket_cmd(*args: str) -> subprocess.CompletedProcess:
    endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return subprocess.run(["aws", "s3", *args, "--endpoint-url", endpoint, "--only-show-errors"],
                          capture_output=True, text=True)


def done_markers() -> set[str]:
    if not os.environ.get("R2_BUCKET"):
        return set()
    r = bucket_cmd("ls", f"s3://{os.environ['R2_BUCKET']}/regional/done/")
    return {line.split()[-1][:-5] for line in r.stdout.splitlines() if line.strip().endswith(".json")}


# ---------------------------------------------------------------- GRIB
def grib_messages(raw: bytes):
    """Yield (keys, values) for every message in a GRIB file's bytes."""
    import eccodes
    with tempfile.NamedTemporaryFile(suffix=".grib2") as f:
        f.write(raw)
        f.flush()
        with open(f.name, "rb") as fh:
            while True:
                gid = eccodes.codes_grib_new_from_file(fh)
                if gid is None:
                    break
                try:
                    keys = {}
                    for k in ("shortName", "perturbationNumber", "typeOfEnsembleForecast", "numberOfDataPoints",
                              "typeOfLevel", "level"):
                        try:
                            keys[k] = eccodes.codes_get(gid, k)
                        except Exception:
                            keys[k] = None
                    yield keys, eccodes.codes_get_values(gid)
                finally:
                    eccodes.codes_release(gid)


def nearest_cells(clat: np.ndarray, clon: np.ndarray, resorts: list[dict], max_km: float) -> dict[str, tuple[int, float]]:
    if np.nanmax(np.abs(clat)) <= math.pi + 0.01:  # radians
        clat, clon = np.degrees(clat), np.degrees(clon)
    lat_r, lon_r = np.radians(clat), np.radians(clon)
    out = {}
    for r in resorts:
        la, lo = r["latlon"]
        if not (clat.min() - 1 <= la <= clat.max() + 1 and clon.min() - 1 <= lo <= clon.max() + 1):
            continue
        p, q = math.radians(la), math.radians(lo)
        d = 2 * 6371.0 * np.arcsin(np.sqrt(np.sin((lat_r - p) / 2) ** 2 + np.cos(p) * np.cos(lat_r) * np.sin((lon_r - q) / 2) ** 2))
        i = int(np.nanargmin(d))
        if d[i] <= max_km:
            out[r["id"]] = (i, float(d[i]))
    return out


# ---------------------------------------------------------------- DWD
def dwd_files(model: str, hour: int, var: str) -> dict[int, str]:
    """lead → file URL for the run currently on the server for this hour."""
    url = f"{DWD}/{model}/grib/{hour:02d}/{var}/"
    try:
        html = http(url).decode("utf-8", "replace")
    except urllib.error.HTTPError:
        return {}
    out = {}
    for name in re.findall(r'href="([^"]+\.grib2\.bz2)"', html):
        m = re.search(r"_(\d{10})_(\d{3})_", name)
        if m:
            out[int(m.group(2))] = (m.group(1), url + name)
    return out


def dwd_constants(model: str, hour: int) -> dict[str, np.ndarray]:
    """Grid cell centres and surface height. These files are time-invariant
    (no lead in the name), e.g. ..._time-invariant_2026111100_clat.grib2.bz2."""
    out = {}
    for var in ("clat", "clon", "hsurf"):
        url = f"{DWD}/{model}/grib/{hour:02d}/{var}/"
        try:
            html = http(url).decode("utf-8", "replace")
        except urllib.error.HTTPError:
            log(f"    constants: no {var} directory")
            continue
        names = re.findall(r'href="([^"]+\.grib2\.bz2)"', html)
        if not names:
            log(f"    constants: {var} directory is empty")
            continue
        for _, vals in grib_messages(bz2.decompress(http(url + sorted(names)[-1]))):
            out[var] = vals
            break
        log(f"    constants: {var} from {sorted(names)[-1]} ({len(out.get(var, []))} cells)")
    return out


# ---------------------------------------------------------------- MeteoSwiss
def ch_items(collection: str, ref: datetime, variable: str, perturbed: bool) -> dict[int, str]:
    """lead hour → asset href, for one variable of one run."""
    body = {"collections": [collection], "forecast:reference_datetime": ref.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "forecast:variable": variable, "forecast:perturbed": perturbed, "limit": 200}
    out, url, data = {}, STAC, json.dumps(body).encode()
    t = time.time()
    pages = 0
    while url:
        pages += 1
        if pages > 50:
            raise RuntimeError(f"STAC search for {variable} paged past 50 pages — the filter is not being applied")
        page = json.loads(http(url, data=data))
        for f in page.get("features", []):
            h = f.get("properties", {}).get("forecast:horizon", "")
            m = re.match(r"P(\d+)DT(\d+)H", h)
            if not m:
                continue
            lead = int(m.group(1)) * 24 + int(m.group(2))
            # hrefs are pre-signed (…grib2?AWSAccessKeyId=…): match the asset
            # name / path, not the end of the URL.
            for name, a in f.get("assets", {}).items():
                if name.endswith(".grib2") or a.get("href", "").split("?")[0].endswith(".grib2"):
                    out[lead] = a["href"]
        nxt = [l for l in page.get("links", []) if l.get("rel") == "next"]
        if nxt:
            # The next link carries only the cursor: MERGE it into the original
            # body (as MeteoSwiss's meteodata-lab does), or the filters are lost.
            url, data = nxt[0]["href"], json.dumps({**body, **(nxt[0].get("body") or {})}).encode()
        else:
            url = None
    log(f"    STAC {variable} {'perturbed' if perturbed else 'ctrl'}: {len(out)} leads, {pages} page(s), {time.time() - t:.1f} s")
    return out


def ch_constants(collection: str) -> dict[str, np.ndarray]:
    assets = json.loads(http(f"https://data.geo.admin.ch/api/stac/v1/collections/{collection}/assets"))
    out = {}
    for a in assets.get("assets", []):
        if a.get("id", "").startswith("horizontal_constants") and a["id"].endswith(".grib2"):
            for keys, vals in grib_messages(http(a["href"])):
                sn = (keys.get("shortName") or "").lower()
                if sn in ("tlat", "clat", "lat", "nlat"):
                    out.setdefault("clat", vals)
                elif sn in ("tlon", "clon", "lon", "nlon"):
                    out.setdefault("clon", vals)
                elif sn in ("hsurf", "h", "orog", "z"):
                    out.setdefault("hsurf", vals)
                log(f"    constants: {keys.get('shortName')} ({len(vals)} values)")
    return out


# ---------------------------------------------------------------- one model run
def collect_run(model: str, cfg: dict, run_time: datetime, resorts: list[dict], files_by_var: dict, consts: dict,
                fetched_at: str, run_id: str) -> list[dict]:
    if "clat" not in consts or "clon" not in consts:
        raise RuntimeError("grid coordinates not found")
    cells = nearest_cells(consts["clat"], consts["clon"], resorts, cfg["max_km"])
    if not cells:
        raise RuntimeError("no resort inside the model domain")
    log(f"  {model} {run_time:%Y-%m-%d %H}z: {len(cells)} resorts in domain: {', '.join(sorted(cells))}")
    idx = np.array([c[0] for c in cells.values()])
    ids = list(cells.keys())
    hs = consts.get("hsurf")
    lat_deg = np.degrees(consts["clat"]) if np.nanmax(np.abs(consts["clat"])) <= math.pi + 0.01 else consts["clat"]
    lon_deg = np.degrees(consts["clon"]) if np.nanmax(np.abs(consts["clon"])) <= math.pi + 0.01 else consts["clon"]

    # series[var][member][lead] = array over resorts
    series: dict[str, dict[int, dict[int, np.ndarray]]] = {}

    def fetch(url: str) -> bytes:  # network and bz2 release the GIL: run these in parallel
        raw = http(url)
        return bz2.decompress(raw) if url.split("?")[0].endswith(".bz2") else raw

    for var, leads in files_by_var.items():
        s = series.setdefault(var, {})
        jobs = [(lead, url) for lead, sources in sorted(leads.items()) for url in sources]
        with ThreadPoolExecutor(max_workers=8) as pool:
            fetched = pool.map(lambda j: (j[0], j[1], fetch(j[1])), jobs)
            for lead, url, raw in fetched:
                for keys, vals in grib_messages(raw):
                    n = keys.get("perturbationNumber")
                    member = 0 if n is None or keys.get("typeOfEnsembleForecast") in (0, 1) and n == 0 else int(n)
                    if "ctrl" in url.split("?")[0].split("/")[-1].lower():
                        member = 0
                    s.setdefault(member, {})[lead] = np.asarray(vals)[idx]
        log(f"    {var}: {len(leads)} leads, {len(s)} members ({time.time() - T0:.0f} s)")

    rows = []
    lead_list = sorted({l for v in series.values() for m in v.values() for l in m})
    members = sorted({m for v in series.values() for m in v})
    t0 = run_time
    for member in members:
        def get(var, lead):
            return series.get(var, {}).get(member, {}).get(lead)
        # per-lead increments for accumulated vars, instantaneous values for others
        blocks: dict[datetime, dict] = {}
        prev = None
        for lead in lead_list:
            t = t0 + timedelta(hours=lead)
            if prev is not None:
                tp = t0 + timedelta(hours=prev)
                bstart = datetime(tp.year, tp.month, tp.day, (tp.hour // BLOCK_H) * BLOCK_H, tzinfo=timezone.utc)
                if t <= bstart + timedelta(hours=BLOCK_H):  # interval lies inside one block
                    b = blocks.setdefault(bstart, {"hours": 0, "precip": None, "snow_we": None, "t": [], "w": []})
                    b["hours"] += lead - prev
                    for var, key in (("tot_prec", "precip"), ("snow_gsp", "snow_we"), ("snow_con", "snow_we")):
                        a, c = get(var, lead), get(var, prev)
                        if a is None or c is None:
                            continue
                        inc = np.maximum(a - c, 0.0)
                        b[key] = inc if b[key] is None else b[key] + inc
            ts = t0 + timedelta(hours=lead)
            bstart = datetime(ts.year, ts.month, ts.day, (ts.hour // BLOCK_H) * BLOCK_H, tzinfo=timezone.utc)
            if ts == bstart and lead > 0:  # an instant on a block edge belongs to the block it ends
                bstart -= timedelta(hours=BLOCK_H)
            b = blocks.setdefault(bstart, {"hours": 0, "precip": None, "snow_we": None, "t": [], "w": []})
            tv, uv, vv = get("t_2m", lead), get("u_10m", lead), get("v_10m", lead)
            if tv is not None:
                b["t"].append(tv - 273.15)
            if uv is not None and vv is not None:
                b["w"].append(np.hypot(uv, vv) * 3.6)
            prev = lead
        for bstart, b in sorted(blocks.items()):
            if b["hours"] != BLOCK_H:  # partial block (run start or end): skip, missing is not zero
                continue
            vals = [("precip", b["precip"], "mm"), ("snow_we", b["snow_we"], "mm")]
            if b["t"]:
                vals += [("temp_min", np.min(b["t"], axis=0), "C"), ("temp_max", np.max(b["t"], axis=0), "C")]
            if b["w"]:
                vals += [("wind_speed_max", np.max(b["w"], axis=0), "km/h")]
            for variable, arr, unit in vals:
                if arr is None:
                    continue
                for k, rid in enumerate(ids):
                    v = float(arr[k])
                    if not math.isfinite(v):
                        continue
                    ci = cells[rid][0]
                    rows.append({
                        "source": cfg["source"], "kind": "forecast", "resort_id": rid, "tier": "mid",
                        "elevation_m": int(round(float(hs[ci]))) if hs is not None else None,
                        "lat": round(float(lat_deg[ci]), 4), "lon": round(float(lon_deg[ci]), 4),
                        "station_id": None, "issued_at": t0.isoformat().replace("+00:00", "Z"),
                        "fetched_at": fetched_at, "valid_start": bstart.isoformat().replace("+00:00", "Z"),
                        "valid_end": (bstart + timedelta(hours=BLOCK_H)).isoformat().replace("+00:00", "Z"),
                        "period_label": None, "variable": variable, "value": round(v, 2), "value_text": None,
                        "unit": unit, "model": model, "member": member, "run_id": run_id,
                        "parser_version": PARSER_VERSION,
                    })
    return rows


# ---------------------------------------------------------------- profiles
def profile_leads(run_hour: int, max_lead: int) -> list[int]:
    """Leads that land on 00/06/12/18 UTC, up to max_lead."""
    return [l for l in range(0, max_lead + 1) if (run_hour + l) % BLOCK_H == 0]


def dwd_profile_files(model: str, hour: int, dvar: str, stamp: str, leads: set[int]) -> dict[tuple[int, int], str]:
    """(lead, hPa) → URL for pressure-level files of one variable and run."""
    url = f"{DWD}/{model}/grib/{hour:02d}/{dvar}/"
    try:
        html = http(url).decode("utf-8", "replace")
    except urllib.error.HTTPError:
        return {}
    out = {}
    for name in re.findall(r'href="([^"]+\.grib2\.bz2)"', html):
        m = re.search(r"pressure-level_(\d{10})_(\d{3})_(\d+)_", name)
        if m and m.group(1) == stamp and int(m.group(2)) in leads and int(m.group(3)) in PROFILE_LEVELS:
            out[(int(m.group(2)), int(m.group(3)))] = url + name
    return out


def ch_variables(collection: str, ref: datetime) -> list[str]:
    """Every forecast:variable the STAC offers for one run (one page at the
    6 h horizon is enough to see the names)."""
    body = {"collections": [collection], "forecast:reference_datetime": ref.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "forecast:horizon": "P0DT06H00M00S", "limit": 200}
    names, url, data = set(), STAC, json.dumps(body).encode()
    for _ in range(10):
        page = json.loads(http(url, data=data))
        for f in page.get("features", []):
            v = f.get("properties", {}).get("forecast:variable")
            if v:
                names.add(v)
        nxt = [l for l in page.get("links", []) if l.get("rel") == "next"]
        if not nxt:
            break
        url, data = nxt[0]["href"], json.dumps({**body, **(nxt[0].get("body") or {})}).encode()
    return sorted(names)


def profile_rows(model: str, cfg: dict, run_time: datetime, resorts: list[dict], fields: list[tuple],
                 consts: dict, fetched_at: str, run_id: str) -> list[dict]:
    """fields: (lead, url, variable_name, unit, transform, wanted_level or None).
    Each GRIB message is matched to the requested level (DWD files hold one
    level; a MeteoSwiss file is single-level). One instant row per member."""
    cells = nearest_cells(consts["clat"], consts["clon"], resorts, cfg["max_km"])
    if not cells:
        raise RuntimeError("no resort inside the model domain")
    idx = np.array([c[0] for c in cells.values()])
    ids = list(cells)
    hs = consts.get("hsurf")
    lat_deg = np.degrees(consts["clat"]) if np.nanmax(np.abs(consts["clat"])) <= math.pi + 0.01 else consts["clat"]
    lon_deg = np.degrees(consts["clon"]) if np.nanmax(np.abs(consts["clon"])) <= math.pi + 0.01 else consts["clon"]

    def fetch(f):
        url = f[1]
        raw = http(url)
        return f, (bz2.decompress(raw) if url.split("?")[0].endswith(".bz2") else raw)

    rows, mb = [], 0.0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for (lead, url, variable, unit, tf, level), raw in pool.map(fetch, fields):
            mb += len(raw) / 1e6
            t = run_time + timedelta(hours=lead)
            stamp = t.isoformat().replace("+00:00", "Z")
            for keys, vals in grib_messages(raw):
                if level is not None and keys.get("level") not in (None, level):
                    continue
                n = keys.get("perturbationNumber")
                member = 0 if n is None or keys.get("typeOfEnsembleForecast") in (0, 1) and n == 0 else int(n)
                if "ctrl" in url.split("?")[0].split("/")[-1].lower():
                    member = 0
                arr = tf(np.asarray(vals, dtype=float)[idx])
                for k, rid in enumerate(ids):
                    v = float(arr[k])
                    if not math.isfinite(v) or abs(v) > 1e19 or (unit == "m" and v <= -900):
                        continue  # GRIB fill / "no such level": missing, not zero
                    ci = cells[rid][0]
                    rows.append({
                        "source": cfg["source"], "kind": "forecast", "resort_id": rid, "tier": "mid",
                        "elevation_m": int(round(float(hs[ci]))) if hs is not None else None,
                        "lat": round(float(lat_deg[ci]), 4), "lon": round(float(lon_deg[ci]), 4),
                        "station_id": None, "issued_at": run_time.isoformat().replace("+00:00", "Z"),
                        "fetched_at": fetched_at, "valid_start": stamp, "valid_end": stamp,
                        "period_label": "instant", "variable": variable, "value": round(v, 2), "value_text": None,
                        "unit": unit, "model": model, "member": member, "run_id": run_id,
                        "parser_version": PROFILE_PARSER_VERSION,
                    })
    log(f"    profile: {len(fields)} files, {mb:.0f} MB decompressed, {len(rows)} rows ({time.time() - T0:.0f} s)")
    return rows


def profile_bounds(variable: str):
    if variable.startswith("t_"):
        return (-90, 45)
    if variable.startswith("rh_"):
        return (0, 105)
    if variable.startswith("q_"):
        return (0, 40)
    if variable.startswith("z_"):
        return (-1000, 7000)
    if variable in ("freezing_level", "snow_limit"):
        return (-500, 7000)
    return None


# A units or decoding mistake must fail loudly, not land in the archive as
# plausible-looking numbers. Bounds per 6-hour block.
PLAUSIBLE = {"precip": (0, 300), "snow_we": (0, 300), "temp_min": (-60, 45), "temp_max": (-60, 45),
             "wind_speed_max": (0, 400)}


def check_plausible(rows: list[dict]) -> None:
    by: dict[str, list[float]] = {}
    for r in rows:
        by.setdefault(r["variable"], []).append(r["value"])
    bad = []
    for var, vals in sorted(by.items()):
        lo, hi = min(vals), max(vals)
        if len(by) <= 12 or not re.search(r"_\d+hpa$", var) or var.endswith("_850hpa"):
            log(f"    {var}: min {lo:.2f}, max {hi:.2f}, mean {sum(vals) / len(vals):.2f} ({len(vals)} values)")
        b = PLAUSIBLE.get(var) or profile_bounds(var)
        if b and (lo < b[0] or hi > b[1]):
            bad.append(f"{var} outside {b} (min {lo:.2f}, max {hi:.2f})")
    if bad:
        raise RuntimeError("implausible values — not archived: " + "; ".join(bad))


def write_and_upload(work: Path, model: str, cfg: dict, run_time: datetime, rows: list[dict], run_id: str, dry: bool,
                     marker_key: str | None = None) -> None:
    month = run_time.strftime("%Y-%m")
    d = work / run_id
    (d / "rows").mkdir(parents=True, exist_ok=True)
    with gzip.open(d / "rows" / f"{cfg['source']}.ndjson.gz", "wt") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    subprocess.run([sys.executable, str(ROOT / "scripts/archive/to_parquet.py"), str(d / "rows"), str(d / "up/archive"), run_id, month], check=True)
    marker = d / "done.json"
    marker.write_text(json.dumps({"model": model, "run": run_time.isoformat(), "rows": len(rows), "run_id": run_id}))
    if dry:
        log(f"    dry run: {len(rows)} rows written locally, nothing uploaded")
        return
    b = os.environ["R2_BUCKET"]
    r = bucket_cmd("cp", str(d / "up"), f"s3://{b}/", "--recursive")
    if r.returncode:
        raise RuntimeError(f"upload failed: {r.stderr[-300:]}")
    r = bucket_cmd("cp", str(marker), f"s3://{b}/regional/done/{marker_key or model + '-' + f'{run_time:%Y%m%d%H}'}.json")
    if r.returncode:
        raise RuntimeError(f"marker upload failed: {r.stderr[-300:]}")


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    work = Path(args[0])
    dry = "--dry-run" in args
    only = args[args.index("--only") + 1] if "--only" in args else None
    started = time.time()
    resorts = [r for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"] if r.get("latlon") or r.get("nws")]
    for r in resorts:
        r["latlon"] = r.get("latlon") or r.get("nws")
    done = done_markers()
    now = datetime.now(timezone.utc)
    fetched_at = now.isoformat().replace("+00:00", "Z")
    gh = os.environ.get("GITHUB_RUN_ID", "local")
    failures, collected, waiting = [], [], []

    for model, cfg in MODELS.items():
        if only and model != only:
            continue
        # Every target run in the last ~24 h (the servers' window), newest first.
        cands = []
        for back in range(0, 2):
            day = (now - timedelta(days=back)).date()
            for h in cfg["runs"]:
                rt = datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc)
                if timedelta(hours=1) < now - rt < timedelta(hours=23):
                    cands.append(rt)
        for rt in sorted(cands, reverse=True):
            key = f"{model}-{rt:%Y%m%d%H}"
            if key in done:
                continue
            if time.time() - started > TIME_LIMIT_S:
                waiting.append(f"{key}: time limit, next invocation")
                continue
            try:
                expected = cfg["leads"](rt.hour)
                files_by_var, missing = {}, []
                if cfg["kind"] == "dwd":
                    for var, (dvar, _, _) in VARS.items():
                        if var not in cfg.get("vars", VARS):
                            continue
                        listing = dwd_files(model, rt.hour, dvar)
                        leads = {l: [u] for l, (stamp, u) in listing.items() if stamp == f"{rt:%Y%m%d%H}"}
                        if leads:
                            files_by_var[var] = leads
                        else:
                            missing.append(var)
                    consts = dwd_constants(model, rt.hour) if files_by_var else {}
                else:
                    for var, (_, cvar, _) in VARS.items():
                        pert = ch_items(cfg["collection"], rt, cvar, True)
                        ctrl = ch_items(cfg["collection"], rt, cvar, False)
                        leads = {l: [u for u in (ctrl.get(l), pert.get(l)) if u] for l in set(pert) | set(ctrl)}
                        if leads:
                            files_by_var[var] = leads
                        else:
                            missing.append(var)
                    consts = ch_constants(cfg["collection"]) if files_by_var else {}
                if "tot_prec" not in files_by_var:
                    if now - rt < timedelta(hours=8):
                        waiting.append(f"{key}: not published yet")
                    else:
                        failures.append(f"{key}: precipitation not found on the server")
                    continue
                have = set(files_by_var["tot_prec"])
                if not set(expected) <= have:
                    short = sorted(set(expected) - have)
                    if now - rt < timedelta(hours=8):
                        waiting.append(f"{key}: still publishing ({len(short)} leads to come)")
                        continue
                    failures.append(f"{key}: incomplete after 8 h — missing leads {short[:10]}…")
                    continue
                if missing:
                    log(f"  · {key}: not offered: {', '.join(missing)}")
                run_id = f"{rt:%Y-%m-%dT%H%M}Z-{model}-{gh}"
                rows = collect_run(model, cfg, rt, resorts, files_by_var, consts, fetched_at, run_id)
                if not rows:
                    raise RuntimeError("no rows built")
                check_plausible(rows)
                write_and_upload(work, model, cfg, rt, rows, run_id, dry)
                collected.append(f"{key}: {len(rows)} rows")
                log(f"  ✓ {key}: {len(rows)} rows ({time.time() - started:.0f} s elapsed)")
            except Exception as e:
                failures.append(f"{key}: {e}")
                log(f"  ✗ {key}: {e}")

    # ---- second pass: upper-air profiles, with whatever time is left
    for model, cfg in MODELS.items():
        if only and model != only:
            continue
        cands = []
        for back in range(0, 2):
            day = (now - timedelta(days=back)).date()
            for h in cfg["runs"]:
                rt = datetime(day.year, day.month, day.day, h, tzinfo=timezone.utc)
                if timedelta(hours=1) < now - rt < timedelta(hours=23):
                    cands.append(rt)
        for rt in sorted(cands, reverse=True):
            key = f"{model}+profile-{rt:%Y%m%d%H}"
            if key in done or f"{model}-{rt:%Y%m%d%H}" not in done | {c.split(":")[0] for c in collected}:
                continue  # profiles only for runs whose surface pass is archived (so the run is complete)
            # A profile pass takes ~4–10 min (D2 03z: 120 files, 1.7 GB, 230 s on 2026-11-11), so stop
            # starting them 12 min before the soft limit; the 60-min job timeout must never cut one off.
            if time.time() - started > TIME_LIMIT_S - 12 * 60:
                waiting.append(f"{key}: time limit, next invocation")
                continue
            try:
                leads = profile_leads(rt.hour, cfg["profile_max_lead"])
                fields = []
                if cfg["kind"] == "dwd":
                    have = []
                    for pvar, (dvar, prefix, unit, tf) in DWD_PROFILE.items():
                        files = dwd_profile_files(model, rt.hour, dvar, f"{rt:%Y%m%d%H}", set(leads))
                        if files:
                            have.append(f"{dvar} {sorted({lv for _, lv in files})}")
                        fields += [(l, u, f"{prefix}_{lv}hpa", unit, tf, lv) for (l, lv), u in sorted(files.items())]
                    log(f"  {key}: pressure levels offered: {'; '.join(have) or 'none'}")
                    consts = dwd_constants(model, rt.hour)
                else:
                    offered = ch_variables(cfg["collection"], rt)
                    log(f"  {key}: STAC variables offered: {', '.join(offered) or 'none'}")
                    for cvar, (name, unit) in CH_PROFILE.items():
                        if cvar not in offered:
                            continue
                        for pert in (False, True):
                            for l, u in ch_items(cfg["collection"], rt, cvar, pert).items():
                                if l in leads:
                                    fields.append((l, u, name, unit, lambda a: a, None))
                    consts = ch_constants(cfg["collection"])
                if not fields:
                    failures.append(f"{key}: no profile fields found on the server (see the offered list above)")
                    continue
                run_id = f"{rt:%Y-%m-%dT%H%M}Z-{model}-prof-{gh}"
                rows = profile_rows(model, cfg, rt, resorts, fields, consts, fetched_at, run_id)
                if not rows:
                    raise RuntimeError("no profile rows built")
                check_plausible(rows)
                write_and_upload(work, model, cfg, rt, rows, run_id, dry, marker_key=key)
                collected.append(f"{key}: {len(rows)} rows")
                log(f"  ✓ {key}: {len(rows)} rows ({time.time() - started:.0f} s elapsed)")
            except Exception as e:
                failures.append(f"{key}: {e}")
                log(f"  ✗ {key}: {e}")

    lines = ["regional ensembles:"] + [f"  ✓ {c}" for c in collected] + [f"  … {w}" for w in waiting] + [f"  ✗ {f}" for f in failures]
    if not (collected or waiting or failures):
        lines.append("  nothing to do (every run on the server is already archived)")
    report = "\n".join(lines)
    log("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(f"### Regional ensembles\n\n```\n{report}\n```\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
