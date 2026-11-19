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
VARS = ("hi", "lo", "lift")  # lift = coldest hour 08–16 local (the −10 °F veto)
SHRINK_DAYS = 30
# Decaying-average bias (2026-11-19, "drift" section): b <- (1 - a) b + a e_day, started from the
# fitted static bias at each season's start. a is chosen on the training winter from this grid.
ALPHAS = (0.02, 0.05, 0.1, 0.2)
SIERRA_CASCADES = ("California", "Nevada", "Oregon", "Washington")
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
      AND split IN ('train', 'test', 'live') AND lead_day BETWEEN 1 AND 7
    GROUP BY ALL""")
    con.execute(f"DELETE FROM d WHERE model NOT IN {MODELS}")
    if con.execute("SELECT count(*) FROM d WHERE split = 'train'").fetchone()[0] < 1000:
        raise SystemExit("temps: too few training pairs")

    # ---- correction per var × resort × model (leads 1–3 of the training winter), shrunk to the region.
    # v2 (2026-11-15, Brian "do it all"): lows and lift-hours lows get the same treatment as highs,
    # and each is promoted per lead only if it beats every comparator on the test winter.
    con.execute(f"""
    CREATE TABLE corr AS
    WITH r AS (SELECT var, model, resort_id, any_value(region) AS region, avg(fc - obs) AS b, count(*) AS n
               FROM d WHERE split = 'train' AND lead BETWEEN 1 AND 3 GROUP BY var, model, resort_id),
         g AS (SELECT var, model, region, avg(fc - obs) AS gb FROM d
               WHERE split = 'train' AND lead BETWEEN 1 AND 3 GROUP BY var, model, region)
    SELECT r.var, r.model, r.resort_id, r.region, r.n, r.b AS raw_bias,
           (r.n * r.b + {SHRINK_DAYS} * g.gb) / (r.n + {SHRINK_DAYS}) AS bias
    FROM r JOIN g USING (var, model, region)""")
    con.execute("""
    CREATE TABLE dc AS
    SELECT d.*, d.fc - coalesce(c.bias, 0) AS fcc
    FROM d LEFT JOIN corr c USING (var, model, resort_id)""")

    # ---- weights per var × lead: inverse MSE on the training winter
    weights: dict[str, dict[str, dict[str, float]]] = {v: {} for v in VARS}
    for var, lead, model, mse in con.execute("""SELECT var, lead, model, avg(power(fcc - obs, 2)) FROM dc
                                                WHERE split = 'train' GROUP BY ALL ORDER BY ALL""").fetchall():
        weights[var].setdefault(str(lead), {})[model] = 1 / mse
    for var in weights:
        for lead, ws in weights[var].items():
            t = sum(ws.values())
            weights[var][lead] = {m: round(v / t, 3) for m, v in ws.items()}
    best = {var: {} for var in VARS}
    for var, lead, model in con.execute("""SELECT var, lead, arg_min(model, mae) FROM (
          SELECT var, lead, model, avg(abs(fc - obs)) AS mae FROM d WHERE split = 'train' GROUP BY ALL) GROUP BY ALL""").fetchall():
        best[var][str(lead)] = model

    corr_by = {v: {} for v in VARS}
    for v, m, r, b in con.execute("SELECT var, model, resort_id, bias FROM corr ORDER BY ALL").fetchall():
        corr_by.setdefault(v, {})[f"{m}|{r}"] = round(b, 3)
    params = {
        "version": "temps-v2", "units": "C", "fitted_on": "2024-25 (train); judged on 2025-26",
        "models": list(MODELS), "elevation": "Snow-Forecast mid elevation (Open-Meteo `elevation`)",
        "correction": "forecast − bias[model|resort]; bias = forecast − SNOTEL (TMAX / TMIN / coldest hourly "
                      "TOBS 08–16 local), leads 1–3 of 2024-25, shrunk to region. Applied only where promote[var][lead].",
        "caveat_lows": "SNOTEL lows may read warm in deep cold (sensor); a low correction moves us toward SNOTEL, "
                       "not necessarily toward the slope. Re-check against slope stations (Synoptic, Dec).",
        "weights": weights, "high_bias": corr_by.get("hi", {}), "low_bias": corr_by.get("lo", {}),
        "lift_bias": corr_by.get("lift", {}), "best_single_on_train": best,
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
    promote = {v: {} for v in VARS}
    for var in VARS:
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
                if not hi_ < 0:
                    beats_all = False
            res["promote"] = beats_all
            promote[var][str(lead)] = beats_all
            rows.append(res)
    params["promote"] = promote
    drift_md, decay = drift_and_decay(con, weights, rng)
    params["decay"] = decay  # evaluated only; the app does not read it yet
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
                          FROM corr WHERE var = 'hi' GROUP BY resort_id, region ORDER BY abs(avg(bias)) DESC LIMIT 12""").fetchall()
    report = "\n".join([
        "# Temperature model v2 — fitted on 2024-25, judged on 2025-26\n",
        "Public models + SNOTEL only. hi / lo / lift (coldest 08–16 local): per-resort correction + lead weights.",
        "Ranges are 90% (date bootstrap) of the MAE difference in °F; negative = ours better.",
        "PROMOTE = better than the equal blend, the uncorrected blend and the best single model,",
        "with the whole range below zero.\n",
        "## Judged on the test winter\n", "\n".join(tbl),
        "\n## Largest high corrections (°F, mean over the three models; + = models too warm)\n",
        "| resort | region | raw bias | shrunk | min days |\n|---|---|---|---|---|\n" +
        "\n".join(f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in big),
        drift_md,
        "\n## Weights\n```\n" + json.dumps(weights, indent=1) + "\n```\n",
    ])
    (out / "temps_report.md").write_text(report)
    print("temps v2 written", file=sys.stderr)


