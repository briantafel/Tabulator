#!/usr/bin/env python3
"""Vector layers for the app's full-screen map (Brian 2026-11-20: "computed, not rendered" - outline, lifts,
runs, snow bands and contours must stay sharp at any zoom).

From a terrain_pilot --app run's files (<id>-relief.png, <id>-vectors.svg, <id>.json) this writes, next to them:
  <id>-full.webp        relief only (no snow tint, no lines) cropped to the full-screen picture
  <id>-full-fill.svg    snow bands (the app draws it multiplied over the relief, 85% opacity)
  <id>-full-lines.svg   contours, runs, lifts, outline
Both SVGs use the full-screen picture's pixel coordinates (0..W, 0..H) and are drawn by the app inline, re-rendered at the
zoom the viewer settles on. Paths are simplified to 0.35 px of the 4096 px frame (invisible even at 5x zoom).

    app_vectors.py <dir> <id>
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
ET.register_namespace("inkscape", "http://www.inkscape.org/namespaces/inkscape")
TOL = 0.35


def rdp(pts, tol):
    """Douglas-Peucker on an (n,2) array, iterative; keeps both ends."""
    n = len(pts)
    if n < 3:
        return pts
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        p, q = pts[a], pts[b]
        d = q - p
        L = np.hypot(*d)
        seg = pts[a + 1:b] - p
        dist = np.hypot(seg[:, 0], seg[:, 1]) if L == 0 else np.abs(d[0] * seg[:, 1] - d[1] * seg[:, 0]) / L
        i = int(np.argmax(dist))
        if dist[i] > tol:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return pts[keep]


NUM = re.compile(r"[-+]?\d*\.?\d+(?:e[-+]?\d+)?", re.I)


def simplify_d(d, dx, tol=TOL):
    """Path data made of M / L / Z only: shift x by dx, simplify each subpath."""
    out = []
    for sub in re.split(r"(?=M)", d):
        sub = sub.strip()
        if not sub:
            continue
        closed = sub.rstrip().endswith("Z")
        v = np.array(NUM.findall(sub), dtype=float)
        if len(v) < 4:
            continue
        pts = v.reshape(-1, 2) + [dx, 0]
        if closed and len(pts) > 3 and np.allclose(pts[0], pts[-1]):
            pts = pts[:-1]
        pts = rdp(pts, tol)
        out.append("M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + (" Z" if closed else ""))
    return " ".join(out)


def clean(el, dx):
    for e in el.iter():
        if e.tag == f"{{{NS}}}path" and e.get("d"):
            e.set("d", simplify_d(e.get("d"), dx))
        for k in [k for k in e.attrib if "inkscape" in k]:
            del e.attrib[k]
        if e.tag == f"{{{NS}}}circle":
            e.set("cx", f"{float(e.get('cx')) + dx:.1f}")


def main(d, rid):
    d = Path(d)
    j = json.loads((d / f"{rid}.json").read_text())
    Wc, H = j["app"]["full"]["px"]
    px = j["px"]
    left = int(round(px / 2 - Wc / 2))
    dx = -left
    relief = Image.open(d / f"{rid}-relief.png").convert("RGB")
    relief.crop((left, 0, left + Wc, px)).save(d / f"{rid}-full.webp", "WEBP", quality=82, method=6)
    root = ET.parse(d / f"{rid}-vectors.svg").getroot()
    defs = root.find(f"{{{NS}}}defs")
    groups = {g.get("{http://www.inkscape.org/namespaces/inkscape}label"): g for g in root if g.tag == f"{{{NS}}}g"}

    def write(name, labels, mod=None):
        svg = ET.Element(f"{{{NS}}}svg", {"viewBox": f"0 0 {Wc} {H}"})
        dd = ET.fromstring(ET.tostring(defs))
        # the clip path is the outline: shift it with everything else
        clean(dd, dx)
        svg.append(dd)
        for lb in labels:
            g = ET.fromstring(ET.tostring(groups[lb]))
            clean(g, dx)
            svg.append(g)
        out = d / f"{rid}-full-{name}.svg"
        out.write_bytes(ET.tostring(svg))
        return out.stat().st_size

    a = write("fill", ["snow fill (multiply)"])
    b = write("lines", ["snow lines", "runs", "lifts", "skiable terrain outline (from runs)"])
    print(f"{rid}: full {Wc}x{H} left={left}; fill {a / 1e3:.0f} KB, lines {b / 1e3:.0f} KB (was {sum(len(ET.tostring(g)) for g in groups.values()) / 1e3:.0f} KB)")


if __name__ == "__main__":
    main(*sys.argv[1:3])
