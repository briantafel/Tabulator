#!/usr/bin/env python3
"""Ensemble-mean water, corrected on every past winter we have, and whether it earns a place in the blend.

    python3 scripts/model/ensmean.py <outDir>

Needs, from earlier verify steps:  <outDir>/truth_daily.parquet, <outDir>/pairs.parquet,
<outDir>/longrange_tmp/dyn-*.parquet  (longrange.py writes the last one; run this BEFORE it is deleted).

Why (Brian, 2026-11-22: "score five past winters instead of one"):
blend-v1 corrects ECMWF / GFS / GEM water from ONE winter, because Open-Meteo's Previous Runs only reach
back to Jan 2024. dynamical.org's GEFS goes back to 2020-21 and ECMWF ENS to 2024-25, and
longrange.py already collapses their members to a per-resort-day ensemble mean. An ensemble mean is
usually a better deterministic number than one run at days 3+, and a correction fitted on six
winters is far less likely to be one winter's quirk.

What this does (plain arithmetic, public models + public truth only, nothing paid):
1. Factor per model × lead × region = Σobs ÷ Σforecast, shrunk toward the pooled factor when a region has
   few wet days, clamped to [0.5, 2] (the same rule as blend.py).
2. LEAVE ONE WINTER OUT: each winter is corrected with factors fitted on all the OTHER winters. So every
   winter's score is out of sample, and no winter judges its own fit.
3. Judge raw vs corrected ensemble mean by yes/no hits (POD, FAR, CSI) at 2.5 / 10 / 20 mm of water per
   day, leads 1-7, plus volume ratio.
4. On the test winter (2025-26), the same resort-days: does adding the corrected ensemble means to the
   three deterministic models (each corrected on 2024-25, as blend-v1 does) beat the three alone?
   90% date-block bootstrap ranges on the CSI difference.

Promotion is NOT done here: the app reads nothing from this. Writes ensmean.json (factors fitted on every
winter, for a later blend-v2) and ensmean_report.md. Failures are loud: missing inputs, an empty join, or
a model with no history stop the run.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

ENS_MODELS = ("gefs", "ecmwf_ifs_ens")
DET_SOURCE = "open-meteo-previous-runs"
LEADS = range(1, 8)
SHRINK_DAYS = 40
CLAMP = (0.5, 2.0)
WET_MM = 1.0
THRESHOLDS = (2.5, 10.0, 20.0)
N_BOOT = 1000
SEED = 20261122
MIN_EVENTS = 20


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def winter_sql(col: str) -> str:
    return f"CASE WHEN month({col}) >= 7 THEN year({col}) ELSE year({col}) - 1 END"


def load_ens(con, out: Path) -> None:
    parts = sorted((out / "longrange_tmp").glob("dyn-*.parquet"))
    if not parts:
        raise SystemExit("ensmean: no longrange_tmp/dyn-*.parquet — run it right after longrange.py")
    fl = "[" + ", ".join(f"'{p}'" for p in parts) + "]"
    models = ", ".join(f"'dynamical-ens:{m}'" for m in ENS_MODELS)
    con.execute(f"""
    CREATE TABLE ens AS
    SELECT split_part(e.source_label, ':', 2) AS model, e.resort_id, t.region, e.lead_day AS lead, e.local_date,
           {winter_sql('e.local_date')} AS winter, e.mean AS fc, t.obs
    FROM read_parquet({fl}, union_by_name = true) e
    JOIN read_parquet('{out / 'truth_daily.parquet'}') t USING (resort_id, local_date)
    WHERE e.win = 24 AND e.source_label IN ({models}) AND e.lead_day BETWEEN 1 AND 7
      AND e.mean IS NOT NULL AND t.obs IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY e.source_label, e.resort_id, e.local_date, e.lead_day
                               ORDER BY e.issue_key DESC) = 1""")
    n = con.execute("SELECT count(*) FROM ens").fetchone()[0]
    if not n:
        raise SystemExit("ensmean: ensemble means joined to no truth days")
    for m, w, k in con.execute("SELECT model, winter, count(*) FROM ens GROUP BY ALL ORDER BY ALL").fetchall():
        log(f"ensmean: {m} winter {w}: {k:,} resort-days")


def fit_factors(rows: list[tuple]) -> tuple[dict, dict]:
    """rows: (lead, region, sum_obs, sum_fc, wet_days) → (region factors, pooled factors)."""
    pooled: dict[int, float] = {}
    by_lead: dict[int, list] = {}
    for lead, region, so, sf, wet in rows:
        by_lead.setdefault(lead, []).append((region, so, sf, wet))
    for lead, rs in by_lead.items():
        so, sf = sum(r[1] for r in rs), sum(r[2] for r in rs)
        pooled[lead] = float(np.clip(so / sf if sf > 0 else 1.0, *CLAMP))
    factors: dict[tuple, float] = {}
    for lead, rs in by_lead.items():
        for region, so, sf, wet in rs:
            raw = so / sf if sf > 0 else pooled[lead]
            w = wet / (wet + SHRINK_DAYS)
            factors[(lead, region)] = float(np.clip(w * raw + (1 - w) * pooled[lead], *CLAMP))
    return factors, pooled


def factor_rows(con, table: str, model: str, where: str) -> list[tuple]:
    return con.execute(f"""
      SELECT lead, region, sum(obs), sum(fc), sum(CAST(obs >= {WET_MM} AS INT))
      FROM {table} WHERE model = ? AND {where} GROUP BY ALL""", [model]).fetchall()


def lowo_correct(con) -> None:
    """ens_c: every winter corrected with factors fitted on the other winters of the same model."""
    con.execute("CREATE TABLE ens_c AS SELECT *, CAST(NULL AS DOUBLE) AS fcc FROM ens WHERE false")
    for model in ENS_MODELS:
        winters = [r[0] for r in con.execute("SELECT DISTINCT winter FROM ens WHERE model = ? ORDER BY 1", [model]).fetchall()]
        if len(winters) < 2:
            raise SystemExit(f"ensmean: {model} has {len(winters)} winter(s); leave-one-winter-out needs at least 2")
        for w in winters:
            factors, pooled = fit_factors(factor_rows(con, "ens", model, f"winter <> {w}"))
            cur = con.execute("SELECT * FROM ens WHERE model = ? AND winter = ?", [model, w]).fetchall()
            cols = [c[0] for c in con.description]
            ix = {c: i for i, c in enumerate(cols)}
            ins = []
            for r in cur:
                f = factors.get((r[ix["lead"]], r[ix["region"]]), pooled.get(r[ix["lead"]], 1.0))
                ins.append(tuple(r) + (r[ix["fc"]] * f,))
            con.executemany("INSERT INTO ens_c VALUES (" + ", ".join("?" * (len(cols) + 1)) + ")", ins)


def counts(f: np.ndarray, o: np.ndarray, t: float) -> tuple[int, int, int]:
    ff, oo = f >= t, o >= t
    return int((ff & oo).sum()), int((~ff & oo).sum()), int((ff & ~oo).sum())


def csi(h: float, m: float, fa: float) -> float | None:
    d = h + m + fa
    return h / d if d else None


def md_table(header: list[str], rows: list[list]) -> str:
    def fmt(v):
        if v is None:
            return "-"
        return f"{v:.2f}" if isinstance(v, float) else str(v)
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]
    return "\n".join(out)


def judge_ens(con) -> tuple[str, list[dict]]:
    """Raw vs leave-one-winter-out corrected ensemble mean, per model and winter, leads 1-3 and 4-7."""
    rows, summary = [], []
    for model in ENS_MODELS:
        for (w,) in con.execute("SELECT DISTINCT winter FROM ens_c WHERE model = ? ORDER BY 1", [model]).fetchall():
            for lo, hi in ((1, 3), (4, 7)):
                d = con.execute("""SELECT fc, fcc, obs FROM ens_c WHERE model = ? AND winter = ? AND lead BETWEEN ? AND ?""",
                                [model, w, lo, hi]).fetchall()
                if not d:
                    continue
                a = np.array(d, dtype=float)
                for t in THRESHOLDS:
                    ev = int((a[:, 2] >= t).sum())
                    hr, mr, fr = counts(a[:, 0], a[:, 2], t)
                    hc, mc, fc_ = counts(a[:, 1], a[:, 2], t)
                    cr, cc = csi(hr, mr, fr), csi(hc, mc, fc_)
                    rows.append([model, f"{w}-{str(w + 1)[2:]}", f"{lo}-{hi}", t, ev,
                                 cr, cc, None if cr is None or cc is None else cc - cr,
                                 float(a[:, 0].sum() / max(a[:, 2].sum(), 1e-9)), float(a[:, 1].sum() / max(a[:, 2].sum(), 1e-9)),
                                 "thin" if ev < MIN_EVENTS else ""])
                    summary.append({"model": model, "winter": w, "leads": f"{lo}-{hi}", "t": t, "events": ev,
                                    "csi_raw": cr, "csi_corr": cc})
    hdr = ["model", "winter", "leads", "mm/day", "events", "CSI raw", "CSI corrected", "gain", "volume raw", "volume corrected", ""]
    return md_table(hdr, rows), summary


def load_det(con, out: Path) -> None:
    """Deterministic models on the test winter, with blend-v1-style factors fitted on the train winter only."""
    con.execute(f"""
    CREATE TABLE det AS
    SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date, lead_day AS lead, split,
           fc_amount AS fc, obs
    FROM read_parquet('{out / 'pairs.parquet'}')
    WHERE source = '{DET_SOURCE}' AND space = 'liquid' AND pair_quality = 'strict' AND tier = 'mid'
      AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day BETWEEN 1 AND 7 AND split IN ('train', 'test')""")
    models = [r[0] for r in con.execute("SELECT DISTINCT model FROM det ORDER BY 1").fetchall()]
    if not models:
        raise SystemExit("ensmean: no deterministic model rows in pairs.parquet")
    con.execute("CREATE TABLE det_c AS SELECT *, CAST(NULL AS DOUBLE) AS fcc FROM det WHERE false")
    for m in models:
        factors, pooled = fit_factors(factor_rows(con, "det", m, "split = 'train'"))
        cur = con.execute("SELECT * FROM det WHERE model = ? AND split = 'test'", [m]).fetchall()
        cols = [c[0] for c in con.description]
        ix = {c: i for i, c in enumerate(cols)}
        ins = [tuple(r) + (r[ix["fc"]] * factors.get((r[ix["lead"]], r[ix["region"]]), pooled.get(r[ix["lead"]], 1.0)),) for r in cur]
        con.executemany("INSERT INTO det_c VALUES (" + ", ".join("?" * (len(cols) + 1)) + ")", ins)


def judge_blend(con) -> tuple[str, list[dict]]:
    """Same resort-days: three deterministic models (corrected) vs the same plus the corrected ensemble means."""
    test_w = con.execute("SELECT min(winter) FROM ens_c WHERE model = 'gefs' AND winter = 2025").fetchone()[0]
    if test_w is None:
        raise SystemExit("ensmean: no 2025-26 ensemble days to judge the blend on")
    con.execute("""
    CREATE TABLE cmp AS
    SELECT d.resort_id, d.local_date, d.lead, any_value(d.obs) AS obs,
           avg(d.fcc) AS det3, count(DISTINCT d.model) AS n_det,
           any_value(g.fcc) AS gefs
    FROM det_c d
    JOIN (SELECT * FROM ens_c WHERE model = 'gefs' AND winter = 2025) g USING (resort_id, local_date, lead)
    GROUP BY d.resort_id, d.local_date, d.lead
    HAVING n_det >= 3""")
    n = con.execute("SELECT count(*) FROM cmp").fetchone()[0]
    if not n:
        raise SystemExit("ensmean: deterministic models and ensemble means share no test-winter days")
    rng = np.random.default_rng(SEED)
    rows, summary = [], []
    for lo, hi in ((1, 3), (4, 7)):
        d = con.execute("""SELECT local_date, obs, det3, gefs, (det3 * 3 + gefs) / 4 AS plus1
                           FROM cmp WHERE lead BETWEEN ? AND ?""", [lo, hi]).fetchall()
        if not d:
            continue
        dates = np.array([r[0] for r in d])
        udates = np.unique(dates)
        obs = np.array([r[1] for r in d], dtype=float)
        sets = {"3 models": np.array([r[2] for r in d], dtype=float),
                "GEFS mean alone": np.array([r[3] for r in d], dtype=float),
                "3 models + GEFS mean": np.array([r[4] for r in d], dtype=float)}
        idx_by_date = {u: np.where(dates == u)[0] for u in udates}
        for t in THRESHOLDS:
            ev = int((obs >= t).sum())
            base = csi(*counts(sets["3 models"], obs, t))
            for name, f in sets.items():
                h, m, fa = counts(f, obs, t)
                row = [f"{lo}-{hi}", t, name, ev, csi(h, m, fa), h / ev if ev else None, fa / (h + fa) if h + fa else None]
                if name == "3 models + GEFS mean":
                    # date-block bootstrap: all resorts on a date move together
                    gains = []
                    for _ in range(N_BOOT):
                        pick = np.concatenate([idx_by_date[u] for u in rng.choice(udates, len(udates))])
                        c1, c0 = csi(*counts(f[pick], obs[pick], t)), csi(*counts(sets["3 models"][pick], obs[pick], t))
                        if c1 is not None and c0 is not None:
                            gains.append(c1 - c0)
                    lo90, hi90 = (float(np.percentile(gains, 5)), float(np.percentile(gains, 95))) if gains else (None, None)
                    g = (csi(h, m, fa) or 0.0) - (base or 0.0)
                    row += [g, lo90, hi90]
                    summary.append({"leads": f"{lo}-{hi}", "t": t, "events": ev, "gain": g, "lo": lo90, "hi": hi90})
                else:
                    row += [None, None, None]
                rows.append(row)
    hdr = ["leads", "mm/day", "forecast", "events", "CSI", "POD", "FAR", "gain vs 3", "90% low", "90% high"]
    return md_table(hdr, rows) + f"\n\n({n:,} lead-day pairs on 2025-26; weights equal, deterministic factors fitted on 2024-25 as in blend-v1; ensemble means corrected on the other winters.)", summary


def write_factors(con, out: Path) -> None:
    res = {}
    for model in ENS_MODELS:
        factors, pooled = fit_factors(factor_rows(con, "ens", model, "true"))
        res[model] = {"pooled": {str(k): round(v, 3) for k, v in pooled.items()},
                      "region": {f"{lead}|{region}": round(v, 3) for (lead, region), v in factors.items()}}
        winters = [r[0] for r in con.execute("SELECT DISTINCT winter FROM ens WHERE model = ? ORDER BY 1", [model]).fetchall()]
        res[model]["winters"] = winters
    (out / "ensmean.json").write_text(json.dumps({"version": "ensmean-v1", "factors": res}, indent=1))


def main(out: Path) -> None:
    for need in ("truth_daily.parquet", "pairs.parquet"):
        if not (out / need).exists():
            raise SystemExit(f"ensmean: {out / need} missing — run build.py first")
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    load_ens(con, out)
    lowo_correct(con)
    ens_tbl, _ = judge_ens(con)
    load_det(con, out)
    blend_tbl, summary = judge_blend(con)
    write_factors(con, out)
    helped = [s for s in summary if s["lo"] is not None and s["lo"] > 0 and s["events"] >= MIN_EVENTS]
    hurt = [s for s in summary if s["hi"] is not None and s["hi"] < 0 and s["events"] >= MIN_EVENTS]
    verdict = (f"Adding the corrected GEFS mean beat the three models alone in {len(helped)} of {len(summary)} cells "
               f"(90% range above zero) and was worse in {len(hurt)}. ")
    verdict += ("Worth building into a blend-v2 behind a switch." if helped and not hurt else
                "Not enough to ship: keep blend-v1." if not helped else "Mixed: look cell by cell before promoting anything.")
    report = "\n".join([
        "# Ensemble-mean water, corrected on every past winter (ensmean-v1)",
        "",
        "Public models and public truth only. Liquid water at the SNOTEL gauge, strict mid-tier pairs, leads 1-7.",
        "Each winter is corrected with factors fitted on the OTHER winters (leave one winter out).",
        "",
        "## Raw vs corrected ensemble mean, by winter",
        "", ens_tbl, "",
        "## Does it help the blend? (test winter 2025-26, same resort-days)",
        "", blend_tbl, "",
        "## Verdict", "", verdict, "",
        "Nothing here is read by the app. ensmean.json holds the factors fitted on every winter, for a later blend-v2.",
    ])
    if "snow-forecast" in report.lower() or "(paid)" in report.lower():
        raise SystemExit("ensmean: the report names a paid source")
    (out / "ensmean_report.md").write_text(report + "\n")
    log("ensmean: wrote ensmean_report.md and ensmean.json")
    log(verdict)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]))
