#!/usr/bin/env python3
"""Terrain pilot: assemble the small preview set from the per-resort artifacts.

  python3 pilot_publish.py PREVIEWS_DIR SITE_DIR TAG REPO RESORT [RESORT ...]

PREVIEWS_DIR holds one folder per resort (preview-<id>/ with <id>.json, preview/<id>-1024.png, preview/<id>-crop1to1.png,
FAILED.txt on failure). Writes to SITE_DIR (becomes the orphan branch `terrain-pilot`):
  <id>-1024.png, <id>-crop1to1.png, <id>.json, <id>-FAILED.txt, contact-sheet.png, summary.md, summary.json
Prints the summary table. Exits 1 if any resort failed or is missing (after writing everything it has).
"""
import json, shutil, sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

prev, site, tag, repo, *ids = sys.argv[1:]
prev, site = Path(prev), Path(site)
site.mkdir(parents=True, exist_ok=True)


def find(rid, rel):
    for base in (prev / f"preview-{rid}", prev / rid, prev):
        p = base / rel
        if p.exists():
            return p
    return None


def font(sz):
    for f in ("/usr/share/fonts/truetype/inter/Inter-SemiBold.ttf", "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, sz)
    return ImageFont.load_default()


rows, failed, tiles = [], [], []
for rid in ids:
    j = find(rid, f"{rid}.json")
    fl = find(rid, "FAILED.txt")
    img = find(rid, f"preview/{rid}-1024.png")
    crop = find(rid, f"preview/{rid}-crop1to1.png")
    if fl:
        shutil.copy(fl, site / f"{rid}-FAILED.txt")
    if not (j and img):
        reason = (fl.read_text().splitlines()[0] if fl else f"{rid}: no output (job cancelled or died before writing anything)")
        failed.append((rid, reason))
        tiles.append((rid, None, "FAILED"))
        continue
    d = json.loads(j.read_text())
    shutil.copy(j, site / f"{rid}.json")
    shutil.copy(img, site / f"{rid}-1024.png")
    if crop:
        shutil.copy(crop, site / f"{rid}-crop1to1.png")
    rc = find(rid, f"preview/{rid}-relief-crop1to1.png")
    if rc:
        shutil.copy(rc, site / f"{rid}-relief-crop1to1.png")
    dem, snow, rel, bl = d["dem"], d["snow"], d["relief"], d["blender"]
    rows.append({
        "resort": rid, "dem": f"{dem['source']}, native {dem['native_res_m'][0]} x {dem['native_res_m'][1]} m (heightmap {dem['heightmap_spacing_m']} m)",
        "snow": f"{snow['source']} {snow['run'][:13].replace('T', ' ')}Z" + (f" ({snow['grid']})" if snow["source"] == "IFS" else ""),
        "frame_km": d["frame_km"], "m_per_px": d["m_per_px"], "clipped_pct": rel["clipped_pct"], "darkest1_pct": rel["darkest1pct_grey_pct"],
        "blend_mb": bl.get("blend_mb"), "render_min": round(bl.get("render_s", 0) / 60, 1), "total_min": round(d["timing_s"]["total_s"] / 60, 1),
        "caption": d["caption_source"], "nbm_check": snow.get("nbm_check"), "slr": snow.get("slr")})
    tiles.append((rid, Image.open(img).convert("RGB"), snow["source"] + " " + snow["run"][:10]))

# contact sheet
cols = 3
n = len(tiles)
rws = (n + cols - 1) // cols
cell, cap = 1024, 64
sheet = Image.new("RGB", (cols * cell, rws * (cell + cap)), "white")
dr = ImageDraw.Draw(sheet)
for i, (rid, im, note) in enumerate(tiles):
    x, y = (i % cols) * cell, (i // cols) * (cell + cap)
    if im is not None:
        sheet.paste(im, (x, y + cap))
    else:
        dr.rectangle([x + 40, y + cap + 40, x + cell - 40, y + cap + cell - 40], outline="#d33", width=6)
        dr.text((x + 80, y + cap + 80), "FAILED", fill="#d33", font=font(90))
    dr.text((x + 24, y + 12), rid, fill="#222", font=font(34))
    dr.text((x + 360, y + 20), note, fill="#666", font=font(24))
sheet.save(site / "contact-sheet.png", optimize=True)

link = f"https://github.com/{repo}/releases/tag/{tag}"
md = [f"# Terrain pilot — {tag}", "", f"Full files (4K PNG, SVG, .blend, JSON): {link}", "",
      "| resort | DEM source & resolution | snow source & run | frame km | m/px | clipped % | darkest 1% | .blend MB | render |",
      "|---|---|---|---|---|---|---|---|---|"]
for r in rows:
    md.append(f"| {r['resort']} | {r['dem']} | {r['snow']} | {r['frame_km']} | {r['m_per_px']} | {r['clipped_pct']} | {r['darkest1_pct']}% grey | "
              f"{r['blend_mb']} | {r['render_min']} min (job {r['total_min']} min) |")
md += ["", "Caption source by resort: " + "; ".join(f"{r['resort']}: {r['caption']}" for r in rows)]
if failed:
    md += ["", "## Failed", ""] + [f"- **{rid}**: {why}" for rid, why in failed]
(site / "summary.md").write_text("\n".join(md) + "\n")
(site / "summary.json").write_text(json.dumps({"tag": tag, "release": link, "rows": rows, "failed": failed}, indent=1))
print("\n".join(md))
sys.exit(1 if failed else 0)
