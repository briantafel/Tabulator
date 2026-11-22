#!/usr/bin/env python3
"""Head-to-head check: does HRRR as its own blend member beat blend-v1 on days 1–2? (plan-near-term-models-2026-11-22)

    python3 scripts/model/blend_hrrr.py <pairs.parquet> <outDir>

No app change: writes blend_hrrr_report.md and blend_hrrr.json only.

Same rules as blend-v1 (blend.py's own fit(), unchanged): fit on 2024-25 ('train'), judge on 2025-26 ('test'), strict
SNOTEL/BC pairs, mid tier, liquid, leads 1–2 (HRRR runs to 48 h; days it does not cover in full are already dropped by
verify, never zero). Both blends are fitted and judged on the SAME resort-days: the days where ECMWF, GFS, GEM and HRRR
all have a forecast (so US resorts on HRRR's grid only).

  v1 = blend-v1 refitted on those days (ECMWF, GFS, GEM)
  v2 = v1 plus HRRR as a fourth member (its own region factor and inverse-MSE weight)

HRRR has 4 runs a day, so a resort-day at lead L has several. Two rules, both reported:
  latest = the last run issued on the lead's issue date (what a 3-hourly blend would use: the honest live case)
  first  = the first run issued that date (the most conservative: no freshness edge over the daily Open-Meteo runs)

Gate, written before any result (ship only if BOTH hold, under the `latest` rule):
  1. lead 1, water >= 10 mm: v2 minus v1 CSI, 90% date-block bootstrap range, 5th percentile > 0
  2. lead 1, water >= 2.5 mm: v2 minus v1 CSI 5th percentile > -0.02 (not worse on light days)
Also reported, not gated: lead 2, 20 mm, MAE, volume ratio, and how closely Open-Meteo's gfs_seamless tracks HRRR by
lead (if gfs_seamless already carries HRRR at day 1 the correlation is high there and drops after day 2).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import blend as B  # noqa: E402

LEADS = (1, 2)
THR = (2.5, 10.0, 20.0)
OM = ("ecmwf_ifs025", "gem_seamless", "gfs_seamless")
SEED, N_BOOT = 20261122, 1000


def base(con, pairs: Path, rule: str) -> int:
    order = "DESC" if rule == "latest" else "ASC"
    con.execute(f"""
    CREATE OR REPLACE TABLE raw AS
    SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date, lead_day AS lead, split,
           fc_amount AS fc, obs
    FROM read_parquet('{pairs}')
    WHERE source = '{B.SOURCE}' AND space = 'liquid' AND pair_quality = 'strict' AND tier = 'mid'
      AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day IN {LEADS} AND split IN ('train', 'test')
    UNION ALL
    SELECT 'hrrr', region, resort_id, local_date, lead_day, split, fc_amount, obs FROM (
      SELECT * FROM read_parquet('{pairs}')
      WHERE source = 'noaa-hrrr' AND space = 'liquid' AND pair_quality = 'strict' AND tier = 'mid'
        AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day IN {LEADS} AND split IN ('train', 'test')
      QUALIFY row_number() OVER (PARTITION BY resort_id, local_date, lead_day ORDER BY issue_ts {order}) = 1)""")
    # head-to-head: keep resort-day-leads where all four forecast
    con.execute("""
    CREATE OR REPLACE TABLE both4 AS
    SELECT resort_id, local_date, lead FROM raw GROUP BY ALL HAVING count(DISTINCT model) = 4""")
    con.execute("CREATE OR REPLACE TABLE r4 AS SELECT raw.* FROM raw JOIN both4 USING (resort_id, local_date, lead)")
    return con.execute("SELECT count(*) FROM both4").fetchone()[0]


def fitted(con, models) -> tuple[dict, str]:
    """blend.fit() on its own connection, on r4 restricted to `models`; returns params and a table name of test blends."""
    c = duckdb.connect()
    rows = con.execute(f"SELECT * FROM r4 WHERE model IN {tuple(models)}").fetchdf()
    c.register("rows_df", rows)
    c.execute("CREATE TABLE d AS SELECT * FROM rows_df")
    p = B.fit(c)
    c.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    c.executemany("INSERT INTO w VALUES (?, ?, ?)", [(int(l), m, v) for l, ws in p["weights"].items() for m, v in ws.items()])
    t = c.execute("""SELECT resort_id, local_date, lead, any_value(obs) AS obs, sum(w.w * fcc) / sum(w.w) AS fc
                     FROM dc JOIN w USING (lead, model) WHERE split = 'test' GROUP BY ALL""").fetchdf()
    hc = c.execute("""SELECT resort_id, local_date, lead, fcc AS fc FROM dc WHERE split = 'test' AND model = 'hrrr'""").fetchdf() \
        if "hrrr" in models else None
    return p, t, hc


def scores(df_by_name: dict, lead: int, rng) -> list[dict]:
    """CSI / POD / FAR / freq bias per forecast name at each threshold, plus v2-v1 bootstrap on date blocks."""
    keys = None
    for n, df in df_by_name.items():
        k = df[df.lead == lead].set_index(["resort_id", "local_date"])
        df_by_name[n] = k
        keys = k.index if keys is None else keys.intersection(k.index)
    obs = df_by_name["v1"].loc[keys, "obs"].to_numpy()
    dates = np.array([d for _, d in keys])
    ud, inv = np.unique(dates, return_inverse=True)
    idx = rng.integers(0, len(ud), size=(N_BOOT, len(ud)))
    out = []
    for thr in THR:
        o = obs >= thr
        row = {"lead": lead, "thr": thr, "days": int(len(o)), "events": int(o.sum())}
        boots = {}
        for n, k in df_by_name.items():
            f = k.loc[keys, "fc"].to_numpy() >= thr
            h, fa, m = B.csi_counts(f, o, inv, len(ud))
            H, FA, M = h.sum(), fa.sum(), m.sum()
            row[n] = {"csi": H / max(H + M + FA, 1), "pod": H / max(H + M, 1), "far": FA / max(H + FA, 1),
                      "bias": (H + FA) / max(H + M, 1)}
            bh, bfa, bm = h[idx].sum(1), fa[idx].sum(1), m[idx].sum(1)
            boots[n] = bh / np.maximum(bh + bm + bfa, 1)
        d = boots["v2"] - boots["v1"]
        row["v2_minus_v1"] = row["v2"]["csi"] - row["v1"]["csi"]
        row["p05"], row["p95"] = float(np.percentile(d, 5)), float(np.percentile(d, 95))
        out.append(row)
    mae = {n: float(np.mean(np.abs(k.loc[keys, "fc"].to_numpy() - obs))) for n, k in df_by_name.items()}
    vol = {n: float(k.loc[keys, "fc"].sum() / max(obs.sum(), 1e-9)) for n, k in df_by_name.items()}
    return out, mae, vol


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    rng = np.random.default_rng(SEED)
    lines = ["# HRRR as its own blend member, days 1–2 (head-to-head; plan-near-term-models-2026-11-22)\n",
             "Fit 2024-25, judged 2025-26, strict SNOTEL/BC pairs, mid tier, water. Same resort-days for every column. "
             "CSI: 1 perfect, 0 useless. Range = 90% date-block bootstrap of v2 − v1.\n"]
    result = {"rules": {}}
    for rule in ("latest", "first"):
        n = base(con, pairs, rule)
        ntr = con.execute("SELECT count(*) FROM both4 JOIN (SELECT DISTINCT resort_id, local_date, lead, split FROM r4) USING (resort_id, local_date, lead) WHERE split = 'train'").fetchone()[0]
        nres = con.execute("SELECT count(DISTINCT resort_id) FROM r4").fetchone()[0]
        lines.append(f"\n## Rule `{rule}` — {n} resort-day-leads ({ntr} train), {nres} resorts\n")
        if ntr == 0 or n - ntr == 0:
            lines.append("**No head-to-head days in train or test: nothing to judge.** (Is noaa-hrrr in pairs.parquet?)\n")
            result["rules"][rule] = {"error": "no head-to-head days"}
            continue
        p1, t1, _ = fitted(con, OM)
        p2, t2, hc = fitted(con, OM + ("hrrr",))
        raw = con.execute("SELECT resort_id, local_date, lead, obs, model, fc FROM r4 WHERE split = 'test'").fetchdf()
        named = {"v1": t1, "v2": t2, "hrrr (corrected)": hc.merge(t1[["resort_id", "local_date", "lead", "obs"]])}
        for m in OM + ("hrrr",):
            named[f"{m} raw"] = raw[raw.model == m][["resort_id", "local_date", "lead", "obs", "fc"]]
        lines.append(f"HRRR weight in v2: lead 1 {p2['weights'].get('1', {}).get('hrrr')}, lead 2 {p2['weights'].get('2', {}).get('hrrr')}. "
                     f"v1 weights lead 1: {p1['weights'].get('1')}\n")
        rr = {}
        for lead in LEADS:
            rows, mae, vol = scores({k: v.copy() for k, v in named.items()}, lead, rng)
            rr[lead] = {"rows": rows, "mae": mae, "volume": vol}
            lines.append(f"\n### Lead {lead}\n")
            names = list(named)
            lines.append("| ≥ mm | days | events | " + " | ".join(names) + " | v2 − v1 (range) |")
            lines.append("|---|---|---|" + "---|" * len(names) + "---|")
            for r in rows:
                lines.append(f"| {r['thr']:g} | {r['days']} | {r['events']} | " +
                             " | ".join(f"{r[x]['csi']:.2f}" for x in names) +
                             f" | {r['v2_minus_v1']:+.3f} ({r['p05']:+.3f} to {r['p95']:+.3f}) |")
            lines.append("\nFreq bias (1 = right number of events) at 10 mm: " +
                         ", ".join(f"{x} {next(r for r in rows if r['thr'] == 10.0)[x]['bias']:.2f}" for x in names))
            lines.append("\nMAE mm: " + ", ".join(f"{k} {v:.2f}" for k, v in mae.items()))
            lines.append("\nVolume (Σfc ÷ Σobs): " + ", ".join(f"{k} {v:.2f}" for k, v in vol.items()) + "\n")
        r10 = next(r for r in rr[1]["rows"] if r["thr"] == 10.0)
        r25 = next(r for r in rr[1]["rows"] if r["thr"] == 2.5)
        passed = r10["p05"] > 0 and r25["p05"] > -0.02
        result["rules"][rule] = {"weights_v2": p2["weights"], "weights_v1": p1["weights"], "leads": rr,
                                 "gate": {"lead1_10mm_p05": r10["p05"], "lead1_2_5mm_p05": r25["p05"], "pass": passed}}
        if rule == "latest":
            lines.append(f"\n**Gate (latest rule): {'PASS' if passed else 'FAIL'}** — lead 1 ≥10 mm v2−v1 5th pct "
                         f"{r10['p05']:+.3f} (needs > 0), ≥2.5 mm 5th pct {r25['p05']:+.3f} (needs > −0.02). "
                         f"Events at 10 mm: {r10['events']}" + (" — fewer than 20: thin, not a result." if r10['events'] < 20 else "") + "\n")
    # Does gfs_seamless already carry HRRR? correlation by lead, every lead the two share (latest rule)
    base(con, pairs, "latest")
    cor = con.execute(f"""
      WITH a AS (SELECT resort_id, local_date, lead_day AS lead, fc_amount AS g FROM read_parquet('{pairs}')
                 WHERE source = '{B.SOURCE}' AND model = 'gfs_seamless' AND space = 'liquid' AND tier = 'mid'),
           h AS (SELECT resort_id, local_date, lead_day AS lead, fc_amount AS h FROM read_parquet('{pairs}')
                 WHERE source = 'noaa-hrrr' AND space = 'liquid' AND tier = 'mid'
                 QUALIFY row_number() OVER (PARTITION BY resort_id, local_date, lead_day ORDER BY issue_ts DESC) = 1),
           e AS (SELECT resort_id, local_date, lead_day AS lead, fc_amount AS e FROM read_parquet('{pairs}')
                 WHERE source = '{B.SOURCE}' AND model = 'ecmwf_ifs025' AND space = 'liquid' AND tier = 'mid')
      SELECT lead, count(*) n, corr(g, h) gfs_hrrr, corr(e, h) ecmwf_hrrr, corr(g, e) gfs_ecmwf
      FROM a JOIN h USING (resort_id, local_date, lead) JOIN e USING (resort_id, local_date, lead)
      WHERE lead BETWEEN 0 AND 2 GROUP BY lead ORDER BY lead""").fetchall()
    lines.append("\n## Does Open-Meteo's gfs_seamless already carry HRRR?\n")
    lines.append("Correlation of daily water, same resort-days. If gfs_seamless is HRRR-blended, gfs↔hrrr sits clearly above "
                 "ecmwf↔hrrr at leads 0–1. Evidence, not proof.\n")
    lines.append("| lead | n | gfs↔hrrr | ecmwf↔hrrr | gfs↔ecmwf |\n|---|---|---|---|---|")
    for l, nn, a, b, c in cor:
        lines.append(f"| {l} | {nn} | {a:.2f} | {b:.2f} | {c:.2f} |")
    result["correlation"] = [dict(zip(("lead", "n", "gfs_hrrr", "ecmwf_hrrr", "gfs_ecmwf"), r)) for r in cor]
    (out / "blend_hrrr_report.md").write_text("\n".join(lines) + "\n")
    (out / "blend_hrrr.json").write_text(json.dumps(result, default=float, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
