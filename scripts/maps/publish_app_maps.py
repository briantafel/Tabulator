#!/usr/bin/env python3
"""Put finished terrain_pilot --app renders into the app: public/terrain/<id>-*.{webp,svg} and public/terrain/index.json.

    publish_app_maps.py <release-tag> <id> [<id> ...]

Downloads each resort's files from the GitHub Release with `gh api` (the REST asset route; `gh release download` uses GraphQL, which
this environment blocks), runs app_vectors.py on them, and replaces the resort's entry in index.json. A resort whose files are
missing or whose JSON lacks the app block is skipped LOUDLY (exit 1 at the end); nothing half-written is published.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "terrain"
NEED = ["{id}.json", "{id}-relief.png", "{id}-vectors.svg", "{id}-sheet.webp", "{id}-sheet-baked.webp"]


def gh(*a):
    return subprocess.run(["gh", "api", *a], capture_output=True, check=True).stdout


def fetch(tag, ids, d):
    assets = json.loads(gh(f"repos/briantafel/Tabulator/releases/tags/{tag}", "--jq", "[.assets[]|{id,name}]"))
    by = {a["name"]: a["id"] for a in assets}
    for rid in ids:
        for n in NEED:
            n = n.format(id=rid)
            if n not in by:
                raise FileNotFoundError(f"{n} is not in release {tag}")
            (d / n).write_bytes(gh("-H", "Accept: application/octet-stream", f"repos/briantafel/Tabulator/releases/assets/{by[n]}"))


def entry(rid, d):
    j = json.loads((d / f"{rid}.json").read_text())
    a = j.get("app")
    if not a:
        raise ValueError(f"{rid}.json has no app block (was the run made with app=true?)")
    return {
        "img": f"terrain/{rid}-sheet-baked.webp", "run": j["snow"]["run"], "label": "NOAA NBM" if j.get("nosnow") else j["caption_source"],
        "base_in": None if j.get("nosnow") else j["base"][1], "top_in": None if j.get("nosnow") else j["top"][1],
        **({"nosnow": True} if j.get("nosnow") else {}),
        "base_ft": round(j["base"][0] * 3.28084), "top_ft": round(j["top"][0] * 3.28084),
        "img_clean": f"terrain/{rid}-sheet.webp", "range_in": j["inside_range_in"], "labels": a["sheet"]["labels"],
        "full": {"img": f"terrain/{rid}-full.webp", "fill": f"terrain/{rid}-full-fill.svg", "lines": f"terrain/{rid}-full-lines.svg",
                 "px": a["full"]["px"], "ref": a["full"]["ref"], "focus": a["full"]["focus"], "labels": a["full"]["labels"]},
    }


def main(tag, ids):
    idx_p = OUT / "index.json"
    idx = json.loads(idx_p.read_text())
    bad = []
    for rid in ids:
        with tempfile.TemporaryDirectory() as t:
            d = Path(t)
            try:
                fetch(tag, [rid], d)
                e = entry(rid, d)
                subprocess.run([sys.executable, str(Path(__file__).with_name("app_vectors.py")), str(d), rid], check=True)
                for n in (f"{rid}-full.webp", f"{rid}-full-fill.svg", f"{rid}-full-lines.svg", f"{rid}-sheet.webp", f"{rid}-sheet-baked.webp"):
                    shutil.copy(d / n, OUT / n)
                idx[rid] = e
                print(f"published {rid}: {e['label']}, run {e['run']}, range {e['range_in']}")
            except Exception as ex:  # noqa: BLE001
                print(f"SKIPPED {rid}: {ex}", file=sys.stderr)
                bad.append(rid)
    idx_p.write_text(json.dumps(idx, indent=1))
    if bad:
        sys.exit(f"{len(bad)} skipped: {' '.join(bad)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
