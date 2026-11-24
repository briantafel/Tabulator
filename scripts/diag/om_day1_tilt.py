#!/usr/bin/env python3
"""Is blend-v1's day-1 lead over NBM and HRRR flattered by Open-Meteo previous_day1 timing? (2026-11-24, Opus 5.5)

    python3 scripts/diag/om_day1_tilt.py <pairs.parquet> <timing.json> <outDir>

Report only: no change to the app, the blend, build.py or any switch. Public models and SNOTEL/BC truth only.
<timing.json> is the output of scripts/diag/om_prev_timing.py (which run fills each hour).

VERDICT RULE, written and committed 2026-11-24 BEFORE any number below was computed (template: blend_nbm.py)
=========================================================================================================
Data, the same as blend_hrrr.py / blend_nbm.py: fit 2024-25 ('train'), judge 2025-26 ('test'), Nov–Apr, strict
SNOTEL/BC pairs, mid tier, liquid. v1 = blend.py fit() unchanged. NBM: 00z/12z, issued 2024-11-01 → 2026-04-30,
cycle rules `latest` and `earliest` exactly as blend_nbm.py. HRRR (noaa-hrrr): `latest` and `first` exactly as
blend_hrrr.py. 90% bootstrap over 7-day date blocks, 1000 resamples, fixed seed.

Part 1, analytic (needs the timing verdict). If timing.json says H_step for all three models, compute for each
time zone in the scored set the share of a local day's scored water weight (verify's pro-rata split of 6-hour UTC
blocks, uniform over hours) that comes from runs initialised (i) at or after the local day start, (ii) after the
comparator's run (NBM latest 00z, NBM earliest 12z, HRRR latest/first by their own rule). No data, arithmetic only.

Part 2, conservative head-to-head (always run): v1 built from previous_day2 (its lead-2 forecast of local day D,
lead-2 weights and factors from the train winter) against each comparator's LEAD-1 forecast of the same day D.
Under any timing hypothesis every Open-Meteo run in previous_day2 for day D is issued ≥ 24 h before the runs in
previous_day1, so this comparison is tilted AGAINST v1. Same resort-days for every column of one comparator: ECMWF,
GFS, GEM at lead 2 and the comparator at lead 1. Also reported on the same days: v1 at lead 1 (the original).

  per comparator X ∈ {NBM latest, NBM earliest, HRRR latest, HRRR first}, ≥ 10 mm and ≥ 2.5 mm:
    "v1 lead robust"         v1@2 − X@1, ≥ 10 mm CSI 5th percentile > 0
    "X beats stale v1"       ≥ 10 mm 95th percentile < 0
    "no clear difference"    otherwise
  A cell needs ≥ 300 test resort-days with ≥ 10 mm observed and ≥ 10 resorts, else INSUFFICIENT (claims nothing).
  HRRR covers lead 1 only, so its common days are lead-1 HRRR days that also have Open-Meteo lead 2.

Answer to "is v1's day-1 lead real?" for comparator X (whose earlier verdict had v1 ahead or level):
  REAL                timing H_step for all three models AND analytic share (i) < 5% of the day's weight,
                      OR Part 2 says "v1 lead robust".
  PARTLY AN ARTIFACT  timing H_late (some hours use runs with step < 24 h) AND Part 2 says "X beats stale v1".
  UNKNOWABLE          anything else (e.g. timing UNKNOWN and Part 2 "no clear difference"). We say so.
Does an earlier verdict change? Only if the answer for that comparator is PARTLY AN ARTIFACT. The HRRR and NBM
gates themselves are not re-run or re-judged here (blend_hrrr.py and blend_nbm.py stay as committed).

Not gated, reported: ≥ 20 mm, MAE, volume, the v1@1 − v1@2 gap (what one day of Open-Meteo freshness is worth).
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "model"))
import blend as B  # noqa: E402
import blend_nbm as N  # noqa: E402  (BASE, table(), NBM range: the same rules as the NBM head-to-head)

OM = N.OM
SEED = 20261124
COMPARATORS = {  # name: (source, cycles UTC, rule)
    "NBM latest": ("nbm", (0, 12), "DESC"), "NBM earliest": ("nbm", (0, 12), "ASC"),
    "HRRR latest": ("noaa-hrrr", None, "DESC"), "HRRR first": ("noaa-hrrr", None, "ASC")}
HRRR_CYCLES = (0, 6, 12, 18)  # the HRRR history the head-to-head scored (blend_hrrr.py: "4 runs a day")
BASE12 = N.BASE.replace("lead_day BETWEEN 1 AND 7", "lead_day IN (1, 2)")


# ------------------------------------------------------------------ part 1: arithmetic under H_step
def shares(tzname: str, cycle: int, comp_times: dict, day: date = date(2026, 1, 15)) -> dict:
    """Share of local day `day`'s scored weight (verify's pro-rata split of 6-h UTC blocks, uniform over hours) from runs
    initialised at/after the local day start, and after each comparator's run, if hour V uses init floor_c(V − 24 h)."""
    tz = ZoneInfo(tzname)
    S = datetime.combine(day, datetime.min.time(), tz).astimezone(timezone.utc)
    E = S + timedelta(hours=24)
    w = {}
    b = S.replace(hour=(S.hour // 6) * 6)
    while b < E:
        ov = (min(b + timedelta(hours=6), E) - max(b, S)).total_seconds() / 3600
        for k in range(6):
            V = b + timedelta(hours=k + 1)
            i = V - timedelta(hours=24)
            i = i.replace(hour=(i.hour // cycle) * cycle)
            w[i] = w.get(i, 0) + ov / 6 / 24
        b += timedelta(hours=6)
    out = {"after_day_start": sum(v for i, v in w.items() if i >= S),
           "newest_init_h_before_start": min((S - i).total_seconds() / 3600 for i in w if w[i] > 0),
           "weighted_mean_init_h_before_start": sum((S - i).total_seconds() / 3600 * v for i, v in w.items())}
    for name, t in comp_times.items():
        out[f"newer_than {name}"] = sum(v for i, v in w.items() if i > t(S, tz))
    return out


def comp_time(cycles, latest: bool):
    def f(S, tz):
        d1 = (S.astimezone(tz) - timedelta(hours=12)).date()  # local issue date D−1
        c = [datetime(d1.year, d1.month, d1.day, tzinfo=tz).astimezone(timezone.utc).replace(minute=0) + timedelta(hours=h)
             for h in range(-24, 48)]
        c = [x for x in c if x.hour in cycles and x.astimezone(tz).date() == d1]
        return max(c) if latest else min(c)
    return f


# ------------------------------------------------------------------ part 2: v1 from previous_day2 vs X at lead 1
def frames(con, pairs: Path, comp: str):
    src, cycles, order = COMPARATORS[comp]
    nbm = (f"AND issue_ts >= TIMESTAMP '{N.NBM_FROM}' AND issue_ts < TIMESTAMP '{N.NBM_TO}' AND hour(issue_ts) IN (0, 12)"
           if src == "nbm" else "")
    con.execute(f"""
    CREATE OR REPLACE TABLE om AS
    SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date, lead_day AS lead, split, fc_amount AS fc, obs
    FROM read_parquet('{pairs}') WHERE source = '{B.SOURCE}' AND {BASE12}""")
    con.execute(f"""
    CREATE OR REPLACE TABLE x AS SELECT resort_id, local_date, split, fc_amount AS fc, obs, issue_ts, lead_hours FROM (
      SELECT * FROM read_parquet('{pairs}') WHERE source = '{src}' AND {N.BASE} AND lead_day = 1 AND lead_hours > 0 {nbm}
      QUALIFY row_number() OVER (PARTITION BY resort_id, local_date ORDER BY issue_ts {order}) = 1)""")
    con.execute("""CREATE OR REPLACE TABLE k AS SELECT resort_id, local_date FROM om GROUP BY ALL
                   HAVING count(DISTINCT model || ':' || lead) = 6
                   INTERSECT SELECT resort_id, local_date FROM x""")
    rows = con.execute("SELECT om.* FROM om JOIN k USING (resort_id, local_date)").fetchdf()
    c = duckdb.connect()
    c.register("rows_df", rows)
    c.execute("CREATE TABLE d AS SELECT * FROM rows_df")
    p = B.fit(c)
    c.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    c.executemany("INSERT INTO w VALUES (?, ?, ?)", [(int(l), m, v) for l, ws in p["weights"].items() for m, v in ws.items()])
    t = c.execute("""SELECT resort_id, local_date, lead, any_value(obs) AS obs, sum(w.w * fcc) / sum(w.w) AS fc
                     FROM dc JOIN w USING (lead, model) WHERE split = 'test' GROUP BY ALL""").fetchdf()
    v1a, v1b = t[t.lead == 1].copy(), t[t.lead == 2].copy()
    v1b["lead"] = 1
    xd = con.execute("SELECT resort_id, local_date, 1 AS lead, obs, fc FROM x JOIN k USING (resort_id, local_date) WHERE split = 'test'").fetchdf()
    ntr = con.execute("SELECT count(*) FROM k JOIN (SELECT DISTINCT resort_id, local_date, split FROM x) USING (resort_id, local_date) WHERE split = 'train'").fetchone()[0]
    # loud, never filtered quietly: any comparator row in range issued at/after its local day start aborts the run
    leak = con.execute(f"""SELECT count(*) FILTER (WHERE lead_hours IS NULL OR lead_hours <= 0) FROM read_parquet('{pairs}')
                          WHERE source = '{src}' AND {N.BASE} AND lead_day = 1 {nbm}""").fetchone()[0]
    return {"v1@1": v1a, "v1@2": v1b, f"{comp}@1": xd}, ntr, leak


def call(diff: dict, ev: int, resorts: int) -> str:
    if ev < N.MIN_EVENTS or resorts < N.MIN_RESORTS:
        return "INSUFFICIENT"
    if diff["p05"] > 0:
        return "v1 lead robust"
    if diff["p95"] < 0:
        return "X beats stale v1"
    return "no clear difference"


def main(pairs: Path, timing: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    tj = json.loads(timing.read_text())
    tv = tj["test_a_by_model"]
    all_step, any_late = all(v == "H_step" for v in tv.values()), any(v == "H_late" for v in tv.values())
    gem_cycle = 12
    gem = [v for k, v in tj["test_a"].items() if k.endswith("gem_seamless")]
    if gem and sum(v["floor6"] for v in gem) >= sum(v["floor12"] for v in gem):
        gem_cycle = 6
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    meta = json.loads((HERE.parent.parent / "src/data/resorts.json").read_text())
    tzs = {r["id"]: r["tz"] for r in meta["resorts"]}
    scored = con.execute(f"SELECT DISTINCT resort_id FROM read_parquet('{pairs}') WHERE source = '{B.SOURCE}' AND {N.BASE} AND split = 'test'").fetchall()
    zones = sorted({tzs[r[0]] for r in scored if r[0] in tzs})
    ct = {"NBM latest": comp_time((0, 12), True), "NBM earliest": comp_time((0, 12), False),
          "HRRR latest": comp_time(HRRR_CYCLES, True), "HRRR first": comp_time(HRRR_CYCLES, False)}
    L = ["# Is blend-v1's day-1 lead flattered by previous_day1 timing? (scripts/diag/om_day1_tilt.py)\n",
         "Verdict rule pre-registered in the docstring (commit 1c76008) before any number. Fit 2024-25, judged 2025-26, "
         "Nov–Apr, strict SNOTEL/BC, mid tier, water, 90% 7-day-block bootstrap.\n",
         f"Timing (om_prev_timing.py, Test A): " + ", ".join(f"{m} {v}" for m, v in tv.items()) + "\n",
         "## Part 1: arithmetic under H_step (mid-January standard time; uniform over hours)\n"]
    part1 = {}
    L.append("| time zone | model cycle | share from runs issued ≥ local day start | newest run, h before start (negative = after) | weighted mean run age at start, h | "
             + " | ".join(f"share newer than {c}" for c in ct) + " |")
    L.append("|---|---|---|---|---|" + "---|" * len(ct))
    for z in zones:
        for cyc in sorted({6, gem_cycle}):
            s = shares(z, cyc, ct)
            part1[f"{z}|{cyc}"] = s
            L.append(f"| {z} | {cyc} h | {s['after_day_start']:.3f} | {s['newest_init_h_before_start']:.0f} | {s['weighted_mean_init_h_before_start']:.1f} | "
                     + " | ".join(f"{s['newer_than ' + c]:.3f}" for c in ct) + " |")
    max_after = max(v["after_day_start"] for v in part1.values()) if part1 else None
    L.append(f"\nComparator run, h before local day start (MST / PST): " + "; ".join(
        f"{c} {(datetime.combine(date(2026,1,15), datetime.min.time(), ZoneInfo('America/Denver')).astimezone(timezone.utc) - f(datetime.combine(date(2026,1,15), datetime.min.time(), ZoneInfo('America/Denver')).astimezone(timezone.utc), ZoneInfo('America/Denver'))).total_seconds()/3600:.0f} / "
        f"{(datetime.combine(date(2026,1,15), datetime.min.time(), ZoneInfo('America/Los_Angeles')).astimezone(timezone.utc) - f(datetime.combine(date(2026,1,15), datetime.min.time(), ZoneInfo('America/Los_Angeles')).astimezone(timezone.utc), ZoneInfo('America/Los_Angeles'))).total_seconds()/3600:.0f}"
        for c, f in ct.items()) + "\n")
    L.append("## Part 2: v1 built from previous_day2 (tilted against v1) vs each comparator at lead 1, same resort-days\n")
    L.append("| comparator | ≥ mm | test days | events | resorts | v1@1 | v1@2 | X@1 | v1@2 − X@1 (90%) | v1@1 − X@1 (90%) | v1@1 − v1@2 (90%) |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    res = {"timing": tv, "part1": part1, "part2": {}, "answer": {}}
    for comp in COMPARATORS:
        rng = np.random.default_rng(SEED)
        named, ntr, leak = frames(con, pairs, comp)
        if leak:
            raise SystemExit(f"{comp}: {leak} rows issued at/after the local day start: leakage, aborting")
        xn = f"{comp}@1"
        if named[xn].empty or not ntr:
            res["part2"][comp] = {"error": "no common days"}
            L.append(f"| {comp} | – | 0 | – | – | – | – | – | NO DATA | | |")
            res["answer"][comp] = "UNKNOWABLE (no common days)"
            continue
        t = N.table(named, (1,), rng, [("v1@2", xn), ("v1@1", xn), ("v1@1", "v1@2")])
        for thr in N.THR:
            r = t["thr"][str(thr)]
            d = r["diff"]
            L.append(f"| {comp} | {thr:g} | {t['days']} | {r['events']} | {t['resorts']} | {r['csi']['v1@1']:.3f} | {r['csi']['v1@2']:.3f} | "
                     f"{r['csi'][xn]:.3f} | " + " | ".join(f"{d[k]['d']:+.3f} ({d[k]['p05']:+.3f} to {d[k]['p95']:+.3f})"
                                                        for k in (f"v1@2 - {xn}", f"v1@1 - {xn}", "v1@1 - v1@2")) + " |")
        r10 = t["thr"]["10.0"]
        verdict = call(r10["diff"][f"v1@2 - {xn}"], r10["events"], t["resorts"])
        res["part2"][comp] = {"table": t, "verdict": verdict, "train_days": ntr}
        if (all_step and max_after is not None and max_after < 0.05) or verdict == "v1 lead robust":
            ans = "REAL"
        elif any_late and verdict == "X beats stale v1":
            ans = "PARTLY AN ARTIFACT"
        else:
            ans = "UNKNOWABLE"
        res["answer"][comp] = ans
    L.append("")
    for comp in COMPARATORS:
        p2 = res["part2"][comp]
        L.append(f"- **{comp}**: Part 2 {p2.get('verdict', 'NO DATA')} (train days {p2.get('train_days', 0)}); answer **{res['answer'][comp]}**")
    L.insert(3, "\n## Answer\n\n" + "\n".join(f"- {c}: **{a}**" for c, a in res["answer"].items()) +
             f"\n\nMax share of a scored day from runs issued at/after the local day start (H_step arithmetic): "
             f"{'n/a' if max_after is None else f'{max_after:.3f}'}.\n")
    text = "\n".join(L) + "\n"
    (out / "om_day1_tilt.md").write_text(text)
    (out / "om_day1_tilt.json").write_text(json.dumps(res, default=float, indent=1))
    print(text)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
