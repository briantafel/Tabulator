"""Per-day snow grids for the app-drawn terrain map (Brian 2026-11-22: the map must match the sheet's total for ANY
window the sheet shows: the forecast, a trip, a day picked on the wheel).

The map's snow at a point, for a window W of local days, is

    field_W(x) = k_W * blur( max(0, sum_d A_d(x) + (sum_d G_d(x)) * H(x)) )

  A_d  inches, day d's NBM snow with the terrain step's height term taken out (base - gradient x cell height / 1000)
  G_d  inches per 1000 ft, day d's local snow-vs-height gradient (>= 0)
  H    the terrain, thousands of feet (10 m DEM)
  k_W  sheet total over W / the same field at the blend's own point and height (anchor.py): the map's AMOUNT is the
       sheet's, NBM supplies only the PATTERN

A_d and G_d are smooth (they come from 2.5 km NBM cells), so they ship on a coarse grid; H and the skiable outline
ship once on a fine grid. The app (src/lib/terrainField.js) rebuilds the field with the same arithmetic, so the map
and the sheet can never disagree, whatever window is open. Everything is in the full-screen picture's pixels
(render px, 0..W across, 0..H down); a cell's value is at its centre.

Files (8-bit RGB PNG, no colour profile, so a browser canvas reads the bytes back unchanged):
  <id>-grid.png  fine grid, `cell` px:  R = H quantised to 8 bits over [hq0, hq1], G = 255 inside the outline
  <id>-days.png  coarse grid, `ccell` px, 2 bands per day stacked downwards (A_d, then G_d), each 16 bits
                 (R high byte, G low byte) over that band's own [lo, hi]
"""
from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

CELL = 4        # fine grid: 4 render px (~16 m at Jackson): H and the outline
CCELL = 32      # coarse grid: 32 render px (~125 m): the per-day NBM parts, which vary over 2.5 km
VERSION = 1


def centres(n, cell):
    return (np.arange(n) + 0.5) * cell


def q8(a, lo, hi):
    return np.round((a - lo) / (hi - lo if hi > lo else 1.0) * 255).clip(0, 255).astype("uint8")


def q16(a, lo, hi):
    return np.round((a - lo) / (hi - lo if hi > lo else 1.0) * 65535).clip(0, 65535).astype("uint16")


def dq8(q, lo, hi):
    return lo + q.astype("float64") / 255 * (hi - lo)


def dq16(q, lo, hi):
    return lo + q.astype("float64") / 65535 * (hi - lo)


def png(rgb):
    b = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(b, "PNG", optimize=True)
    return b.getvalue()


def pack(H_kft, mask, A, G):
    """H_kft, mask: (gh, gw); A, G: lists of (ch, cw), one per day. Returns (grid png bytes, days png bytes, meta)."""
    gh, gw = H_kft.shape
    if not np.isfinite(H_kft).all():
        raise SystemExit("live grid: terrain has missing values; refusing")
    hq0, hq1 = float(H_kft.min()), float(H_kft.max())
    grid = np.zeros((gh, gw, 3), "uint8")
    grid[..., 0] = q8(H_kft, hq0, hq1)
    grid[..., 1] = np.where(mask, 255, 0)
    bands, q = [], []
    for a, g in zip(A, G):
        if not (np.isfinite(a).all() and np.isfinite(g).all()):
            raise SystemExit("live grid: a day's snow parts have missing values; refusing (missing is not zero)")
        row = []
        for band in (a, g):
            lo, hi = float(band.min()), float(band.max())
            v = q16(band, lo, hi)
            rgb = np.zeros(band.shape + (3,), "uint8")
            rgb[..., 0], rgb[..., 1] = v >> 8, v & 255
            bands.append(rgb)
            row += [lo, hi]
        q.append([round(x, 6) for x in row])
    days = np.concatenate(bands, 0)
    return png(grid), png(days), {"hq": [round(hq0, 6), round(hq1, 6)], "q": q}


def unpack(grid_png, days_png, meta, ndays):
    """The inverse, as the app reads it (tests and the CI parity check)."""
    g = np.asarray(Image.open(io.BytesIO(grid_png)).convert("RGB"))
    H = dq8(g[..., 0], *meta["hq"])
    mask = g[..., 1] > 127
    d = np.asarray(Image.open(io.BytesIO(days_png)).convert("RGB")).astype("uint32")
    ch = d.shape[0] // (2 * ndays)
    A, G = [], []
    for i in range(ndays):
        lo_a, hi_a, lo_g, hi_g = meta["q"][i]
        ba = d[2 * i * ch:(2 * i + 1) * ch]
        bg = d[(2 * i + 1) * ch:(2 * i + 2) * ch]
        A.append(dq16((ba[..., 0] << 8) | ba[..., 1], lo_a, hi_a))
        G.append(dq16((bg[..., 0] << 8) | bg[..., 1], lo_g, hi_g))
    return H, mask, A, G


def bilinear_up(c, gw, gh, cell=CELL, ccell=CCELL):
    """Coarse (cell centres every ccell px) -> fine (centres every cell px), edges clamped. Same rule as the app."""
    ch, cw = c.shape
    u = np.clip(centres(gw, cell) / ccell - 0.5, 0, cw - 1)
    v = np.clip(centres(gh, cell) / ccell - 0.5, 0, ch - 1)
    u0, v0 = np.minimum(np.floor(u).astype(int), cw - 2 if cw > 1 else 0), np.minimum(np.floor(v).astype(int), ch - 2 if ch > 1 else 0)
    fu, fv = (u - u0)[None, :], (v - v0)[:, None]
    u1, v1 = np.minimum(u0 + 1, cw - 1), np.minimum(v0 + 1, ch - 1)
    a, b = c[np.ix_(v0, u0)], c[np.ix_(v0, u1)]
    cc, d = c[np.ix_(v1, u0)], c[np.ix_(v1, u1)]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (cc * (1 - fu) + d * fu) * fv


def field(H, A, G, idx, sigma, k):
    """The window's field on the fine grid, exactly as the app computes it (numpy twin of terrainField.js)."""
    from scipy.ndimage import gaussian_filter
    gh, gw = H.shape
    SA = sum(A[i] for i in idx)
    SG = sum(G[i] for i in idx)
    f = np.maximum(0.0, bilinear_up(SA, gw, gh) + bilinear_up(SG, gw, gh) * H)
    return gaussian_filter(f, sigma, mode="reflect", truncate=4.0) * k


def coarse_dims(w, h):
    return math.ceil(w / CCELL), math.ceil(h / CCELL)


def fine_dims(w, h):
    return math.ceil(w / CELL), math.ceil(h / CELL)
