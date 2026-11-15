#!/usr/bin/env python3
"""Copy the judged temperature model into the app — promoted parts only.

    python3 scripts/model/promote_temps.py <verify out/temp-model.json> public/temp-model.json

temps.py fits on 2024-25 and judges on 2025-26 (public models + SNOTEL only;
nothing paid in it). For every var (hi / lo / lift) × lead it sets
promote[var][lead] = True only when ours beat the equal blend, the uncorrected
blend and the best single model with the whole 90% range below zero.

The app (scripts/temps/lib.js) already skips a correction that isn't promoted.
This script also drops the WEIGHTS of unpromoted leads, so those leads fall
back to equal weights — exactly what the app showed before. A var with no
promoted lead ships no bias table. Prints what shipped; refuses an unjudged file.
"""
import json
import sys
from pathlib import Path

VARS = ("hi", "lo", "lift")
TABLE = {"hi": "high_bias", "lo": "low_bias", "lift": "lift_bias"}


def main(src: Path, dst: Path) -> None:
    m = json.loads(src.read_text())
    if "promote" not in m or not m.get("weights"):
        raise SystemExit(f"{src}: no promote/weights — not a judged temps model")
    out = {k: m[k] for k in ("version", "units", "fitted_on", "models", "elevation", "correction", "caveat_lows")
           if k in m}
    out["promote"] = {v: {l: bool(x) for l, x in m["promote"].get(v, {}).items()} for v in VARS}
    out["weights"] = {v: {l: ws for l, ws in m["weights"].get(v, {}).items() if out["promote"][v].get(l)}
                      for v in VARS}
    lines = []
    for v in VARS:
        leads = sorted(int(l) for l, x in out["promote"][v].items() if x)
        if leads and TABLE[v] in m:
            out[TABLE[v]] = m[TABLE[v]]
        lines.append(f"{v}: promoted leads {leads or 'none'}")
    if not any(out["promote"][v].get(l) for v in VARS for l in out["promote"][v]):
        print("temps promote: NOTHING promoted — the app keeps equal weights, no corrections", file=sys.stderr)
    dst.write_text(json.dumps(out, indent=1) + "\n")
    print(f"temps promote ({out.get('version')}): " + "; ".join(lines), file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
