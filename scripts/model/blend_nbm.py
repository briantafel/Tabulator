#!/usr/bin/env python3
"""Head-to-head: NBM as a fourth blend member, and NBM alone as the US bar (plan-near-term-models-2026-11-22, step 3).

    python3 scripts/model/blend_nbm.py <pairs.parquet> <outDir>

Report only, no app change. Writes blend_nbm_report.md and blend_nbm.json. Public models and SNOTEL/BC truth only.

GATE, written and committed 2026-11-24 BEFORE any NBM-vs-blend number was computed (the template is blend_hrrr.py)
=================================================================================================================
Data (the same for every column)
  - Fit on 2024-25 ('train'), judge on 2025-26 ('test'). Strict SNOTEL/BC pairs, mid tier, liquid water.
  - Local days in Nov–Apr only, and NBM issued 2024-11-01 → 2026-04-30 at 00z or 12z: the nbm-3 history backfill.
    Rows outside that range are dropped, not scored as zero.
  - Same resort-day-leads for every column: ECMWF, GFS, GEM (Open-Meteo Previous Runs) AND NBM must all have a
    forecast. In practice this means resorts on NBM's CONUS grid. Coverage by resort is reported.
  - v1 = the blend-v1 method (blend.py fit(), unchanged) refitted on those days with ECMWF, GFS and GEM.
    v2 = the same plus NBM as a fourth member (its own region factor and inverse-MSE weight).
  - Leakage rule: every NBM row used must be issued before the start of its local valid day (lead_hours > 0) and
    must be a 00z or 12z cycle. Any violation aborts the run. It is never filtered quietly.

NBM cycle rules (NBM history is 00z/12z only). Both are reported, and the gate needs BOTH.
  latest   = the last NBM cycle issued on the lead's resort-local issue date (00z UTC ≈ 16–17 h local). This is
             what a blend built late in that day would use.
  earliest = the first cycle issued on that date (12z UTC ≈ 04–05 h local). It is conservative: no freshness edge
             over the once-a-day Open-Meteo runs.
  If a gain shows up only under `latest`, it comes from freshness, not from NBM (the HRRR lesson). Verdict
  FRESHNESS-ONLY, not passed.

Significance: 90% bootstrap over 7-day date blocks (1000 resamples, fixed seed). The blocks are weeks, not days,
because pooled leads put one storm on several dates.

(a) NBM as a fourth member, leads 1–3 pooled, under EACH cycle rule:
  A1  water ≥ 10 mm:  v2 − v1 CSI, 5th percentile > 0
  A2  water ≥ 2.5 mm: v2 − v1 CSI, 5th percentile > −0.02   (not worse on light days)
  A3  no single lead (1, 2 or 3) at ≥ 10 mm has its v2 − v1 95th percentile < 0   (not clearly worse at any lead)
  (a) PASSES only if A1, A2 and A3 all hold under `latest` AND under `earliest`.

(b) NBM alone (raw, as issued) vs v1, and vs ECMWF, GFS and GEM raw, by lead group 1–3 and 4–7, same days:
  NBM beats X     ≥ 10 mm NBM − X 5th percentile > 0, and ≥ 2.5 mm NBM − X 5th percentile > −0.02
  X beats NBM     ≥ 10 mm NBM − X 95th percentile < 0
  otherwise       no clear difference
  (b) PASSES (NBM alone is a better US days-1–3 forecast than blend-v1) only if "NBM beats v1" in group 1–3 under
  BOTH cycle rules. Group 4–7 and the single-model rows are the bar for the record, not gated.

Enough events. A gated cell needs ≥ 300 test resort-days with ≥ 10 mm observed and ≥ 10 resorts. At CSI ≈ 0.5,
300 events give a paired-difference 90% range of roughly ±0.02 to ±0.03, enough to see the +0.02 to +0.03 gains
that would matter. With fewer, the verdict is INSUFFICIENT, not FAIL, and nothing is claimed. A per-lead cell
(A3) with < 100 events is reported as thin and cannot fail A3.

Reported but NOT gated: ≥ 20 mm, MAE, volume (Σfc ÷ Σobs), frequency bias, NBM bias-corrected by the v2 factors,
NBM's v2 weight by lead, and coverage by resort and region. Nothing reported but not gated is a claim.

Product caveat (known before running): the train winter is NBM v4.2 (operational 2024-05-15), the test winter
is v4.3 (May 2025; no core QPF change), and NBM went to v5.0 on about 2026-05-05 (QPF weighting, winter
suite and inputs changed). A pass here describes v4.3, not the v5.0 NBM now being collected live. Any rollout
must re-check on live v5.0 pairs first.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import blend as B  # noqa: E402

LEADS = tuple(range(1, 8))
GROUPS = {"1-3": (1, 2, 3), "4-7": (4, 5, 6, 7)}
THR = (2.5, 10.0, 20.0)
OM = ("ecmwf_ifs025", "gem_seamless", "gfs_seamless")
RULES = ("latest", "earliest")
SEED, N_BOOT, BLOCK_DAYS = 20261124, 1000, 7
MIN_EVENTS, MIN_RESORTS, THIN_LEAD = 300, 10, 100
NBM_FROM, NBM_TO = "2024-11-01", "2026-05-01"
WINTER = "month(local_date) IN (11, 12, 1, 2, 3, 4)"
BASE = ("space = 'liquid' AND pair_quality = 'strict' AND tier = 'mid' AND obs IS NOT NULL AND fc_amount IS NOT NULL "
        f"AND split IN ('train', 'test') AND lead_day BETWEEN 1 AND 7 AND {WINTER}")


class Leak(SystemExit):
    pass


def leakage(con, pairs: Path) -> dict:
    """Every NBM row in range must be issued before its local day starts and be a 00z/12z cycle. Loud, never filtered."""
    r = con.execute(f"""
      SELECT count(*), count(*) FILTER (WHERE lead_hours IS NULL OR lead_hours <= 0),
             count(*) FILTER (WHERE hour(issue_ts) NOT IN (0, 12) OR minute(issue_ts) <> 0),
             count(*) FILTER (WHERE issue_ts IS NULL),
             min(lead_hours), count(DISTINCT strftime(issue_ts, '%Y%m%d%H'))
      FROM read_parquet('{pairs}')
      WHERE source = 'nbm' AND {BASE} AND (issue_ts IS NULL OR (issue_ts >= TIMESTAMP '{NBM_FROM}' AND issue_ts < TIMESTAMP '{NBM_TO}'))""").fetchone()
    out = dict(zip(("rows", "not_before_day", "bad_cycle", "no_issue_time", "min_lead_hours", "cycles"), r))
    if out["rows"] == 0:
        raise SystemExit("blend_nbm: no NBM pairs in 2024-11 → 2026-04. Has verify run since the backfill?")
    if out["not_before_day"] or out["bad_cycle"] or out["no_issue_time"]:
        raise Leak(f"blend_nbm: LEAKAGE CHECK FAILED {out}")
    return out


def base(con, pairs: Path, rule: str) -> None:
    order = "DESC" if rule == "latest" else "ASC"
    con.execute(f"""
    CREATE OR REPLACE TABLE raw AS
    SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date, lead_day AS lead, split,
           fc_amount AS fc, obs
    FROM read_parquet('{pairs}') WHERE source = '{B.SOURCE}' AND {BASE}
    UNION ALL
    SELECT 'nbm', region, resort_id, local_date, lead_day, split, fc_amount, obs FROM (
      SELECT * FROM read_parquet('{pairs}')
      WHERE source = 'nbm' AND {BASE} AND issue_ts >= TIMESTAMP '{NBM_FROM}' AND issue_ts < TIMESTAMP '{NBM_TO}'
        AND hour(issue_ts) IN (0, 12) AND lead_hours > 0
      QUALIFY row_number() OVER (PARTITION BY resort_id, local_date, lead_day ORDER BY issue_ts {order}) = 1)""")
    con.execute("""CREATE OR REPLACE TABLE both4 AS
                   SELECT resort_id, local_date, lead FROM raw GROUP BY ALL
                   HAVING count(DISTINCT model) = 4 AND bool_or(model = 'nbm')""")
    con.execute("CREATE OR REPLACE TABLE r4 AS SELECT raw.* FROM raw JOIN both4 USING (resort_id, local_date, lead)")


def fitted(con, models):
    c = duckdb.connect()
    c.register("rows_df", con.execute(f"SELECT * FROM r4 WHERE model IN {tuple(models)}").fetchdf())
    c.execute("CREATE TABLE d AS SELECT * FROM rows_df")
    p = B.fit(c)
    c.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    c.executemany("INSERT INTO w VALUES (?, ?, ?)", [(int(l), m, v) for l, ws in p["weights"].items() for m, v in ws.items()])
    t = c.execute("""SELECT resort_id, local_date, lead, any_value(obs) AS obs, sum(w.w * fcc) / sum(w.w) AS fc
                     FROM dc JOIN w USING (lead, model) WHERE split = 'test' GROUP BY ALL""").fetchdf()
    nc = c.execute("SELECT resort_id, local_date, lead, obs, fcc AS fc FROM dc WHERE split = 'test' AND model = 'nbm'").fetchdf() \
        if "nbm" in models else None
    return p, t, nc


def table(named: dict, leads, rng, pairs_of: list[tuple[str, str]]) -> dict:
    """CSI etc. per forecast on the common keys at `leads`, and bootstrap ranges of a − b for each (a, b) in pairs_of."""
    ks = None
    fr = {}
    for n, df in named.items():
        k = df[df.lead.isin(leads)].set_index(["resort_id", "local_date", "lead"])
        fr[n] = k
        ks = k.index if ks is None else ks.intersection(k.index)
    ks = ks.sort_values()
    first = next(iter(fr))
    obs = fr[first].loc[ks, "obs"].to_numpy()
    dates = np.array([np.datetime64(d, "D") for _, d, _ in ks])
    blocks = ((dates - np.datetime64("2024-07-01")).astype(int) // BLOCK_DAYS) if len(dates) else dates
    ub, inv = np.unique(blocks, return_inverse=True)
    idx = rng.integers(0, len(ub), size=(N_BOOT, len(ub))) if len(ub) else None
    res = {"days": int(len(obs)), "resorts": int(len({r for r, _, _ in ks})), "thr": {}}
    for thr in THR:
        o = obs >= thr
        row = {"events": int(o.sum()), "csi": {}, "pod": {}, "far": {}, "bias": {}, "diff": {}}
        boots = {}
        for n, k in fr.items():
            f = k.loc[ks, "fc"].to_numpy() >= thr
            h, fa, m = B.csi_counts(f, o, inv, len(ub))
            H, FA, M = h.sum(), fa.sum(), m.sum()
            row["csi"][n] = float(H / max(H + M + FA, 1))
            row["pod"][n] = float(H / max(H + M, 1))
            row["far"][n] = float(FA / max(H + FA, 1))
            row["bias"][n] = float((H + FA) / max(H + M, 1))
            if idx is not None:
                bh, bfa, bm = h[idx].sum(1), fa[idx].sum(1), m[idx].sum(1)
                boots[n] = bh / np.maximum(bh + bm + bfa, 1)
        for a, b in pairs_of:
            if idx is None:
                continue
            d = boots[a] - boots[b]
            row["diff"][f"{a} - {b}"] = {"d": row["csi"][a] - row["csi"][b],
                                         "p05": float(np.percentile(d, 5)), "p95": float(np.percentile(d, 95))}
        res["thr"][str(thr)] = row
    res["mae"] = {n: float(np.mean(np.abs(k.loc[ks, "fc"].to_numpy() - obs))) if len(obs) else None for n, k in fr.items()}
    res["volume"] = {n: float(k.loc[ks, "fc"].sum() / max(obs.sum(), 1e-9)) for n, k in fr.items()}
    return res


def enough(t: dict) -> bool:
    return t["thr"]["10.0"]["events"] >= MIN_EVENTS and t["resorts"] >= MIN_RESORTS


def gate_a(pooled: dict, per_lead: dict) -> dict:
    c10, c25 = pooled["thr"]["10.0"]["diff"]["v2 - v1"], pooled["thr"]["2.5"]["diff"]["v2 - v1"]
    a3_bad = [l for l, t in per_lead.items()
              if t["thr"]["10.0"]["events"] >= THIN_LEAD and t["thr"]["10.0"]["diff"]["v2 - v1"]["p95"] < 0]
    g = {"A1": c10["p05"] > 0, "A2": c25["p05"] > -0.02, "A3": not a3_bad, "A3_worse_leads": a3_bad,
         "A1_p05": c10["p05"], "A2_p05": c25["p05"], "events_10mm": pooled["thr"]["10.0"]["events"],
         "resorts": pooled["resorts"], "enough": enough(pooled)}
    g["pass"] = g["enough"] and g["A1"] and g["A2"] and g["A3"]
    return g


def verdict_b(t: dict, x: str) -> str:
    c10, c25 = t["thr"]["10.0"]["diff"][f"nbm raw - {x}"], t["thr"]["2.5"]["diff"][f"nbm raw - {x}"]
    if not enough(t):
        return "insufficient"
    if c10["p05"] > 0 and c25["p05"] > -0.02:
        return "NBM beats"
    if c10["p95"] < 0:
        return "beats NBM"
    return "no clear difference"


def coverage(con, pairs: Path) -> list:
    return con.execute(f"""
      WITH n AS (SELECT resort_id, any_value(region) region,
                        count(DISTINCT local_date) FILTER (WHERE split = 'train') AS nbm_train_days,
                        count(DISTINCT local_date) FILTER (WHERE split = 'test') AS nbm_test_days
                 FROM read_parquet('{pairs}') WHERE source = 'nbm' AND {BASE}
                   AND issue_ts >= TIMESTAMP '{NBM_FROM}' AND issue_ts < TIMESTAMP '{NBM_TO}' AND lead_day = 1 GROUP BY 1),
           o AS (SELECT resort_id, any_value(region) region,
                        count(DISTINCT local_date) FILTER (WHERE split = 'test') AS om_test_days
                 FROM read_parquet('{pairs}') WHERE source = '{B.SOURCE}' AND {BASE} AND lead_day = 1 GROUP BY 1),
           a AS (SELECT DISTINCT resort_id, region FROM read_parquet('{pairs}') WHERE source = 'nbm' AND space = 'liquid')
      SELECT coalesce(o.resort_id, n.resort_id, a.resort_id) AS resort_id,
             coalesce(o.region, n.region, a.region) AS region,
             coalesce(n.nbm_train_days, 0), coalesce(n.nbm_test_days, 0), coalesce(o.om_test_days, 0)
      FROM o FULL JOIN n USING (resort_id) FULL JOIN a USING (resort_id) ORDER BY 2, 1""").fetchall()


def fmt_row(label: str, t: dict, names: list, diffs: list) -> list:
    out = []
    for thr in THR:
        r = t["thr"][str(thr)]
        out.append(f"| {label} | {thr:g} | {t['days']} | {r['events']} | " + " | ".join(f"{r['csi'][n]:.3f}" for n in names) +
                   " | " + " | ".join(f"{r['diff'][d]['d']:+.3f} ({r['diff'][d]['p05']:+.3f} to {r['diff'][d]['p95']:+.3f})"
                                     for d in diffs) + " |")
    return out


def main(pairs: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    leak = leakage(con, pairs)
    L = ["# NBM: fourth blend member and standalone US bar (plan-near-term-models-2026-11-22, step 3)\n",
         "Gate pre-registered in scripts/model/blend_nbm.py (committed before any result). Fit 2024-25, judged 2025-26, "
         "Nov–Apr, strict SNOTEL/BC pairs, mid tier, water. Same resort-day-leads for every column (ECMWF, GFS, GEM and "
         "NBM all present). CSI: 1 perfect, 0 useless. Ranges are 90% bootstraps over 7-day date blocks.\n",
         f"Leakage check (every NBM row 2024-11 → 2026-04, all leads 1–7): {leak['rows']:,} rows from {leak['cycles']:,} "
         f"cycles. Issued at/after the local day start: {leak['not_before_day']}. Not 00z/12z: {leak['bad_cycle']}. "
         f"No issue time: {leak['no_issue_time']}. Minimum lead to day start: {leak['min_lead_hours']:.1f} h. **PASS**\n"]
    result = {"leakage": leak, "rules": {}}
    for rule in RULES:
        rng = np.random.default_rng(SEED)
        base(con, pairs, rule)
        ntr, nte = con.execute("""SELECT count(*) FILTER (WHERE split = 'train'), count(*) FILTER (WHERE split = 'test')
                                  FROM (SELECT DISTINCT resort_id, local_date, lead, split FROM r4)""").fetchone()
        nres = con.execute("SELECT count(DISTINCT resort_id) FROM r4").fetchone()[0]
        L.append(f"\n## Cycle rule `{rule}`: {ntr:,} train and {nte:,} test resort-day-leads, {nres} resorts\n")
        if not ntr or not nte:
            L.append("**No common days in train or test: nothing to judge.**\n")
            result["rules"][rule] = {"error": "no common days"}
            continue
        p1, t1, _ = fitted(con, OM)
        p2, t2, nc = fitted(con, OM + ("nbm",))
        raw = con.execute("SELECT resort_id, local_date, lead, obs, model, fc FROM r4 WHERE split = 'test'").fetchdf()
        named = {"v1": t1, "v2": t2}
        for m in ("nbm",) + OM:
            named[f"{m} raw"] = raw[raw.model == m][["resort_id", "local_date", "lead", "obs", "fc"]]
        named["nbm corrected"] = nc
        names = list(named)
        L.append("NBM weight in v2 by lead: " + ", ".join(f"{l}: {p2['weights'].get(str(l), {}).get('nbm', 0):.2f}" for l in LEADS) + "\n")
        # (a)
        da = [("v2", "v1")]
        pooled = table({k: v.copy() for k, v in named.items()}, GROUPS["1-3"], rng, da)
        per = {str(l): table({k: v.copy() for k, v in named.items()}, (l,), rng, da) for l in GROUPS["1-3"]}
        ga = gate_a(pooled, per)
        L.append("### (a) NBM as a fourth member, leads 1–3\n")
        L.append("| leads | ≥ mm | days | events | " + " | ".join(names) + " | v2 − v1 (90% range) |")
        L.append("|---|---|---|---|" + "---|" * len(names) + "---|")
        L += fmt_row("1-3", pooled, names, ["v2 - v1"])
        for l, t in per.items():
            L += fmt_row(l, t, names, ["v2 - v1"])
        L.append(f"\nA1 (≥10 mm 5th pct > 0): {ga['A1_p05']:+.3f} → {'yes' if ga['A1'] else 'no'}. "
                 f"A2 (≥2.5 mm 5th pct > −0.02): {ga['A2_p05']:+.3f} → {'yes' if ga['A2'] else 'no'}. "
                 f"A3 (no lead clearly worse at 10 mm): {'yes' if ga['A3'] else 'no, worse at lead ' + ','.join(ga['A3_worse_leads'])}. "
                 f"Events ≥10 mm: {ga['events_10mm']} over {ga['resorts']} resorts ({'enough' if ga['enough'] else 'NOT ENOUGH, verdict INSUFFICIENT'}).\n")
        thin = [l for l, t in per.items() if t["thr"]["10.0"]["events"] < THIN_LEAD]
        if thin:
            L.append(f"Thin leads (< {THIN_LEAD} events at 10 mm, cannot fail A3): {', '.join(thin)}\n")
        # (b)
        db = [("nbm raw", x) for x in ("v1",) + tuple(f"{m} raw" for m in OM)]
        L.append("### (b) NBM alone (raw, as issued) vs blend-v1 and each single model\n")
        bt, vb = {}, {}
        dn = [f"{a} - {b}" for a, b in db]
        L.append("| leads | ≥ mm | days | events | " + " | ".join(names) + " | " + " | ".join(dn) + " |")
        L.append("|---|---|---|---|" + "---|" * (len(names) + len(dn)))
        for g, leads in GROUPS.items():
            t = table({k: v.copy() for k, v in named.items()}, leads, rng, db)
            bt[g] = t
            vb[g] = {x: verdict_b(t, x) for _, x in db}
            L += fmt_row(g, t, names, dn)
        for g in GROUPS:
            L.append(f"\nLeads {g}: " + "; ".join(f"vs {x}: **{v}**" for x, v in vb[g].items()) +
                     f" (events ≥10 mm {bt[g]['thr']['10.0']['events']}, {bt[g]['resorts']} resorts)")
        L.append("\nFrequency bias at 10 mm (1 = right number of events), leads 1-3: " +
                 ", ".join(f"{n} {bt['1-3']['thr']['10.0']['bias'][n]:.2f}" for n in names))
        for g in GROUPS:
            L.append(f"\nMAE mm, leads {g}: " + ", ".join(f"{k} {v:.2f}" for k, v in bt[g]["mae"].items()))
            L.append(f"\nVolume (Σfc ÷ Σobs), leads {g}: " + ", ".join(f"{k} {v:.2f}" for k, v in bt[g]["volume"].items()) + "\n")
        result["rules"][rule] = {"weights_v1": p1["weights"], "weights_v2": p2["weights"], "factors_v2_nbm":
                                 {k: v for k, v in p2["factors"].items() if k.startswith("nbm|")},
                                 "a": {"pooled": pooled, "per_lead": per, "gate": ga},
                                 "b": {"groups": bt, "verdicts": vb}, "n_train": ntr, "n_test": nte, "resorts": nres}
    # verdicts
    R = result["rules"]
    ok = all("error" not in R.get(r, {"error": 1}) for r in RULES)
    if ok:
        ga_l, ga_e = R["latest"]["a"]["gate"], R["earliest"]["a"]["gate"]
        if not (ga_l["enough"] and ga_e["enough"]):
            va = "INSUFFICIENT"
        elif ga_l["pass"] and ga_e["pass"]:
            va = "PASS"
        elif ga_l["pass"]:
            va = "FRESHNESS-ONLY (passes under latest, not earliest): not passed"
        else:
            va = "FAIL"
        vl, ve = R["latest"]["b"]["verdicts"]["1-3"]["v1"], R["earliest"]["b"]["verdicts"]["1-3"]["v1"]
        if "insufficient" in (vl, ve):
            vbv = "INSUFFICIENT"
        elif vl == ve == "NBM beats":
            vbv = "PASS"
        elif vl == "NBM beats":
            vbv = "FRESHNESS-ONLY: not passed"
        else:
            vbv = f"FAIL (latest: {vl}; earliest: {ve})"
    else:
        va = vbv = "NO DATA"
    result["verdict"] = {"a_member": va, "b_standalone": vbv}
    L.insert(3, f"\n## Verdict\n\n**(a) NBM as a fourth member, leads 1–3: {va}.**\n\n"
                f"**(b) NBM alone beats blend-v1 at leads 1–3: {vbv}.**\n\n"
                "Product caveat: train is NBM v4.2, test v4.3; live NBM is v5.0 since ~2026-05-05. "
                "Nothing here describes v5.0.\n")
    cov = coverage(con, pairs)
    result["coverage"] = [dict(zip(("resort_id", "region", "nbm_train_days", "nbm_test_days", "om_test_days"), c)) for c in cov]
    L.append("\n## Coverage by resort (strict mid-tier liquid pairs, Nov–Apr, lead 1, distinct days)\n")
    L.append("| resort | region | NBM train days | NBM test days | Open-Meteo test days |\n|---|---|---|---|---|")
    L += [f"| {a} | {b} | {c} | {d} | {e} |" for a, b, c, d, e in cov]
    no_nbm = [c[0] for c in cov if c[3] == 0 and c[4] > 0]
    L.append(f"\nResorts scored for blend-v1 but with no NBM test pairs: {', '.join(no_nbm) or 'none'}.\n")
    (out / "blend_nbm_report.md").write_text("\n".join(L) + "\n")
    (out / "blend_nbm.json").write_text(json.dumps(result, default=float, indent=1))
    print("\n".join(L))
    if va == "NO DATA":
        raise SystemExit("blend_nbm: NO DATA under at least one cycle rule; nothing judged")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
