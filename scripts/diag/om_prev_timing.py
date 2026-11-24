#!/usr/bin/env python3
"""Which model run fills each hour of Open-Meteo Previous Runs `previous_day1`? (2026-11-24, Opus 5.5)

    python3 scripts/diag/om_prev_timing.py <archive dir> <outDir>

<archive dir>: a local copy of archive/source=open-meteo-previous-runs/ (aws s3 sync, as previous-runs-probe.yml does).

Read-only probe, report only. Public models only (Open-Meteo, our archive's open-meteo-previous-runs rows); no paid
source is read. Writes om_prev_timing.md / .json.

Why: build.py stamps previous_dayN as lead_hours = 24*N with no issue time. NBM and HRRR are scored by their real
issue time. If Open-Meteo built hour V of previous_day1 from a run issued AFTER the resort-local day started, blend-v1
at lead 1 held information NBM/HRRR did not, and the head-to-heads (HRRR FAIL 2026-11-22, NBM FAIL 2026-11-24) are
tilted toward v1.

What the docs say (2026-11-24): previous-runs-api page: "_previous_day1 is the value that was predicted 24 hours
before valid time". Open-Meteo blog 2024-04-19: "the initial 24 hours of each weather model run are disregarded. In
models updating every 3 hours, time steps 24, 25, and 26 are utilized to form a continuous time-series." Nothing
says how 6- or 12-hourly models or the seamless models (gfs_seamless, gem_seamless) are handled. Hence this test.

TEST DESIGN, written and committed BEFORE the probe was run
===========================================================
Hypotheses for model M with cycle c (6 h ECMWF/GFS, 6 or 12 h GEM):
  H_step  hour V comes from the newest run with step V − init ≥ 24 h, i.e. init = floor_c(V − 24 h). Steps 24..24+c−1.
          Inits change at fixed UTC hours; for any resort the newest run used for local day D is issued ≤ 1 h before
          D starts (last hour of D minus 24 h). No hour of previous_day1 uses a run issued after D starts.
  H_day   one run per (UTC or local) day: all hours of a day share one init; steps span ≥ 23 h within the day.
  H_late  some hours come from runs with step < 24 h (fresher than "24 h before"); these are the ones that could
          leak runs issued after the local day started.

Test A (decisive for the mechanism, live dates): for 2 resorts (alta, America/Denver; palisades, America/Los_Angeles),
2 UTC days (2026-11-18, 2026-11-19, the Wasatch storm), each model: fetch hourly precipitation + temperature_2m
`previous_day1` from the Previous Runs API, and every candidate run 2026-11-16 00Z → 2026-11-19 18Z (every 6 h) from
the Single Runs API (archived from April 2026), same lat/lon/elevation as our archived rows. For each hour, the runs
whose temperature AND precipitation both equal previous_day1 (|Δ| ≤ 0.051) are its matches. Outcomes:
  H_step  ≥ 95% of uniquely matched hours have init = floor_c(V − 24 h) (c = 6, or 12 for GEM if 6-hourly runs
          are not offered), AND ≥ 80% of hours have at least one match.
  H_day   ≥ 95% of uniquely matched hours of each UTC day share one init (and steps span ≥ 12 h).
  H_late  ≥ 5% of uniquely matched hours have step < 24 h.
  UNKNOWN anything else, including < 80% of hours matched (e.g. the two APIs interpolate differently): then the
          mechanism is NOT pinned by this test and we say so.

Test B (our archive is what the API serves): (i) archived hourly `temp` rows, previous_day1, om-prev-2, for the same
resort-days must equal the API fetch (|Δ| ≤ 0.051) on ≥ 99% of hours; (ii) archived 6-hour `precip` blocks,
previous_day1, for 2025-01-05 → 2025-01-31 and 2026-01-05 → 2026-01-31 (the scored winters) must equal the API
re-fetch summed into the same blocks (|Δ| ≤ 0.11 mm) on ≥ 99% of blocks. If (ii) holds, the rows we scored are the
product Open-Meteo serves today for those dates, so Test C on a re-fetch speaks for them.

Test C (the scored winters, indirect): Single Runs history starts April 2026, so the winters 2024-25/2025-26 cannot
be matched run-by-run. Run boundaries leave a step in an hourly series. For hourly temperature_2m_previous_day1 over
the two January windows above (and 2026-11-01 → 11-22 as calibration, where Test A gives the truth), per model and
resort: s(h) = standard deviation over days of ΔT(V) = T(V) − T(V − 1 h), for UTC hour h of V.
  boundary ratio  R_b = median s(h) at h ∈ {0, 6, 12, 18} ÷ median s(h) at the other hours (GEM: {0, 12} if
                  Test A shows 12-hourly use)
  local-midnight  R_m = s(local midnight hour) ÷ median s(h) at the hours that are neither boundary nor midnight
  Consistent with H_step: R_b ≥ 1.3 and R_m < 1.3.   Consistent with H_day (local): R_m ≥ 1.3 and R_b < 1.3.
  Otherwise inconclusive. Evidence, not proof: it shows where runs change, not which run.
  The calibration window must show the Test-A answer; if it does not, Test C is reported as uninformative.

Failures are loud: a non-400 HTTP error after retries, an empty response, or no archived rows aborts with exit 1.
A 400 for a run that is not offered is counted and reported, never treated as zero.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median, pstdev
from zoneinfo import ZoneInfo

PREV_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
SINGLE_URL = "https://single-runs-api.open-meteo.com/v1/forecast"
MODELS = {"ecmwf_ifs025": ["ecmwf_ifs025"], "gfs_seamless": ["gfs_seamless"], "gem_seamless": ["gem_seamless", "cmc_gem_seamless"]}
RESORTS = {"alta": "America/Denver", "palisades": "America/Los_Angeles"}
DAYS = ("2026-11-18", "2026-11-19")
INITS = [datetime(2026, 11, 16, tzinfo=timezone.utc) + timedelta(hours=6 * i) for i in range(16)]  # 16 00Z → 19 18Z
JUMP_WINDOWS = {"2024-25 (Jan 2025)": ("2025-01-05", "2025-01-31"), "2025-26 (Jan 2026)": ("2026-01-05", "2026-01-31"),
                "calibration (Nov 2026)": ("2026-11-01", "2026-11-22")}
TOL, TOL_BLOCK = 0.051, 0.11
DELAY = float(os.environ.get("OM_DELAY_S", "1.0"))
CALLS = {"ok": 0, "400": 0}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class NotOffered(Exception):
    pass


def get(url: str, params: dict) -> dict:
    q = f"{url}?{urllib.parse.urlencode(params)}"
    for attempt in range(4):
        time.sleep(DELAY)
        try:
            with urllib.request.urlopen(q, timeout=60) as r:
                j = json.loads(r.read())
            CALLS["ok"] += 1
            if not j.get("hourly", {}).get("time"):
                raise SystemExit(f"empty hourly response from {url.split('/')[2]} ({params.get('models')})")
            return j
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            if e.code == 400:
                CALLS["400"] += 1
                raise NotOffered(body)
            if attempt == 3:
                raise SystemExit(f"HTTP {e.code} from {url.split('/')[2]} after retries: {body}")
            time.sleep(10 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 3:
                raise SystemExit(f"network error from {url.split('/')[2]} after retries: {e}")
            time.sleep(10 * (attempt + 1))


def ts(t: str) -> datetime:
    return datetime.fromisoformat(t).replace(tzinfo=timezone.utc)


def series(j: dict, key: str) -> dict:
    return {ts(t): v for t, v in zip(j["hourly"]["time"], j["hourly"].get(key) or []) if isinstance(v, (int, float))}


def archived(archive_dir: str):
    """Coordinates/elevation of our archived previous-runs rows, archived hourly temp (live days) and 6-h precip blocks
    (January windows), previous_day1. Public-safe: Open-Meteo only."""
    import duckdb
    files = sorted(str(p) for p in Path(archive_dir).rglob("*.parquet"))
    if not files:
        raise SystemExit(f"no parquet under {archive_dir}")
    log(f"archive: {len(files)} parquet files")
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    flist = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
    ids = tuple(RESORTS)
    con.execute(f"""CREATE TABLE a AS SELECT resort_id, model, lat, lon, elevation_m, valid_start, valid_end, variable, value,
                           parser_version, run_id, fetched_at
                    FROM read_parquet({flist}, union_by_name=true, hive_partitioning=false)
                    WHERE resort_id IN {ids} AND period_label = 'previous_day1' AND variable IN ('temp', 'precip')
                      AND ((valid_start >= TIMESTAMP '2026-11-01' AND valid_start < TIMESTAMP '2026-11-23')
                        OR (valid_start >= TIMESTAMP '2025-01-05' AND valid_start < TIMESTAMP '2025-02-01')
                        OR (valid_start >= TIMESTAMP '2026-01-05' AND valid_start < TIMESTAMP '2026-02-01'))""")
    n = con.execute("SELECT count(*) FROM a").fetchone()[0]
    if not n:
        raise SystemExit("no archived open-meteo-previous-runs rows for the probe resorts/windows")
    # newest fetch wins, as build.py does
    con.execute("""CREATE TABLE b AS SELECT * FROM a QUALIFY row_number() OVER (
                   PARTITION BY resort_id, model, variable, valid_start, valid_end ORDER BY fetched_at DESC) = 1""")
    coords = {}
    for r, m, lat, lon, el in con.execute("""SELECT resort_id, model, any_value(lat), any_value(lon), any_value(elevation_m)
                                             FROM b WHERE valid_start >= TIMESTAMP '2026-11-01' GROUP BY 1, 2""").fetchall():
        coords[(r, m)] = (lat, lon, el)
    temp = {}
    for r, m, vs, v in con.execute("SELECT resort_id, model, valid_start, value FROM b WHERE variable = 'temp'").fetchall():
        temp[(r, m, vs.astimezone(timezone.utc))] = v
    blocks = {}
    for r, m, vs, ve, v in con.execute("""SELECT resort_id, model, valid_start, valid_end, value FROM b
                                          WHERE variable = 'precip' AND valid_start < TIMESTAMP '2026-11-01'""").fetchall():
        blocks[(r, m, vs.astimezone(timezone.utc))] = ((ve - vs).total_seconds() / 3600, v)
    pv = con.execute("SELECT variable, coalesce(parser_version,'?'), count(*) FROM b GROUP BY ALL ORDER BY 1, 2").fetchall()
    return coords, temp, blocks, pv


def loc(coords, r, m):
    c = coords.get((r, m)) or next((v for (rr, _), v in coords.items() if rr == r), None)
    if not c:
        raise SystemExit(f"no archived coordinates for {r}")
    p = {"latitude": c[0], "longitude": c[1], "timezone": "GMT"}
    if c[2] is not None:
        p["elevation"] = c[2]
    return p


def floor_cycle(t: datetime, c: int) -> datetime:
    return t.replace(minute=0, second=0, microsecond=0, hour=(t.hour // c) * c)


def test_a(coords) -> dict:
    out = {}
    hours = [ts(f"{d}T00:00") + timedelta(hours=h + 1) for d in DAYS for h in range(24)]  # labels 01Z..24Z
    for r in RESORTS:
        for m, ids in MODELS.items():
            log(f"test A {r} {m}")
            p = loc(coords, r, m)
            prev = None
            for mid in ids:
                try:
                    prev = get(PREV_URL, {**p, "models": mid, "start_date": DAYS[0], "end_date": "2026-11-20",
                                          "hourly": "precipitation_previous_day1,temperature_2m_previous_day1"})
                    break
                except NotOffered:
                    continue
            if prev is None:
                raise SystemExit(f"Previous Runs refused every id for {m}")
            pt, pp = series(prev, "temperature_2m_previous_day1"), series(prev, "precipitation_previous_day1")
            runs, offered, used_id = {}, [], None
            for init in INITS:
                for mid in ids:
                    try:
                        j = get(SINGLE_URL, {**p, "models": mid, "run": init.strftime("%Y-%m-%dT%H:%M"), "forecast_days": 5,
                                             "hourly": "precipitation,temperature_2m"})
                        runs[init] = (series(j, "temperature_2m"), series(j, "precipitation"))
                        offered.append(init.strftime("%dT%HZ"))
                        used_id = mid
                        break
                    except NotOffered:
                        continue
            rows = []
            for V in hours:
                if V not in pt or V not in pp:
                    rows.append((V, None, []))
                    continue
                match = [i for i, (t, pr) in runs.items() if V in t and V in pr and i <= V
                         and abs(t[V] - pt[V]) <= TOL and abs(pr[V] - pp[V]) <= TOL]
                rows.append((V, pt[V], match))
            have = [x for x in rows if x[1] is not None]
            uniq = [(V, mt[0]) for V, _, mt in have if len(mt) == 1]
            anym = [x for x in have if x[2]]
            steps = {}
            for V, i in uniq:
                s = int((V - i).total_seconds() // 3600)
                steps[s] = steps.get(s, 0) + 1
            res = {"single_runs_id": used_id, "runs_offered": offered, "hours": len(have), "any_match": len(anym),
                   "unique": len(uniq), "steps_unique": dict(sorted(steps.items()))}
            for c in (6, 12):
                res[f"floor{c}"] = sum(1 for V, i in uniq if i == floor_cycle(V - timedelta(hours=24), c))
            res["step_lt_24"] = sum(1 for V, i in uniq if (V - i) < timedelta(hours=24))
            # one-init-per-UTC-day share
            per_day = {}
            for V, i in uniq:
                per_day.setdefault((V - timedelta(hours=1)).date(), {}).setdefault(i, 0)
                per_day[(V - timedelta(hours=1)).date()][i] += 1
            res["max_share_one_init_per_day"] = min((max(d.values()) / sum(d.values()) for d in per_day.values()), default=None)
            tz = ZoneInfo(RESORTS[r])
            res["inits_used_after_local_day_start"] = sum(
                1 for V, i in uniq
                if i >= datetime.combine((V - timedelta(hours=1)).astimezone(tz).date(), datetime.min.time(), tz).astimezone(timezone.utc))
            res["sample"] = [(V.strftime("%d %HZ"), [i.strftime("%dT%HZ") for i in mt]) for V, _, mt in have[:48]]
            out[f"{r}|{m}"] = res
    return out


def classify(res: dict) -> str:
    u = res["unique"]
    if not res["hours"] or res["any_match"] < 0.8 * res["hours"] or u == 0:
        return "UNKNOWN"
    if res["step_lt_24"] >= 0.05 * u:
        return "H_late"
    if res["floor6"] >= 0.95 * u or res["floor12"] >= 0.95 * u:
        return "H_step"
    if res["max_share_one_init_per_day"] is not None and res["max_share_one_init_per_day"] >= 0.95:
        return "H_day"
    return "UNKNOWN"


def test_b_c(coords, atemp, ablocks) -> tuple[dict, dict]:
    b, c = {}, {}
    for r, tzname in RESORTS.items():
        tz = ZoneInfo(tzname)
        for m, ids in MODELS.items():
            p = loc(coords, r, m)
            for wname, (d0, d1) in JUMP_WINDOWS.items():
                j = None
                for mid in ids:
                    try:
                        j = get(PREV_URL, {**p, "models": mid, "start_date": d0, "end_date": d1,
                                           "hourly": "precipitation_previous_day1,temperature_2m_previous_day1"})
                        break
                    except NotOffered:
                        continue
                if j is None:
                    raise SystemExit(f"Previous Runs refused {m} for {wname}")
                T, P = series(j, "temperature_2m_previous_day1"), series(j, "precipitation_previous_day1")
                key = f"{r}|{m}|{wname}"
                # B(i): archived hourly temp (calibration window) vs API; B(ii): archived 6-h precip blocks vs API
                if wname.startswith("calibration"):
                    pairs = [(v, T[t]) for (rr, mm, t), v in atemp.items() if rr == r and mm == m and t in T]
                    b[key] = {"kind": "hourly temp", "n": len(pairs), "equal": sum(abs(x - y) <= TOL for x, y in pairs)}
                else:
                    eq = n = 0
                    for (rr, mm, vs), (hrs, v) in ablocks.items():
                        if rr != r or mm != m or not (ts(d0 + "T00:00") <= vs < ts(d1 + "T00:00")):
                            continue
                        hs = [vs + timedelta(hours=k + 1) for k in range(int(hrs))]
                        if all(h in P for h in hs):
                            n += 1
                            eq += abs(sum(P[h] for h in hs) - v) <= TOL_BLOCK
                    b[key] = {"kind": "6-h precip blocks", "n": n, "equal": eq}
                # C: step signature in hourly temperature
                byh = {}
                for t, v in T.items():
                    if t - timedelta(hours=1) in T:
                        byh.setdefault(t.hour, []).append(v - T[t - timedelta(hours=1)])
                s = {h: pstdev(x) for h, x in byh.items() if len(x) >= 10}
                bnd = {0, 6, 12, 18}
                # local midnight as a UTC label hour: the first hour of the local day ends at 01 local
                mid_h = datetime(int(d0[:4]), int(d0[5:7]), 15, 1, tzinfo=tz).astimezone(timezone.utc).hour
                other = [v for h, v in s.items() if h not in bnd and h != mid_h]
                rb = median([s[h] for h in bnd if h in s]) / median([v for h, v in s.items() if h not in bnd]) if s else None
                rm = s.get(mid_h, float("nan")) / median(other) if other else None
                verdict = ("consistent with H_step" if rb and rb >= 1.3 and rm < 1.3 else
                           "consistent with H_day (local)" if rm and rm >= 1.3 and rb < 1.3 else "inconclusive")
                c[key] = {"R_b": rb, "R_m": rm, "midnight_label_hour_utc": mid_h, "verdict": verdict,
                          "s_by_hour": {h: round(v, 3) for h, v in sorted(s.items())}}
    return b, c


def main(archive_dir: str, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    coords, atemp, ablocks, pv = archived(archive_dir)
    log(f"archive read: {len(coords)} resort/models, {len(atemp)} hourly temps, {len(ablocks)} precip blocks")
    A = test_a(coords)
    log("test A done")
    for k, v in A.items():
        v["verdict"] = classify(v)
    B, C = test_b_c(coords, atemp, ablocks)
    models_verdict = {}
    for m in MODELS:
        vs = {A[f"{r}|{m}"]["verdict"] for r in RESORTS}
        models_verdict[m] = vs.pop() if len(vs) == 1 else "UNKNOWN (resorts disagree)"
    b_ok = all(x["n"] > 0 and x["equal"] >= 0.99 * x["n"] for x in B.values())
    res = {"test_a": A, "test_a_by_model": models_verdict, "test_b": B, "test_b_pass": b_ok, "test_c": C,
           "archived_rows_by_parser": pv, "calls": CALLS}
    (out / "om_prev_timing.json").write_text(json.dumps(res, default=str, indent=1))
    L = ["# Which run fills each hour of Open-Meteo previous_day1 (scripts/diag/om_prev_timing.py)\n",
         "Pre-registered in the docstring (commit 1c76008) before this ran. Public data only.\n",
         f"API calls: {CALLS['ok']} ok, {CALLS['400']} refused (400: run or model id not offered).\n",
         "## Test A: hour-by-hour match against single runs (2026-11-18/19)\n",
         "| resort / model | single-runs id | hours | ≥1 match | unique | init = floor6(V−24h) | floor12(V−24h) | step < 24 h | init ≥ local day start | min one-init-per-day share | steps (unique) | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for k, v in A.items():
        L.append(f"| {k} | {v['single_runs_id']} | {v['hours']} | {v['any_match']} | {v['unique']} | {v['floor6']} | {v['floor12']} | "
                 f"{v['step_lt_24']} | {v['inits_used_after_local_day_start']} | "
                 f"{'' if v['max_share_one_init_per_day'] is None else round(v['max_share_one_init_per_day'], 2)} | {v['steps_unique']} | **{v['verdict']}** |")
    L.append("\nBy model: " + ", ".join(f"{m} **{v}**" for m, v in models_verdict.items()) + "\n")
    L.append("Runs offered by Single Runs: " + "; ".join(f"{k}: {len(v['runs_offered'])}/16" for k, v in A.items()) + "\n")
    L += ["## Test B: our archive = what the API serves\n", "| resort / model / window | compared | equal | share |", "|---|---|---|---|"]
    for k, v in B.items():
        L.append(f"| {k} ({v['kind']}) | {v['n']} | {v['equal']} | {v['equal'] / v['n']:.3f} |" if v["n"] else f"| {k} ({v['kind']}) | 0 | 0 | NO DATA |")
    L.append(f"\nTest B: **{'PASS' if b_ok else 'FAIL'}** (every cell ≥ 99% equal and non-empty).\n")
    L += ["## Test C: where hourly temperature steps (run boundaries)\n", "| resort / model / window | R_b (00/06/12/18Z) | R_m (local midnight) | verdict |", "|---|---|---|---|"]
    for k, v in C.items():
        L.append(f"| {k} | {v['R_b']:.2f} | {v['R_m']:.2f} (label {v['midnight_label_hour_utc']:02d}Z) | {v['verdict']} |")
    L.append("\nArchived previous_day1 rows read (variable, parser, rows): " + "; ".join(f"{a} {b} {c}" for a, b, c in pv) + "\n")
    text = "\n".join(L) + "\n"
    (out / "om_prev_timing.md").write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
