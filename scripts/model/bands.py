#!/usr/bin/env python3
"""Bands v1: likely / possible ranges for OUR forecast, from our own past misses.

    python3 scripts/model/bands.py <pairs.parquet> <outDir>

Brian, 2026-11-18: "Will the band be accurate? Can we do range predictions
with our model?" → "Let's try it. Make sure we can revert."

Method (plain, auditable arithmetic — project rule):
1. Re-run blend v1 exactly as fitted on 2024-25 (scripts/model/blend.py) and
   pair every blended forecast with what was measured (SNOTEL / BC liquid,
   strict mid-tier pairs), for 2024-25 ('train') and 2025-26 ('test').
2. Group by days ahead (1–2, 3–4, 5–7) and by forecast size (water, mm).
   For each cell, the band edges are quantiles of what actually fell:
   - forecast < 2.5 mm: absolute amounts (mm), p10 / p25 / p75 / p90;
   - forecast ≥ 2.5 mm: the same quantiles of observed ÷ forecast, so the band
     scales with the forecast inside the cell.
   Dry days pile up at exactly 0: when a band's low edge is 0 it is one-sided
   ([0, p80] possible, [0, p50] likely) so it still means 80% / 50%.
   A cell with fewer than MIN_N training days borrows the all-leads cell.
3. The band shown always contains our own number (as the chart draws it), so
   the judge scores exactly that: likely = [p25, p75], possible = [p10, p90].
4. Judged ONLY on 2025-26: share of days where the measured amount fell inside
   each band, on days where either side is wet (≥ 1 mm) — dry days would flatter
   it — with 90% date-block bootstrap ranges. Promote only if every lead group
   lands within TOL of 50% (likely) and 80% (possible).

Water, not snow: the app turns the band into snow with the SAME ratio and
temperature as our number (scripts/blend/build.js), so band and number agree.
Public models + public truth only; nothing paid. Writes bands.json + bands_report.md.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blend as B  # noqa: E402

GROUPS = {"1-2": (0, 2), "3-4": (3, 4), "5-7": (5, 7)}   # lead 0 (today) uses the 1-2 cells
EDGES = [0.0, 0.5, 2.5, 6.0, 12.0, 25.0]                  # mm water; last bin is open-ended
RATIO_FROM_MM = 2.5
Q = {"p10": 0.10, "p25": 0.25, "p50": 0.50, "p75": 0.75, "p80": 0.80, "p90": 0.90}
MIN_N = 60
WET_MM = 1.0
TARGET = {"likely": 0.50, "possible": 0.80}
TOL = 0.07
N_BOOT = 1000
SEED = 20261118


def group_of(lead: int) -> str:
    for g, (lo, hi) in GROUPS.items():
        if lo <= lead <= hi:
            return g
    return "5-7"


def bin_of(f: float) -> int:
    return int(np.searchsorted(EDGES, f, side="right") - 1)


def cell(fc: np.ndarray, obs: np.ndarray) -> dict:
    """Quantiles for one cell: absolute mm below RATIO_FROM_MM, observed/forecast above."""
    ratio = bool(np.median(fc) >= RATIO_FROM_MM)
    v = obs / fc if ratio else obs
    return {"kind": "ratio" if ratio else "abs", "n": int(len(v)),
            **{k: round(float(np.quantile(v, q)), 3) for k, q in Q.items()}}


def fit_bands(lead: np.ndarray, fc: np.ndarray, obs: np.ndarray) -> dict:
    table: dict = {}
    nb = len(EDGES)
    bins = np.array([bin_of(x) for x in fc])
    pooled = {}
    for b in range(nb):
        m = bins == b
        if m.sum():
            pooled[str(b)] = cell(fc[m], obs[m])
    for g in GROUPS:
        gm = np.array([group_of(int(l)) == g for l in lead])
        table[g] = {}
        for b in range(nb):
            m = gm & (bins == b)
            if m.sum() >= MIN_N:
                table[g][str(b)] = cell(fc[m], obs[m])
            elif str(b) in pooled:
                table[g][str(b)] = {**pooled[str(b)], "borrowed": "all leads"}
    return table


def band_for(table: dict, lead: int, f: float) -> dict | None:
    """The band (mm) for one forecast — the same rule scripts/blend/build.js applies."""
    c = table.get(group_of(lead), {}).get(str(bin_of(f)))
    if c is None:
        return None
    s = f if c["kind"] == "ratio" else 1.0
    q = {k: max(0.0, c[k] * s) for k in Q}
    # Dry days pile up at exactly 0. When the low edge is 0 a central band
    # [p10, p90] would really cover 90% (every dry day counts as inside), so
    # it becomes one-sided: [0, p80] for possible, [0, p50] for likely.
    b = {"p10": q["p10"], "p90": q["p90"] if q["p10"] > 0 else q["p80"],
         "p25": q["p25"], "p75": q["p75"] if q["p25"] > 0 else q["p50"]}
    b["p25"], b["p75"] = min(b["p25"], f), max(b["p75"], f)       # always contains our number
    b["p10"], b["p90"] = min(b["p10"], b["p25"]), max(b["p90"], b["p75"])
    return b


def judge(table: dict, lead, fc, obs, dates) -> list[dict]:
    rng = np.random.default_rng(SEED)
    rows = []
    for g in list(GROUPS) + ["all"]:
        gm = np.ones(len(lead), bool) if g == "all" else np.array([group_of(int(l)) == g for l in lead])
        wet = gm & ((obs >= WET_MM) | (fc >= WET_MM))
        if not wet.any():
            continue
        idx = np.flatnonzero(wet)
        bands = [band_for(table, int(lead[i]), float(fc[i])) for i in idx]
        ok = np.array([b is not None for b in bands])
        idx = idx[ok]; bands = [b for b in bands if b is not None]
        o = obs[idx]
        inl = np.array([b["p25"] <= x <= b["p75"] for b, x in zip(bands, o)])
        inp = np.array([b["p10"] <= x <= b["p90"] for b, x in zip(bands, o)])
        wl = np.mean([b["p75"] - b["p25"] for b in bands]); wp = np.mean([b["p90"] - b["p10"] for b in bands])
        ud, inv = np.unique(dates[idx], return_inverse=True)
        nd = len(ud)
        bi = rng.integers(0, nd, size=(N_BOOT, nd))
        def boot(hit):
            h = np.bincount(inv, hit.astype(float), nd); n = np.bincount(inv, minlength=nd).astype(float)
            r = h[bi].sum(1) / np.maximum(n[bi].sum(1), 1)
            return float(np.percentile(r, 5)), float(np.percentile(r, 95))
        big = fc[idx] >= 10        # days WE forecast ≥ 10 mm (conditioning on what fell would pick the misses)
        rows.append({"group": g, "days": int(len(o)), "big_days": int(big.sum()),
                     "likely": float(inl.mean()), "likely_range": boot(inl),
                     "possible": float(inp.mean()), "possible_range": boot(inp),
                     "likely_big": float(inl[big].mean()) if big.any() else None,
                     "possible_big": float(inp[big].mean()) if big.any() else None,
                     "width_likely_mm": float(wl), "width_possible_mm": float(wp)})
    return rows


def promoted(rows: list[dict]) -> bool:
    gs = [r for r in rows if r["group"] in GROUPS]
    return len(gs) == len(GROUPS) and all(
        abs(r["likely"] - TARGET["likely"]) <= TOL and abs(r["possible"] - TARGET["possible"]) <= TOL for r in gs)


def blended(con, params: dict):
    con.execute("CREATE TABLE bw(lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO bw VALUES (?, ?, ?)",
                    [(int(l), m, v) for l, ws in params["weights"].items() for m, v in ws.items()])
    return con.execute("""
      SELECT split, resort_id, local_date, lead, any_value(obs) AS obs, sum(bw.w * fcc) / sum(bw.w) AS f
      FROM dc JOIN bw USING (lead, model) GROUP BY split, resort_id, local_date, lead""").fetchnumpy()


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW p AS SELECT * FROM read_parquet('{pairs}')")
    B.load(con)
    params = B.fit(con)            # identical to blend.json from the same run
    r = blended(con, params)
    split = np.asarray(r["split"]); lead = np.asarray(r["lead"]); f = np.asarray(r["f"], float)
    obs = np.asarray(r["obs"], float); dates = np.asarray(r["local_date"]).astype(str)
    tr, te = split == "train", split == "test"
    table = fit_bands(lead[tr], f[tr], obs[tr])
    rows = judge(table, lead[te], f[te], obs[te], dates[te])
    prom = promoted(rows)
    doc = {"version": "bands-v1", "units": "mm water (the app converts with our number's own ratio)",
           "fitted_on": "2024-25 blend v1 forecasts vs SNOTEL/BC liquid, strict mid pairs, leads 1-7",
           "groups": {g: list(v) for g, v in GROUPS.items()}, "edges_mm": EDGES, "ratio_from_mm": RATIO_FROM_MM,
           "rule": "band = quantiles (abs mm, or x forecast when kind=ratio); widened to contain the forecast",
           "table": table, "judged_on": "2025-26, days where forecast or measured >= 1 mm",
           "coverage": rows, "target": TARGET, "tolerance": TOL, "promote": prom}
    (out / "bands.json").write_text(json.dumps(doc, indent=2) + "\n")
    fmt = lambda v: "—" if v is None else f"{v:.0%}"
    lines = ["| days ahead | days | days we said ≥10 mm | likely (target 50%) | 90% range | possible (target 80%) | 90% range "
             "| likely when we said ≥10 mm | possible when we said ≥10 mm | width likely / possible (mm) |", "|" + "---|" * 10]
    for x in rows:
        lines.append(f"| {x['group']} | {x['days']} | {x['big_days']} | {fmt(x['likely'])} | "
                     f"{x['likely_range'][0]:.0%}–{x['likely_range'][1]:.0%} | {fmt(x['possible'])} | "
                     f"{x['possible_range'][0]:.0%}–{x['possible_range'][1]:.0%} | {fmt(x['likely_big'])} | "
                     f"{fmt(x['possible_big'])} | {x['width_likely_mm']:.1f} / {x['width_possible_mm']:.1f} |")
    report = "\n".join([
        "# Bands v1 — fitted on 2024-25, judged on 2025-26 (our blend, liquid, strict pairs, mid tier)\n",
        "Share of wet days (forecast or measured ≥ 1 mm) where what fell landed inside the band.",
        f"Promote rule: every lead group within ±{TOL:.0%} of 50% (likely) and 80% (possible).",
        f"**Promote: {'YES' if prom else 'NO'}**\n", "\n".join(lines)]) + "\n"
    (out / "bands_report.md").write_text(report)
    print(report)   # public models + public truth only: safe for the run log
    print(f"bands v1 written (promote={prom})", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
