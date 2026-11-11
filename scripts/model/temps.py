#!/usr/bin/env python3
"""Temperature model v1: fit on 2024-25, judge on 2025-26.

    python3 scripts/model/temps.py <temp_pairs.parquet> <outDir>

Brian, 2026-11-11 (claude/temp-wind-plan.md): the app shows OUR temperature
everywhere; the target is the slope; the −10 °F veto uses the lift-hours low.
This fits the parts the past winters can support:

  HIGHS: per resort × model bias correction (forecast − SNOTEL TMAX, leads
         1–3, after the build's lapse-rate move to the station), shrunk to the
         region's bias by n / (n + SHRINK_DAYS). Then weights per lead =
         inverse MSE of the corrected forecast.
  LOWS:  weights per lead only (inverse MSE, raw). NO per-resort correction:
         Brian chose the slope, and the SNOTEL lows may be the wrong side
         (models run 6–14 °F colder than some stations; unresolved until
         slope-sited stations arrive in December).

Models: the three the app can fetch live from Open-Meteo's forecast API and
that the archive backfilled from its Previous Runs API (same model ids, so
training and serving match): ecmwf_ifs025, gem_seamless, gfs_seamless.

Judged on the test winter, per lead, against:
  - the equal-weight raw blend (what a naive average would give),
  - the weighted blend without the high correction (isolates the correction),
  - the single model that was best on the TRAINING winter (choosable in advance).
Average error (°F), share of days within 3 °F, bias; 90% ranges from a date
bootstrap. PROMOTE is true only where the model's error is lower than every
comparator with the whole range on the right side of zero.

Writes temp-model.json (what the live builder applies) and temps_report.md.
Public models and SNOTEL only — no paid input — so the parameters may be
committed to the public repo.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

SOURCE = "open-meteo-previous-runs"
MODELS = ("ecmwf_ifs025", "gem_seamless", "gfs_seamless")
LEADS = range(1, 8)
SHRINK_DAYS = 30
F = 9 / 5
N_BOOT = 1000
SEED = 20261111


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"""
    CREATE TABLE d AS
    SELECT split_part(source_label, ':', 2) AS model, resort_id, region, local_date, lead_day AS lead, split, var,
           avg(fc_adj) AS fc, any_value(obs) AS obs
    FROM read_parquet('{pairs}')
    WHERE source = '{SOURCE}' AND pair_quality = 'strict' AND tier = 'mid' AND fc_adj IS NOT NULL
      AND split IN ('train', 'test') AND lead_day BETWEEN 1 AND 7
    GROUP BY ALL""")
    con.execute(f"DELETE FROM d WHERE model NOT IN {MODELS}")
    if con.execute("SELECT count(*) FROM d WHERE split = 'train'").fetchone()[0] < 1000:
        raise SystemExit("temps: too few training pairs")

    # ---- high correction per resort × model (leads 1–3 of the training winter), shrunk to the region
    con.execute(f"""
    CREATE TABLE corr AS
    WITH r AS (SELECT model, resort_id, any_value(region) AS region, avg(fc - obs) AS b, count(*) AS n
               FROM d WHERE split = 'train' AND var = 'hi' AND lead BETWEEN 1 AND 3 GROUP BY model, resort_id),
         g AS (SELECT model, region, avg(fc - obs) AS gb FROM d
               WHERE split = 'train' AND var = 'hi' AND lead BETWEEN 1 AND 3 GROUP BY model, region)
    SELECT r.model, r.resort_id, r.region, r.n, r.b AS raw_bias,
           (r.n * r.b + {SHRINK_DAYS} * g.gb) / (r.n + {SHRINK_DAYS}) AS bias
    FROM r JOIN g USING (model, region)""")
    con.execute("""
    CREATE TABLE dc AS
    SELECT d.*, CASE WHEN d.var = 'hi' THEN d.fc - coalesce(c.bias, 0) ELSE d.fc END AS fcc
    FROM d LEFT JOIN corr c USING (model, resort_id)""")

    # ---- weights per var × lead: inverse MSE on the training winter
    weights: dict[str, dict[str, dict[str, float]]] = {"hi": {}, "lo": {}}
    for var, lead, model, mse in con.execute("""SELECT var, lead, model, avg(power(fcc - obs, 2)) FROM dc
                                                WHERE split = 'train' GROUP BY ALL ORDER BY ALL""").fetchall():
        weights[var].setdefault(str(lead), {})[model] = 1 / mse
    for var in weights:
        for lead, ws in weights[var].items():
            t = sum(ws.values())
            weights[var][lead] = {m: round(v / t, 3) for m, v in ws.items()}
    best = {var: {} for var in ("hi", "lo")}
    for var, lead, model in con.execute("""SELECT var, lead, arg_min(model, mae) FROM (
          SELECT var, lead, model, avg(abs(fc - obs)) AS mae FROM d WHERE split = 'train' GROUP BY ALL) GROUP BY ALL""").fetchall():
        best[var][str(lead)] = model

    corrections = {f"{m}|{r}": round(b, 3) for m, r, b in
                   con.execute("SELECT model, resort_id, bias FROM corr ORDER BY ALL").fetchall()}
    params = {
        "version": "temps-v1", "units": "C", "fitted_on": "2024-25 (train); judged on 2025-26",
        "models": list(MODELS), "elevation": "Snow-Forecast mid elevation (Open-Meteo `elevation`)",
        "high_correction": "forecast − bias[model|resort]; bias = forecast − SNOTEL TMAX, shrunk to region",
        "low_correction": "none (Brian 2026-11-11: target is the slope; SNOTEL lows unresolved)",
        "weights": weights, "high_bias": corrections, "best_single_on_train": best,
    }

    # ---- judge on the test winter
    con.execute("CREATE TABLE w(var VARCHAR, lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO w VALUES (?, ?, ?, ?)",
                    [(v, int(l), m, x) for v in weights for l, ws in weights[v].items() for m, x in ws.items()])
    con.execute(f"""
    CREATE TABLE t AS
    SELECT dc.var, dc.lead, dc.resort_id, dc.local_date, any_value(dc.obs) AS obs,
           sum(w.w * dc.fcc) / sum(w.w) AS ours,
           sum(w.w * dc.fc) / sum(w.w) AS weighted_raw,
           avg(dc.fc) AS equal_raw,
           {", ".join(f"max(CASE WHEN dc.model = '{m}' THEN dc.fc END) AS {m}" for m in MODELS)},
           count(*) AS n_models
    FROM dc JOIN w USING (var, lead, model) WHERE dc.split = 'test'
    GROUP BY dc.var, dc.lead, dc.resort_id, dc.local_date HAVING count(*) = {len(MODELS)}""")
    rng = np.random.default_rng(SEED)
    rows = []
    promote = {"hi": {}, "lo": {}}
    for var in ("hi", "lo"):
        for lead in LEADS:
            r = con.execute(f"SELECT * FROM t WHERE var = '{var}' AND lead = {lead}").fetchnumpy()
            if len(r["obs"]) == 0:
                continue
            ud, inv = np.unique(r["local_date"], return_inverse=True)
            idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
            cnt = np.bincount(inv, minlength=len(ud))

            def err(col):
                e = np.abs(r[col] - r["obs"]) * F
                per = np.bincount(inv, e, len(ud))
                return e.mean(), per

            ours_mae, ours_per = err("ours")
            res = {"var": var, "lead": lead, "days": len(r["obs"]), "ours_mae": ours_mae,
                   "ours_bias": float(np.mean(r["ours"] - r["obs"]) * F),
                   "ours_w3": float(np.mean(np.abs(r["ours"] - r["obs"]) * F <= 3))}
            beats_all = True
            b = best[var].get(str(lead))
            for name, col in (("equal", "equal_raw"), ("uncorrected", "weighted_raw"), ("best", b)):
                mae, per = err(col)
                # MAE difference (ours − comparator) over resampled dates; negative = ours better.
                diff = (ours_per[idx].sum(1) - per[idx].sum(1)) / cnt[idx].sum(1)
                lo_, hi_ = np.percentile(diff, 5), np.percentile(diff, 95)
                res[f"{name}_mae"] = mae
                res[f"{name}_range"] = f"{lo_:+.2f} to {hi_:+.2f}"
                if name == "best":
                    res["best"] = b.split("_")[0]
                    res["best_w3"] = float(np.mean(np.abs(r[col] - r["obs"]) * F <= 3))
                if var == "lo" and name == "uncorrected":
                    continue  # identical for lows (no correction)
                if not hi_ < 0:
                    beats_all = False
            res["promote"] = beats_all
            promote[var][str(lead)] = beats_all
            rows.append(res)
    params["promote"] = promote
    (out / "temp-model.json").write_text(json.dumps(params, indent=1) + "\n")

    f = lambda v: f"{v:.2f}" if isinstance(v, (float, np.floating)) else str(v)
    cols = [("var", "var"), ("lead", "lead"), ("days", "days"), ("ours MAE °F", "ours_mae"), ("ours bias", "ours_bias"),
            ("ours ≤3°F", "ours_w3"), ("equal MAE", "equal_mae"), ("ours − equal", "equal_range"),
            ("uncorrected MAE", "uncorrected_mae"), ("ours − uncorr.", "uncorrected_range"),
            ("best on train", "best"), ("best MAE", "best_mae"), ("best ≤3°F", "best_w3"),
            ("ours − best", "best_range"), ("promote", "promote")]
    tbl = ["| " + " | ".join(h for h, _ in cols) + " |", "|" + "---|" * len(cols)]
    tbl += ["| " + " | ".join(f(r.get(k, "—")) for _, k in cols) + " |" for r in rows]
    big = con.execute(f"""SELECT resort_id, region, round(avg(raw_bias) * {F}, 1), round(avg(bias) * {F}, 1), min(n)
                          FROM corr GROUP BY resort_id, region ORDER BY abs(avg(bias)) DESC LIMIT 12""").fetchall()
    report = "\n".join([
        "# Temperature model v1 — fitted on 2024-25, judged on 2025-26\n",
        "Public models + SNOTEL only. Highs: per-resort correction + lead weights. Lows: lead weights only.",
        "Ranges are 90% (date bootstrap) of the MAE difference in °F; negative = ours better.",
        "PROMOTE = better than the equal blend, the uncorrected blend (highs) and the best single model,",
        "with the whole range below zero.\n",
        "## Judged on the test winter\n", "\n".join(tbl),
        "\n## Largest high corrections (°F, mean over the three models; + = models too warm)\n",
        "| resort | region | raw bias | shrunk | min days |\n|---|---|---|---|---|\n" +
        "\n".join(f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in big),
        "\n## Weights\n```\n" + json.dumps(weights, indent=1) + "\n```\n",
    ])
    (out / "temps_report.md").write_text(report)
    print("temps v1 written", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
