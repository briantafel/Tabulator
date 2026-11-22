#!/usr/bin/env python3
"""Plan step of terrain-refresh.yml: which terrain maps are older than the newest forecast run?

    refresh_plan.py INDEX_JSON [--only id ...] [--force] [--batch 6]

A map is one forecast run (NOAA NBM where it covers the resort, else ECMWF IFS). A resort is DUE when its map's run
is older than the newest complete run of the source it was built from. --force redraws everything listed; --only limits
the list. Writes `matrix` (JSON list of space-separated id batches), `count` and `cycle` to $GITHUB_OUTPUT (or stdout).
Needs only the standard library: the newest-cycle probe reads the NBM bucket listing.
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "archive"))
import nbm  # noqa: E402


def floor12(t):
    t = t.replace(minute=0, second=0, microsecond=0)
    return t.replace(hour=0 if t.hour < 12 else 12)


def newest_nbm(now, hours=120):
    """Same rule as sketch.latest_nbm_snow: the newest 00z/12z cycle whose 6 h snow is posted out to `hours`."""
    for back in range(0, 4):
        cycle = floor12(now - timedelta(hours=3 + 12 * back))
        leads = nbm.list_leads(cycle)
        if all(l in leads for l in range(6, hours + 1, 6)):
            return cycle
    return None


def newest_ifs(now):
    """Same first guess as sketch.latest_ifs_snow: ECMWF open data is up ~8 h after the cycle."""
    return floor12(now - timedelta(hours=8))


def is_ifs(entry):
    return "IFS" in (entry.get("label") or "")


def plan(index, now, nbm_cycle, ifs_cycle, only=None, force=False, batch=6):
    due = []
    for rid, e in index.items():
        if not isinstance(e, dict) or (only and rid not in only):
            continue
        newest = ifs_cycle if is_ifs(e) else nbm_cycle
        run = datetime.fromisoformat(e["run"]) if e.get("run") else None
        if force or run is None or (newest is not None and run < newest):
            due.append(rid)
    due.sort()
    # interleave so a batch is not 6 big-DEM Alpine resorts in a row
    batches = [" ".join(due[i::max(1, -(-len(due) // batch))]) for i in range(max(1, -(-len(due) // batch)))] if due else []
    return due, [b for b in batches if b]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("index")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--batch", type=int, default=6)
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    index = json.loads(Path(a.index).read_text())
    cyc = newest_nbm(now)
    if cyc is None:
        sys.exit("No NBM cycle with 6 h snow out to 120 h in the last two days: refusing to plan (the maps would not move)")
    due, batches = plan(index, now, cyc, newest_ifs(now), a.only, a.force, a.batch)
    print(f"newest NBM cycle {cyc:%Y-%m-%d %HZ}; newest IFS cycle {newest_ifs(now):%Y-%m-%d %HZ}; {len(due)} of "
          f"{sum(isinstance(v, dict) for v in index.values())} maps are due in {len(batches)} batches")
    for b in batches:
        print("  batch:", b)
    out = {"matrix": json.dumps(batches), "count": str(len(due)), "cycle": cyc.isoformat()}
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            for k, v in out.items():
                f.write(f"{k}={v}\n")
    else:
        print(out)


if __name__ == "__main__":
    main()