def _macro(region: str) -> str:
    return "Sierra & Cascades" if region in SIERRA_CASCADES else "Rockies & other"


def drift_and_decay(con, weights, rng):
    """Does the fitted bias still hold? (Brian, 2026-11-19.)

    The live season showed our corrected highs running warm in the Sierra & Cascades
    (+1.9 to +3.9 °F at leads 1–5) because the raw models' cold bias there shrank.
    1. Drift table: raw-model and corrected bias (°F, leads 1–3) by season × month × macro
       region — a month pattern (early season ≠ mid-winter) vs a season-wide drift.
    2. Decaying-average bias, the standard operational fix (NCEP NAEFS style): per
       var × model × resort, b ← (1 − a)·b + a·e, e = that day's mean lead 1–3 error,
       started from the static bias each season. A forecast issued on day I uses only
       observations through day I − 1. A missing observation leaves b unchanged (never 0).
       a is chosen on the training winter, judged on the test winter against the static
       correction with the same date bootstrap; live is shown, too small to judge.
    """
    con.execute("CREATE TEMP TABLE regions AS SELECT DISTINCT resort_id, region FROM d")
    macro = {r: _macro(g) for r, g in con.execute("SELECT resort_id, region FROM regions").fetchall()}

    # ---- 1. drift table (highs and lows)
    rows = con.execute(f"""
      SELECT split, month(local_date) AS mo, var, resort_id, avg(fc - obs) * {F} AS raw, avg(fcc - obs) * {F} AS cor,
             count(DISTINCT local_date) AS days
      FROM dc WHERE lead BETWEEN 1 AND 3 AND var IN ('hi', 'lo') GROUP BY ALL""").fetchall()
    agg: dict = {}
    for split, mo, var, resort, raw, cor, days in rows:
        k = (var, macro.get(resort, "Rockies & other"), split, mo)
        a = agg.setdefault(k, [0.0, 0.0, 0])
        a[0] += raw * days; a[1] += cor * days; a[2] += days
    order = {"train": 0, "test": 1, "live": 2}
    md = ["\n## Drift: is the fitted bias still right? (°F, leads 1–3, + = too warm)\n",
          "Raw = mean of the three models before correction; corrected = after the static per-resort",
          "correction. Months in calendar order within each season.\n",
          "| var | region | season | month | resort-days | raw bias | corrected bias |", "|---|---|---|---|---|---|---|"]
    season_months = lambda m: m + 12 if m <= 6 else m  # Nov, Dec … Apr
    for k in sorted(agg, key=lambda k: (k[0], k[1], order.get(k[2], 9), season_months(k[3]))):
        raw, cor, n = agg[k]
        if n < 20:
            continue
        md.append(f"| {k[0]} | {k[1]} | {k[2]} | {k[3]:02d} | {n} | {raw / n:+.2f} | {cor / n:+.2f} |")

    # ---- 2. decaying-average bias (vectorised: the real pairs are ~10⁶ rows)
    r = con.execute("""SELECT dc.var, dc.model, dc.resort_id, dc.split, dc.local_date, dc.lead, dc.fc, dc.fcc, dc.obs,
                              coalesce(c.bias, 0) AS static
                       FROM dc LEFT JOIN corr c USING (var, model, resort_id)""").fetchnumpy()
    fc, fcc, obs = (np.asarray(r[k], float) for k in ("fc", "fcc", "obs"))
    static, lead = np.asarray(r["static"], float), np.asarray(r["lead"], np.int64)
    day = np.asarray(r["local_date"]).astype("datetime64[D]").astype(np.int64)
    split = np.asarray(r["split"]).astype(str)
    vars_, vi = np.unique(np.asarray(r["var"]).astype(str), return_inverse=True)
    models, mi = np.unique(np.asarray(r["model"]).astype(str), return_inverse=True)
    resorts, ri = np.unique(np.asarray(r["resort_id"]).astype(str), return_inverse=True)
    splits, si = np.unique(split, return_inverse=True)
    w_row = np.array([weights.get(vars_[v], {}).get(str(L), {}).get(models[m], np.nan)
                      for v, L, m in zip(vi, lead, mi)], float) if len(fc) else np.zeros(0)
    d0 = day.min() if len(day) else 0
    series = (((vi * len(models) + mi) * len(resorts) + ri) * len(splits) + si) if len(fc) else np.zeros(0, np.int64)
    s_order = np.argsort(series, kind="stable")
    s_bounds = np.flatnonzero(np.diff(series[s_order])) + 1

    def decayed(alpha):
        """Bias in force for each row: obs through (valid day − lead − 1), started from the static bias."""
        b_use = static.copy()
        for idx in np.split(s_order, s_bounds) if len(fc) else []:
            o = idx[lead[idx] <= 3]
            if not len(o):
                continue
            ud, inv = np.unique(day[o], return_inverse=True)
            e = np.bincount(inv, fc[o] - obs[o], len(ud)) / np.bincount(inv, minlength=len(ud))
            b, cur = np.empty(len(ud)), static[idx[0]]
            for j, ej in enumerate(e):
                cur = (1 - alpha) * cur + alpha * ej
                b[j] = cur
            pos = np.searchsorted(ud, day[idx] - lead[idx] - 1, side="right") - 1
            b_use[idx] = np.where(pos >= 0, b[np.clip(pos, 0, None)], static[idx])
        return b_use

    def blend(pred, which):
        """Weighted blend per (var, lead, resort, day) where all three models are present.
        Returns var, lead, resort index, day, forecast, obs arrays."""
        m = (split == which) & ~np.isnan(w_row)
        if not m.any():
            return [np.zeros(0)] * 6
        g = ((vi[m] * 8 + lead[m]) * len(resorts) + ri[m]) * 100000 + (day[m] - d0)
        ug, inv = np.unique(g, return_inverse=True)
        num = np.bincount(inv, w_row[m] * pred[m]); den = np.bincount(inv, w_row[m]); cnt = np.bincount(inv)
        ob = np.zeros(len(ug)); ob[inv] = obs[m]
        keep = cnt == len(MODELS)
        ug, f, ob = ug[keep], (num / den)[keep], ob[keep]
        dd = ug % 100000 + d0; rest = ug // 100000
        return rest // len(resorts) // 8, rest // len(resorts) % 8, rest % len(resorts), dd, f, ob

    choice = {}
    for vname in VARS:
        if vname not in vars_:
            choice[vname] = None
            continue
        v = int(np.flatnonzero(vars_ == vname)[0])
        best_a, best_mae = None, None
        for a in ALPHAS:
            bv, _, _, _, f, ob = blend(fc - decayed(a), "train")
            e = np.abs(f - ob)[bv == v]
            if len(e) and (best_mae is None or e.mean() < best_mae):
                best_a, best_mae = a, float(e.mean())
        choice[vname] = best_a
    md += ["\n## Decaying-average bias vs the static correction\n",
           f"a chosen on the training winter from {ALPHAS}: " + ", ".join(f"{v} {choice[v]}" for v in VARS) + ".",
           "MAE °F; range = 90% date bootstrap of decaying − static (negative = decaying better).",
           "PROMOTE = whole test-winter range below zero. Live is shown, not judged.\n",
           "| var | lead | season | region | days | static MAE | static bias | decaying MAE | decaying bias | decaying − static | promote |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    promote = {v: {} for v in VARS}
    is_sierra = np.array([macro.get(x) == "Sierra & Cascades" for x in resorts]) if len(resorts) else np.zeros(0, bool)
    for vname in VARS:
        if choice[vname] is None:
            continue
        v = int(np.flatnonzero(vars_ == vname)[0])
        fcd = fc - decayed(choice[vname])
        for sp in ("test", "live"):
            sv, sl, sr, sd, sf_, so = blend(fcc, sp)
            dv, dl, dr, dd_, df, do = blend(fcd, sp)
            if not len(sv) or len(sv) != len(dv):
                continue
            for L in LEADS:
                for reg in ("ALL", "Sierra & Cascades", "Rockies & other"):
                    m = (sv == v) & (sl == L)
                    if reg != "ALL":
                        m &= is_sierra[sr] == (reg == "Sierra & Cascades")
                    if m.sum() < 20:
                        continue
                    se, de = (sf_[m] - so[m]) * F, (df[m] - do[m]) * F
                    ud, inv = np.unique(sd[m], return_inverse=True)
                    cnt = np.bincount(inv, minlength=len(ud))
                    spd = np.bincount(inv, np.abs(se), len(ud)); dpd = np.bincount(inv, np.abs(de), len(ud))
                    idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
                    diff = (dpd[idx].sum(1) - spd[idx].sum(1)) / cnt[idx].sum(1)
                    lo_, hi_ = np.percentile(diff, 5), np.percentile(diff, 95)
                    prom = ""
                    if sp == "test" and reg == "ALL":
                        promote[vname][str(L)] = bool(hi_ < 0)
                        prom = str(bool(hi_ < 0))
                    md.append(f"| {vname} | {L} | {sp} | {reg} | {int(m.sum())} | {np.abs(se).mean():.2f} | {se.mean():+.2f} | "
                              f"{np.abs(de).mean():.2f} | {de.mean():+.2f} | {lo_:+.2f} to {hi_:+.2f} | {prom} |")
    return "\n".join(md) + "\n", {"alpha": choice, "promote": promote,
                                   "note": "evaluated only (2026-11-19); the live builder does not apply it yet"}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
