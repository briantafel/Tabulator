"""Is the live Open-Meteo Previous Runs archive current?  (added 2026-11-23, plan-near-term-models step 0)

The nightly backfill (backfill.yml) fetches this season's Previous Runs for every app resort and model, one week
a piece. When it runs out of time it used to stop quietly: the run could end green with whole models a day or two
behind, and the blend's training/scoring rows (leads 1-7) silently ended on 2026-11-20 for some resorts.

This reads the archive's live rows (run_id bf-om-live-*) and answers, per model and per resort: what is the last
valid day we hold? After a finished backfill run every resort x model must reach YESTERDAY (UTC): Open-Meteo has the
previous runs for yesterday by the time the nightly run starts. A resort x model that is one or more days behind,
or a model missing for a resort, is a PROBLEM and the script exits 1. Read-only.

    python3 scripts/archive/previous_runs_freshness.py <archive dir> [--today YYYY-MM-DD] [--max-lag 0]

<archive dir> holds the downloaded parquet (aws s3 sync s3://BUCKET/archive/ ... --include
"source=open-meteo-previous-runs/*"). Prints a markdown report; also appends it to $GITHUB_STEP_SUMMARY.
"""
import argparse
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import duckdb

MODELS = ("ecmwf_ifs025", "gfs_seamless", "gem_seamless")
LIVE_RUN_PREFIX = "bf-om-live-"


def load(archive_dir):
    files = sorted(str(p) for p in Path(archive_dir).rglob("*.parquet") if "source=open-meteo-previous-runs" in str(p))
    if not files:
        raise SystemExit(f"no open-meteo-previous-runs parquet under {archive_dir}: wrong folder, or nothing synced")
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    flist = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
    con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet({flist}, union_by_name = true, hive_partitioning = false)")
    return con, len(files)


def check(con, today, max_lag=0, models=MODELS):
    """Returns (last_day {(resort, model): date}, per_day {(day, model): n_resorts}, problems [str]).
    Lead 1 precipitation only: the series the blend and the scoring read."""
    expect = today - timedelta(days=1)
    q = f"""
      SELECT resort_id, model, CAST(max(valid_start) AS DATE) AS last_day, max(fetched_at) AS fetched
      FROM raw
      WHERE run_id LIKE '{LIVE_RUN_PREFIX}%' AND variable = 'precip' AND period_label = 'previous_day1'
      GROUP BY resort_id, model"""
    last = {(r[0], r[1]): (r[2], r[3]) for r in con.execute(q).fetchall()}
    per_day = {(r[0], r[1]): r[2] for r in con.execute(f"""
      SELECT CAST(valid_start AS DATE) AS d, model, count(DISTINCT resort_id)
      FROM raw
      WHERE run_id LIKE '{LIVE_RUN_PREFIX}%' AND variable = 'precip' AND period_label = 'previous_day1'
      GROUP BY ALL""").fetchall()}
    problems = []
    resorts = sorted({k[0] for k in last})
    if not resorts:
        problems.append("no live rows at all (run_id bf-om-live-*)")
    for r in resorts:
        for m in models:
            if (r, m) not in last:
                problems.append(f"{r} / {m}: no live rows")
                continue
            lag = (expect - last[(r, m)][0]).days
            if lag > max_lag:
                problems.append(f"{r} / {m}: last valid day {last[(r, m)][0]} is {lag} day(s) behind {expect}")
    return last, per_day, problems


def report(last, per_day, problems, today, n_files):
    expect = today - timedelta(days=1)
    resorts = sorted({k[0] for k in last})
    out = [f"## Previous Runs freshness, checked {today} (every resort x model should reach {expect})", "",
           f"{n_files} parquet files, {len(resorts)} resorts with live rows.", ""]
    days = sorted({d for d, _ in per_day})[-10:]
    out += ["Resorts that hold lead-1 precipitation for each day:", "",
            "| day | " + " | ".join(MODELS) + " |", "|---|" + "---:|" * len(MODELS)]
    for d in days:
        out.append(f"| {d} | " + " | ".join(str(per_day.get((d, m), 0)) for m in MODELS) + " |")
    out += ["", "Last day held, by model:", "", "| model | resorts | earliest last day | latest last day | behind expected |", "|---|---:|---|---|---:|"]
    for m in MODELS:
        ds = [v[0] for (r, mm), v in last.items() if mm == m]
        if ds:
            out.append(f"| {m} | {len(ds)} | {min(ds)} | {max(ds)} | {sum(1 for d in ds if d < expect)} |")
        else:
            out.append(f"| {m} | 0 | - | - | - |")
    out += ["", f"**{len(problems)} problem(s)**" + (":" if problems else "")]
    out += [f"- {p}" for p in problems[:60]]
    if len(problems) > 60:
        out.append(f"- ... and {len(problems) - 60} more")
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("archive")
    ap.add_argument("--today", default=None, help="UTC date to judge against (default: today)")
    ap.add_argument("--max-lag", type=int, default=0, help="days behind yesterday that still pass (default 0)")
    a = ap.parse_args(argv)
    today = date.fromisoformat(a.today) if a.today else date.today()
    con, n = load(a.archive)
    last, per_day, problems = check(con, today, a.max_lag)
    text = report(last, per_day, problems, today, n)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text)
    if problems:
        print(f"::error::Previous Runs archive is behind: {len(problems)} resort x model piece(s). See the table above.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
