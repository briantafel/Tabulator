#!/usr/bin/env python3
"""Publish step of terrain-refresh.yml: fold freshly built maps into the live terrain folder.

    refresh_publish.py LIVE_DIR STAGE_DIR [--also OTHER_TERRAIN_DIR]

--also folds in maps that OTHER (public/terrain on main) has and LIVE lacks or has older, so a map published by hand to
main is never lost when the site starts serving terrain-live.

LIVE_DIR holds the current maps + index.json (the `terrain-live` branch checkout, or public/terrain the first time).
STAGE_DIR holds one folder per rebuilt resort (<id>/<id>.json + the five public files, from the render jobs' artifacts,
at any depth). A resort replaces its old entry only if its files are all present and its run is not OLDER than what is
live. Anything else is skipped LOUDLY and the exit code is 1 at the end; nothing half-written is ever published.
"""
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from publish_app_maps import entry  # noqa: E402

FILES = ["{id}-full.webp", "{id}-full-fill.svg", "{id}-full-lines.svg", "{id}-sheet.webp", "{id}-sheet-baked.webp"]
LIVE_FILES = ["{id}-grid.png", "{id}-days.png", "{id}-full-static.svg", "{id}-sheet-relief.webp"]   # maps drawn by the app


def files_for(rid, e):
    return [n.format(id=rid) for n in FILES + (LIVE_FILES if e.get("live") else [])]


def publish(live, stage):
    live, stage = Path(live), Path(stage)
    idx_p = live / "index.json"
    idx = json.loads(idx_p.read_text())
    done, bad = [], []
    for j in sorted(stage.rglob("*.json")):
        rid = j.stem
        d = j.parent
        if d.name != rid:
            continue
        try:
            e = entry(rid, d)
            names = files_for(rid, e)
            missing = [n for n in names if not (d / n).exists() or (d / n).stat().st_size == 0]
            if missing:
                raise FileNotFoundError(f"missing or empty: {', '.join(missing)}")
            old = (idx.get(rid) or {}).get("run")
            if old and e["run"] < old:
                raise ValueError(f"built from run {e['run']}, older than the live {old}: keeping the live map")
            for n in names:
                shutil.copy(d / n, live / n)
            idx[rid] = e
            done.append(rid)
            print(f"published {rid}: {e['label']}, run {e['run']}, range {e['range_in']}")
        except Exception as ex:  # noqa: BLE001
            print(f"SKIPPED {rid}: {ex}", file=sys.stderr)
            bad.append(rid)
    idx["_refreshed"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    idx_p.write_text(json.dumps(idx, indent=1))
    return done, bad


def fold_in(live, other):
    """Maps OTHER has that LIVE lacks or has older (by run)."""
    live, other = Path(live), Path(other)
    li, oi = json.loads((live / "index.json").read_text()), json.loads((other / "index.json").read_text())
    got = []
    for rid, e in oi.items():
        if not isinstance(e, dict) or not e.get("run"):
            continue
        cur = li.get(rid) if isinstance(li.get(rid), dict) else None
        if cur and cur.get("run") and cur["run"] >= e["run"]:
            continue
        names = files_for(rid, e)
        if not all((other / n).exists() for n in names):
            print(f"NOT folded in: {rid} (files missing in {other})", file=sys.stderr)
            continue
        for n in names:
            shutil.copy(other / n, live / n)
        li[rid] = e
        got.append(rid)
    (live / "index.json").write_text(json.dumps(li, indent=1))
    return got


if __name__ == "__main__":
    args = sys.argv[1:]
    also = None
    if "--also" in args:
        i = args.index("--also")
        also = args[i + 1]
        del args[i:i + 2]
    if also:
        print(f"folded in from {also}: {fold_in(args[0], also) or 'nothing'}")
    done, bad = publish(args[0], args[1])
    print(f"{len(done)} published, {len(bad)} skipped")
    if bad:
        sys.exit(f"{len(bad)} skipped: {' '.join(bad)}")
