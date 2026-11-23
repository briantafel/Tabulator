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
    """Same rule as sketch.latest_nbm_snow: the newest cycle (00z/12z; all four with flags.json terrain.freshCycle) whose 6 h snow is posted out to `hours`."""
    for cycle in nbm.candidate_cycles(now, nbm.six_hourly_map_enabled()):
        leads = nbm.list_leads(cycle)
        if all(l in leads for l in range(6, hours + 1, 6)):
            return cycle
    return None


def newest_ifs(now):
    """Same first guess as sketch.latest_ifs_snow: ECMWF open data is up ~8 h after the cycle."""
    return floor12(now - timedelta(hours=8))


def is_ifs(entry):
    return "IFS" in (entry.get("label") or "")


def plan(index, now, nbm_cycle, ifs_cycle, only=None, force=False, batch=6, anchored=(), app_ids=None):
    """(due ids, batches). app_ids: resorts that have a sheet in the app. A map for any other resort (archive-only) is
    not drawn by the refresh unless named in `only`: nothing in the app shows it, and it was 46% of every run."""
    due = []
    for rid, e in index.items():
        if not isinstance(e, dict) or (only and rid not in only):
            continue
        if app_ids is not None and not only and rid not in app_ids:
            continue
        newest = ifs_cycle if is_ifs(e) else nbm_cycle
        run = datetime.fromisoformat(e["run"]) if e.get("run") else None
        # an anchored map (anchor.py) follows the blend, not only the NBM cycle: redrawn every refresh (~2-3 min with a
        # cached relief), so a new blend run, or the sheet's days rolling over, never leaves it showing another total
        if force or rid in anchored or run is None or (newest is not None and run < newest):
            due.append(rid)
    due.sort()
    # interleave so a batch is not 6 big-DEM Alpine resorts in a row
    batches = [" ".join(due[i::max(1, -(-len(due) // batch))]) for i in range(max(1, -(-len(due) // batch)))] if due else []
    return due, [b for b in batches if b]


def plan_waves(index, now, nbm_cycle, ifs_cycle, only=None, force=False, batch=6, anchored=(), app_ids=None):
    """Two waves so an anchored map (it must equal the sheet's total, so it is HIDDEN until redrawn) is not kept
    waiting behind the rest. Wave 1 = the due anchored resorts, one per job; wave 2 = everything else due.
    Returns (first batches, rest batches, due ids)."""
    due, _ = plan(index, now, nbm_cycle, ifs_cycle, only, force, batch, anchored, app_ids)
    first = [r for r in due if r in set(anchored)]
    rest = [r for r in due if r not in set(anchored)]
    sub = lambda ids, n: [b for b in (" ".join(ids[i::max(1, -(-len(ids) // n))]) for i in range(max(1, -(-len(ids) // n)))) if b] if ids else []  # noqa: E731
    return list(first), sub(rest, batch), due


def app_resorts(root=None):
    """Ids of the resorts the app shows (src/data/resorts.json, not archiveOnly)."""
    root = Path(root) if root else Path(__file__).resolve().parents[2]
    return {r["id"] for r in json.loads((root / "src/data/resorts.json").read_text())["resorts"] if not r.get("archiveOnly")}


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
    anchored = set(os.environ.get("ANCHOR_RESORTS", "").split())
    first, rest, due = plan_waves(index, now, cyc, newest_ifs(now), a.only, a.force, a.batch, anchored, app_resorts())
    print(f"newest NBM cycle {cyc:%Y-%m-%d %HZ}; newest IFS cycle {newest_ifs(now):%Y-%m-%d %HZ}; {len(due)} of "
          f"{sum(isinstance(v, dict) for v in index.values())} maps are due (archive-only resorts are not drawn): "
          f"{len(first)} anchored first, {len(rest)} batches after")
    for b in first:
        print("  first:", b)
    for b in rest:
        print("  batch:", b)
    out = {"matrix_first": json.dumps(first), "count_first": str(len(first)), "matrix_rest": json.dumps(rest),
           "count_rest": str(sum(len(b.split()) for b in rest)), "count": str(len(due)), "cycle": cyc.isoformat()}
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            for k, v in out.items():
                f.write(f"{k}={v}\n")
    else:
        print(out)


if __name__ == "__main__":
    main()
