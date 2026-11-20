#!/usr/bin/env python3
"""Stage finished terrain_pilot renders for Brian's folder "3D Resort Screens" (one folder per resort, the .blend in its own subfolder).

    stage_for_device.py <release-tag> <id> [<id> ...]     -> /mnt/user-data/outputs/<Resort Name>/..., prints the device_commit_files list

Files per resort: <id>.png (4K map), <id>-relief.png (plaster relief only), <id>-vectors.svg (the vector layers),
and "<Resort Name> Blender/<id>.blend". The editable master <id>.svg (relief embedded, 30 MB+) is left on the Release: over the 25 MB commit cap.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEV = "/Users/brian/Downloads/tabulator/3D Resort Screens"
OUT = Path("/mnt/user-data/outputs")
CAP = 25 * 1024 * 1024


def main(tag, ids):
    names = {r["id"]: r["name"] for r in json.loads((ROOT / "src/data/resorts.json").read_text())["resorts"]}
    assets = json.loads(subprocess.run(["gh", "api", f"repos/briantafel/Tabulator/releases/tags/{tag}", "--jq", "[.assets[]|{id,name}]"],
                                       capture_output=True, check=True).stdout)
    by = {a["name"]: a["id"] for a in assets}
    files, skipped = [], []
    for rid in ids:
        nm = names.get(rid, rid)
        plan = [(f"{rid}.png", f"{nm}/{rid}.png"), (f"{rid}-relief.png", f"{nm}/{rid}-relief.png"),
                (f"{rid}-vectors.svg", f"{nm}/{rid}-vectors.svg"), (f"{rid}.blend", f"{nm}/{nm} Blender/{rid}.blend")]
        for asset, rel in plan:
            if asset not in by:
                skipped.append(f"{rid}: {asset} not on the release")
                continue
            dst = OUT / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(subprocess.run(["gh", "api", "-H", "Accept: application/octet-stream",
                                            f"repos/briantafel/Tabulator/releases/assets/{by[asset]}"], capture_output=True, check=True).stdout)
            if dst.stat().st_size > CAP:
                skipped.append(f"{rid}: {asset} is {dst.stat().st_size / 1e6:.0f} MB (over the 25 MB cap)")
                continue
            files.append({"stagedPath": str(dst), "devicePath": f"{DEV}/{rel}"})
    print(json.dumps(files))
    for s in skipped:
        print("SKIPPED", s, file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
