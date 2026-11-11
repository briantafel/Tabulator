#!/usr/bin/env python3
"""Blend v1: corrected, lead-weighted average of the models' liquid forecasts.

    python3 scripts/model/blend.py <pairs.parquet> <outDir>

Plain, auditable arithmetic (project rule). Fit on 2024-25 ('train') only,
judge on 2025-26 ('test') only. Leads 1–7 (lead 0 carries model spin-up).

1. Wet/dry factor per region × model × lead: Σobs ÷ Σforecast on training
   days, shrunk toward the all-region factor when a region has few wet days
   (weight n_wet / (n_wet + SHRINK_DAYS)), clamped to [0.5, 2].
2. Weight per model × lead: inverse mean squared error of the CORRECTED
   forecast on training days where either side is wet, normalised to 1.
3. Blend = Σ weight × corrected forecast over the models present that day;
   a missing model is dropped and the weights re-normalised (never zero).

Judged against each raw model and against the single model that scored best
on the TRAINING winter at that lead (the choice you could have made in
advance), with 90% date-block bootstrap ranges on the difference.
Writes blend.json and blend_report.md (sealed report; no paid sources used).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

SOURCE = "open-meteo-previous-runs"
LEADS = range(1, 8)
SHRINK_DAYS = 40
CLAMP = (0.5, 2.0)
WET_MM = 1.0
THRESHOLDS = (2.5, 10.0, 20.0)
N_BOOT = 1000
SEED = 20261111


def load(con):
    con.execute(f"""
    CREATE TABLE d AS
    SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date, lead_day AS lead, split,
           fc_amount AS fc, obs
    FROM p WHERE source = '{SOURCE}' AND space = 'liquid' AND pair_quality = 'strict' AND tier = 'mid'
      AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day BETWEEN 1 AND 7 AND split IN ('train', 'test')""")
    if con.execute("SELECT count(*) FROM d WHERE split = 'train'").fetchone()[0] == 0:
        raise SystemExit("blend: no training rows")


def fit(con) -> dict:
    fac = con.execute(f"""
      WITH r AS (SELECT model, lead, region, sum(obs) so, sum(fc) sf, sum(CAST(obs >= {WET_MM} AS INT)) wet
                 FROM d WHERE split = 'train' GROUP BY ALL),
           a AS (SELECT model, lead, sum(so) / nullif(sum(sf), 0) AS pooled FROM r GROUP BY ALL)
      SELECT r.model, r.lead, r.region, r.wet, r.so / nullif(r.sf, 0) AS raw, a.pooled
      FROM r JOIN a USING (model, lead)""").fetchall()
    factors, pooled = {}, {}
    for model, lead, region, wet, raw, pool in fac:
        pool = float(np.clip(pool if pool is not None else 1.0, *CLAMP))
        w = wet / (wet + SHRINK_DAYS)
        f = w * (raw if raw is not None else pool) + (1 - w) * pool
        factors[f"{model}|{lead}|{region}"] = round(float(np.clip(f, *CLAMP)), 3)
        pooled[f"{model}|{lead}"] = round(pool, 3)
    con.execute("CREATE TABLE fac(model VARCHAR, lead INTEGER, region VARCHAR, f DOUBLE)")
    con.executemany("INSERT INTO fac VALUES (?, ?, ?, ?)",
                    [(k.split("|")[0], int(k.split("|")[1]), k.split("|")[2], v) for k, v in factors.items()])
    con.execute("CREATE TABLE pool(model VARCHAR, lead INTEGER, f DOUBLE)")
    con.executemany("INSERT INTO pool VALUES (?, ?, ?)",
                    [(k.split("|")[0], int(k.split("|")[1]), v) for k, v in pooled.items()])
    # Corrected forecast: the region factor, else the pooled one (a region unseen in training).
    con.execute("""
    CREATE TABLE dc AS
    SELECT d.*, d.fc * coalesce(fac.f, pool.f, 1.0) AS fcc
    FROM d LEFT JOIN fac USING (model, lead, region) LEFT JOIN pool USING (model, lead)""")
    mse = con.execute(f"""SELECT model, lead, avg(power(fcc - obs, 2)) FROM dc
                          WHERE split = 'train' AND (obs >= {WET_MM} OR fcc >= {WET_MM}) GROUP BY ALL""").fetchall()
    weights: dict[str, dict[str, float]] = {}
    for model, lead, m in mse:
        weights.setdefault(str(lead), {})[model] = 1.0 / m
    for lead, ws in weights.items():
        tot = sum(ws.values())
        weights[lead] = {k: round(v / tot, 3) for k, v in sorted(ws.items())}
    # Best single raw model per lead on the TRAINING winter (CSI at 10 mm): the honest comparator.
    best = {}
    for lead in LEADS:
        rows = con.execute(f"""SELECT model, sum(CAST(fc >= 10 AND obs >= 10 AS INT)) /
                                 nullif(sum(CAST(fc >= 10 OR obs >= 10 AS INT)), 0) AS csi
                               FROM d WHERE split = 'train' AND lead = {lead} GROUP BY model ORDER BY csi DESC""").fetchall()
        if rows:
            best[str(lead)] = rows[0][0]
    return {"version": "blend-v1", "fitted_on": "2024-25, leads 1-7, strict SNOTEL/BC pairs, mid tier, liquid",
            "factor_rule": f"region factor shrunk to pooled with n_wet/(n_wet+{SHRINK_DAYS}), clamped {list(CLAMP)}",
            "weights": weights, "factors": factors, "pooled_factors": pooled, "best_single_on_train": best}


def csi_counts(f, o, inv, nd):
    h = np.bincount(inv, (f & o).astype(int), nd)
    fa = np.bincount(inv, (f & ~o).astype(int), nd)
    m = np.bincount(inv, (~f & o).astype(int), nd)
    return h, fa, m


def evaluate(con, params: dict) -> list[dict]:
    rng = np.random.default_rng(SEED)
    con.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO w VALUES (?, ?, ?)",
                    [(int(l), m, v) for l, ws in params["weights"].items() for m, v in ws.items()])
    # Test winter, one row per resort-day-lead: blend (re-normalised over models present) + each model raw.
    con.execute("""
    CREATE TABLE t AS
    SELECT resort_id, local_date, lead, any_value(obs) AS obs,
           sum(w.w * fcc) / sum(w.w) AS blend,
           max(CASE WHEN model = 'ecmwf_ifs025' THEN fc END) AS ecmwf_ifs025,
           max(CASE WHEN model = 'gem_seamless' THEN fc END) AS gem_seamless,
           max(CASE WHEN model = 'gfs_seamless' THEN fc END) AS gfs_seamless,
           count(*) AS n_models
    FROM dc JOIN w USING (lead, model) WHERE split = 'test' GROUP BY resort_id, local_date, lead""")
    out = []
    for lead in LEADS:
        r = con.execute(f"""SELECT local_date, obs, blend, ecmwf_ifs025, gem_seamless, gfs_seamless FROM t
                            WHERE lead = {lead} AND n_models = 3""").fetchnumpy()
        if len(r["obs"]) == 0:
            continue
        ud, inv = np.unique(r["local_date"], return_inverse=True)
        nd = len(ud)
        idx = rng.integers(0, nd, size=(N_BOOT, nd))
        best = params["best_single_on_train"].get(str(lead))
        for thr in THRESHOLDS:
            o = r["obs"] >= thr
            res = {}
            for name in ("blend", "ecmwf_ifs025", "gem_seamless", "gfs_seamless"):
                f = r[name] >= thr
                h, fa, m = csi_counts(f, o, inv, nd)
                csi = h.sum() / max(h.sum() + m.sum() + fa.sum(), 1)
                bh, bfa, bm = h[idx].sum(1), fa[idx].sum(1), m[idx].sum(1)
                res[name] = (csi, (h.sum() + fa.sum()) / max(h.sum() + m.sum(), 1), bh / np.maximum(bh + bm + bfa, 1))
            d = res["blend"][2] - res[best][2]
            out.append({"lead": lead, "thr": thr, "days": int(len(o)), "events": int(o.sum()),
                        "blend": res["blend"][0], "blend_bias": res["blend"][1],
                        "ecmwf": res["ecmwf_ifs025"][0], "gem": res["gem_seamless"][0], "gfs": res["gfs_seamless"][0],
                        "best": best.split("_")[0], "vs_best": res["blend"][0] - res[best][0],
                        "range": f"{np.percentile(d, 5):+.2f} to {np.percentile(d, 95):+.2f}",
                        "real": bool(np.percentile(d, 5) > 0)})
    mae = con.execute("""SELECT lead, avg(abs(blend - obs)), avg(abs(ecmwf_ifs025 - obs)), avg(abs(gem_seamless - obs)),
                                avg(abs(gfs_seamless - obs)) FROM t WHERE n_models = 3 GROUP BY lead ORDER BY lead""").fetchall()
    return out, mae


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW p AS SELECT * FROM read_parquet('{pairs}')")
    load(con)
    params = fit(con)
    (out / "blend.json").write_text(json.dumps(params, indent=2) + "\n")
    res, mae = evaluate(con, params)
    f = lambda v: f"{v:.2f}" if isinstance(v, (float, np.floating)) else str(v)
    cols = [("lead", "lead"), ("≥ mm", "thr"), ("days", "days"), ("events", "events"), ("blend CSI", "blend"),
            ("blend bias", "blend_bias"), ("ECMWF", "ecmwf"), ("GEM", "gem"), ("GFS", "gfs"),
            ("best on train", "best"), ("blend − best", "vs_best"), ("90% range", "range"), ("real?", "real")]
    lines = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(f(r[k]) for _, k in cols) + " |" for r in res]
    wl = ["| lead | " + " | ".join(sorted(next(iter(params["weights"].values())))) + " | best on train |", "|---|---|---|---|---|"]
    for lead in sorted(params["weights"], key=int):
        ws = params["weights"][lead]
        wl.append(f"| {lead} | " + " | ".join(f"{ws.get(m, 0):.2f}" for m in sorted(ws)) +
                  f" | {params['best_single_on_train'].get(lead, '—')} |")
    report = "\n".join([
        "# Blend v1 — fitted on 2024-25, judged on 2025-26 (liquid, strict pairs, mid tier)\n",
        "Public models only. 'Best on train' = the single model with the highest CSI ≥10 mm on the training",
        "winter at that lead — the choice available in advance. 'real?' = the 90% range of blend − best is above 0.\n",
        "## Weights (inverse MSE of the corrected forecast)\n", "\n".join(wl),
        "\n## Judged on the test winter (CSI)\n", "\n".join(lines),
        "\n## Mean absolute error, mm/day (all test days)\n",
        "| lead | blend | ECMWF | GEM | GFS |\n|---|---|---|---|---|\n" +
        "\n".join(f"| {l} | {a:.2f} | {b:.2f} | {c:.2f} | {e:.2f} |" for l, a, b, c, e in mae),
    ]) + "\n"
    (out / "blend_report.md").write_text(report)
    print("blend v1 written", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
