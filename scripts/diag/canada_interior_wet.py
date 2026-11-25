#!/usr/bin/env python3
"""Does blend-v1 over-forecast water in the Kootenays and Canadian Rockies? (2026-11-25, Opus 5.5)

    python3 scripts/diag/canada_interior_wet.py <pairs.parquet> <eccc_truth.parquet> <outDir>

Report only: no change to the app, the blend, build.py or any switch. Public models and public truth only (Open-Meteo,
NBM, HRRR, HRDPS; BC ASWS pillows, ECCC gauges, resort-reported new snow). Writes canada_interior_wet.md / .json.

Why: at Panorama the live blend was about 3x NBM (1.42 in vs 0.47 in, 2026-11-23). NBM has no history there, so the
past winters cannot say whether NBM is right, but they can say whether blend-v1 runs wet in this part of Canada.
blend-v1's "Canada" region factors (ECMWF x1.44 at lead 1) were fitted on the few Canadian resorts with strict pairs,
which may not describe the interior.

PRE-REGISTERED RULE, written and committed 2026-11-25 BEFORE any number below was computed
==========================================================================================
Resorts (the pool): panorama, kimberley, fernie, kicking-horse, norquay, sunshine, lake-louise, marmot. Each is also
shown on its own; nothing is hidden by pooling. Mid tier. Leads 1-3 pooled (lead 1 shown too). Nov-Apr local days.

blend-v1 = the PUBLISHED public/blend.json (weights by lead, factor model|lead|region, else pooled factor), applied to
Open-Meteo Previous Runs ecmwf_ifs025 / gfs_seamless / gem_seamless water; a missing model is dropped and the weights
re-normalised (never zero). Judged in each of 2024-25 and 2025-26. These resorts are not in v1's strict-pair fit unless
the report's coverage table shows strict pairs for them; it says which.

Truth types (each judged separately; missing is never zero; a station with no value that day is dropped):
  SWE    BC ASWS pillow daily SWE gain paired by verify (truth_source bc-asws, any pair quality, station <= 40 km).
  GAUGE  ECCC daily total precipitation: per resort the candidate station with the lowest km/25 + |delev|/300 that
         has >= 60% coverage, station <= 40 km (eccc_truth.parquet; flags already applied by verify). Valley gauges
         under-catch snow (20-50%), so their bar is wider.
  REPORT resort-reported new snow (OnTheSnow, verify's next-day rule), in cm, against v1 water x the published SLR
         (public/slr.json, the app's daily rule: 0 above 2 C, the clamped line, the warm cap where promoted) at the
         mean of the three models' day temperature. Reports and the ratio are both uncertain, so its bar is wider.

Statistic: volume ratio V = sum(v1) / sum(obs) over resort-day-leads with both present, 90% bootstrap over 7-day date
blocks (1000 resamples, fixed seed). Per truth type and winter:
  SWE    TOO WET if V 5th pct > 1.20;  TOO DRY if V 95th pct < 0.80
  GAUGE  TOO WET if V 5th pct > 1.50;  TOO DRY if V 95th pct < 0.80
  REPORT TOO WET if V 5th pct > 1.50;  TOO DRY if V 95th pct < 0.67
  otherwise NO CLEAR BIAS.
Enough data: a truth type x winter is USABLE only with >= 60 resort-days at lead 1 with obs >= 2.5 mm (REPORT: >= 5 cm)
over >= 3 resorts; else INSUFFICIENT and it claims nothing.

Answer per winter: TOO WET if >= 2 usable truth types say TOO WET and none says TOO DRY; NOT TOO WET if >= 2 usable
types say NO CLEAR BIAS or TOO DRY and none says TOO WET; fewer than 2 usable types -> INSUFFICIENT; else MIXED.
Final answer: the two winters' answers if they agree; WINTER-DEPENDENT if both are decided and differ; otherwise
whatever was decided, marked as one winter only.

Reported, NOT gated (no claim): Panorama on its own; each raw model's V; v1 with the pooled (all-region) factors
instead of the Canada factor (is the Canada factor the cause?); frequency bias and CSI at 10 mm / 10 cm; the live
2026-27 season so far, v1 vs NBM vs HRRR vs HRDPS vs truth on common days (thin, ranges not meaningful with < 4 weeks).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import duckdb
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "maps"))
import anchor  # noqa: E402  (the app's daily SLR rule, twin of blend/lib.js)

POOL = ("panorama", "kimberley", "fernie", "kicking-horse", "norquay", "sunshine", "lake-louise", "marmot")
OM = ("ecmwf_ifs025", "gfs_seamless", "gem_seamless")
SOURCE = "open-meteo-previous-runs"
LEADS = (1, 2, 3)
WINTERS = {2024: "2024-25", 2025: "2025-26"}
MAX_KM, MIN_COV = 40.0, 0.60
BARS = {"SWE": (1.20, 0.80), "GAUGE": (1.50, 0.80), "REPORT": (1.50, 0.67)}
EVENT = {"SWE": 2.5, "GAUGE": 2.5, "REPORT": 5.0}
HIT = {"SWE": 10.0, "GAUGE": 10.0, "REPORT": 10.0}
UNIT = {"SWE": "mm", "GAUGE": "mm", "REPORT": "cm"}
MIN_DAYS, MIN_RESORTS = 60, 3
N_BOOT, BLOCK_DAYS, SEED = 1000, 7, 20261125
WINTER_SQL = "month(local_date) IN (11, 12, 1, 2, 3, 4)"
POOL_SQL = "(" + ", ".join(f"'{r}'" for r in POOL) + ")"


def forecasts(con, pairs: Path, blend: dict) -> None:
    """One row per resort x local day x lead: v1 (published), v1 with pooled factors, each raw model, mean day temp."""
    con.execute(f"""
    CREATE TABLE om AS
    SELECT resort_id, any_value(region) AS region, split_part(source_label, ':', 2) AS model, lead_day AS lead, local_date,
           any_value(fc_amount) AS fc, avg(fc_temp_c) AS t
    FROM read_parquet('{pairs}')
    WHERE source = '{SOURCE}' AND space = 'liquid' AND tier = 'mid' AND fc_amount IS NOT NULL
      AND resort_id IN {POOL_SQL} AND lead_day BETWEEN 1 AND 7 AND {WINTER_SQL}
    GROUP BY resort_id, model, lead, local_date""")
    rows = []
    for k, f in blend["factors"].items():
        m, l, reg = k.split("|")
        rows.append((m, int(l), reg, f))
    con.execute("CREATE TABLE fac(model VARCHAR, lead INTEGER, region VARCHAR, f DOUBLE)")
    con.executemany("INSERT INTO fac VALUES (?, ?, ?, ?)", rows)
    con.execute("CREATE TABLE pool(model VARCHAR, lead INTEGER, f DOUBLE)")
    con.executemany("INSERT INTO pool VALUES (?, ?, ?)",
                    [(k.split("|")[0], int(k.split("|")[1]), v) for k, v in blend["pooled_factors"].items()])
    con.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO w VALUES (?, ?, ?)",
                    [(int(l), m, v) for l, ws in blend["weights"].items() for m, v in ws.items()])
    con.execute("""
    CREATE TABLE fcd AS
    SELECT o.resort_id, o.local_date, o.lead,
           sum(w.w * o.fc * coalesce(fac.f, pool.f, 1.0)) / sum(w.w) AS v1,
           sum(w.w * o.fc * coalesce(pool.f, 1.0)) / sum(w.w) AS v1_pooled,
           max(CASE WHEN o.model = 'ecmwf_ifs025' THEN o.fc END) AS ecmwf_ifs025,
           max(CASE WHEN o.model = 'gfs_seamless' THEN o.fc END) AS gfs_seamless,
           max(CASE WHEN o.model = 'gem_seamless' THEN o.fc END) AS gem_seamless,
           avg(o.t) AS t, count(*) AS n_models,
           CASE WHEN month(o.local_date) >= 7 THEN year(o.local_date) ELSE year(o.local_date) - 1 END AS winter
    FROM om o JOIN w USING (lead, model)
    LEFT JOIN fac ON fac.model = o.model AND fac.lead = o.lead AND fac.region = o.region
    LEFT JOIN pool ON pool.model = o.model AND pool.lead = o.lead
    GROUP BY o.resort_id, o.local_date, o.lead""")


def truths(con, pairs: Path, eccc: Path) -> dict:
    """Truth tables (resort_id, local_date, obs) per type, plus which station each resort used."""
    con.execute(f"""
    CREATE TABLE swe_st AS
    SELECT resort_id, station_id, any_value(station_km) AS km, any_value(station_delev_m) AS delev,
           any_value(pair_quality) AS quality
    FROM read_parquet('{pairs}')
    WHERE truth_source = 'bc-asws' AND tier = 'mid' AND resort_id IN {POOL_SQL} AND station_km <= {MAX_KM}
    GROUP BY resort_id, station_id
    QUALIFY row_number() OVER (PARTITION BY resort_id ORDER BY km, station_id) = 1""")
    con.execute(f"""
    CREATE TABLE t_swe AS
    SELECT p.resort_id, p.local_date, any_value(p.obs_swe_gain_mm) AS obs
    FROM read_parquet('{pairs}') p JOIN swe_st s ON s.resort_id = p.resort_id AND s.station_id = p.station_id
    WHERE p.tier = 'mid' AND p.obs_swe_gain_mm IS NOT NULL AND {WINTER_SQL.replace('local_date', 'p.local_date')}
    GROUP BY p.resort_id, p.local_date""")
    con.execute(f"""
    CREATE TABLE gauge_st AS
    SELECT resort_id, station_id, any_value(station_name) AS name, any_value(station_km) AS km,
           any_value(station_delev_m) AS delev, any_value(coverage) AS coverage, any_value(strict) AS strict
    FROM read_parquet('{eccc}')
    WHERE resort_id IN {POOL_SQL} AND station_km <= {MAX_KM} AND coverage >= {MIN_COV}
    GROUP BY resort_id, station_id
    QUALIFY row_number() OVER (PARTITION BY resort_id ORDER BY km / 25 + abs(delev) / 300, station_id) = 1""")
    con.execute(f"""
    CREATE TABLE t_gauge AS
    SELECT e.resort_id, e.local_date, any_value(e.obs) AS obs
    FROM read_parquet('{eccc}') e JOIN gauge_st g ON g.resort_id = e.resort_id AND g.station_id = e.station_id
    WHERE e.obs IS NOT NULL AND {WINTER_SQL.replace('local_date', 'e.local_date')}
    GROUP BY e.resort_id, e.local_date""")
    con.execute(f"""
    CREATE TABLE t_report AS
    SELECT resort_id, local_date, any_value(ots_reported_cm) AS obs
    FROM read_parquet('{pairs}')
    WHERE resort_id IN {POOL_SQL} AND ots_reported_cm IS NOT NULL AND {WINTER_SQL}
    GROUP BY resort_id, local_date""")
    st = {"SWE": con.execute("SELECT * FROM swe_st ORDER BY resort_id").fetchall(),
          "GAUGE": con.execute("SELECT * FROM gauge_st ORDER BY resort_id").fetchall()}
    return st


def snow_cols(con, slr: dict) -> None:
    """REPORT space: every forecast column x the app's daily ratio at the models' mean day temperature, mm -> cm."""
    rows = con.execute("SELECT resort_id, local_date, lead, t FROM fcd").fetchall()
    out = []
    for rid, d, lead, t in rows:
        r = None if t is None else anchor.ratio(float(t), anchor.line_for(slr, rid), int(lead))
        out.append((rid, d, lead, r))
    con.execute("CREATE TABLE rat(resort_id VARCHAR, local_date DATE, lead INTEGER, r DOUBLE)")
    con.executemany("INSERT INTO rat VALUES (?, ?, ?, ?)", out)


FC_COLS = ("v1", "v1_pooled", "ecmwf_ifs025", "gfs_seamless", "gem_seamless")


def joined(con, kind: str):
    tbl = {"SWE": "t_swe", "GAUGE": "t_gauge", "REPORT": "t_report"}[kind]
    if kind == "REPORT":
        cols = ", ".join(f"f.{c} * r.r / 10 AS {c}" for c in FC_COLS)
        src = f"fcd f JOIN rat r USING (resort_id, local_date, lead)"
        cond = "AND r.r IS NOT NULL"
    else:
        cols = ", ".join(f"f.{c}" for c in FC_COLS)
        src, cond = "fcd f", ""
    return con.execute(f"""
      SELECT f.resort_id, f.local_date, f.lead, f.winter, t.obs, {cols}
      FROM {src} JOIN {tbl} t ON t.resort_id = f.resort_id AND t.local_date = f.local_date
      WHERE f.n_models = 3 {cond}""").fetchdf()


def boot_ratio(fc, obs, dates, rng):
    d = np.array([np.datetime64(x, "D") for x in dates])
    blk = (d - np.datetime64("2024-07-01")).astype(int) // BLOCK_DAYS
    ub, inv = np.unique(blk, return_inverse=True)
    sf, so = np.bincount(inv, fc, len(ub)), np.bincount(inv, obs, len(ub))
    idx = rng.integers(0, len(ub), size=(N_BOOT, len(ub)))
    v = sf[idx].sum(1) / np.maximum(so[idx].sum(1), 1e-9)
    return float(fc.sum() / max(obs.sum(), 1e-9)), float(np.percentile(v, 5)), float(np.percentile(v, 95)), len(ub)


def cats(fc, obs, thr):
    f, o = fc >= thr, obs >= thr
    h, fa, m = int((f & o).sum()), int((f & ~o).sum()), int((~f & o).sum())
    return {"csi": h / max(h + fa + m, 1), "freq_bias": (h + fa) / max(h + m, 1), "events": int(o.sum())}


def judge(kind: str, v):
    wet, dry = BARS[kind]
    if v[1] > wet:
        return "TOO WET"
    if v[2] < dry:
        return "TOO DRY"
    return "NO CLEAR BIAS"


def main(pairs: Path, eccc: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    blend = json.loads((ROOT / "public/blend.json").read_text())
    slr = json.loads((ROOT / "public/slr.json").read_text())
    forecasts(con, pairs, blend)
    if con.execute("SELECT count(*) FROM fcd").fetchone()[0] == 0:
        raise SystemExit("canada_interior_wet: no Open-Meteo forecast rows for the pool resorts")
    stations = truths(con, pairs, eccc)
    snow_cols(con, slr)
    strict_fit = con.execute(f"""SELECT resort_id, count(*) FROM read_parquet('{pairs}')
        WHERE source = '{SOURCE}' AND pair_quality = 'strict' AND tier = 'mid' AND split = 'train' AND space = 'liquid'
          AND resort_id IN {POOL_SQL} AND obs IS NOT NULL GROUP BY 1 ORDER BY 1""").fetchall()
    canada_fit = con.execute(f"""SELECT resort_id, count(DISTINCT local_date) FROM read_parquet('{pairs}')
        WHERE source = '{SOURCE}' AND pair_quality = 'strict' AND tier = 'mid' AND split = 'train' AND space = 'liquid'
          AND region = 'Canada' AND obs IS NOT NULL GROUP BY 1 ORDER BY 1""").fetchall()
    res = {"stations": {k: [list(map(str, s)) for s in v] for k, v in stations.items()}, "v1_canada_fit_resorts": canada_fit,
           "pool_in_v1_fit": strict_fit, "cells": {}, "answer": {}}
    L = ["# Does blend-v1 run wet in the Kootenays and Canadian Rockies? (scripts/diag/canada_interior_wet.py)\n",
         "Rule pre-registered in the docstring (commit 8dd76c0) before any number. Report only. Public data only. "
         f"Pool: {', '.join(POOL)}. Mid tier, Nov-Apr, leads 1-3 pooled unless noted. V = sum(v1) / sum(obs); "
         "ranges are 90% 7-day-block bootstraps.\n",
         "Resorts whose strict pairs fitted v1's Canada factors (2024-25 train days): " +
         (", ".join(f"{r} {n}" for r, n in canada_fit) or "none") + ". Pool resorts among them: " +
         (", ".join(r for r, _ in strict_fit) or "none") + ".\n"]
    L.append("## Truth stations used\n")
    for k in ("SWE", "GAUGE"):
        L.append(f"- {k}: " + ("; ".join(" / ".join(map(str, s)) for s in stations[k]) or "none within 40 km") )
    L.append("- REPORT: resort-reported new snow (OnTheSnow) at each resort that has it.\n")
    winter_ans = {}
    for wy, wn in WINTERS.items():
        L.append(f"\n## Winter {wn}\n")
        L.append("| truth | resort-days (leads 1-3) | lead-1 days obs ≥ event | resorts | V v1 (90%) | V v1, pooled factors | V ECMWF raw | V GFS raw | V GEM raw | freq bias v1 @10 | CSI v1 @10 | call |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        calls = {}
        for kind in ("SWE", "GAUGE", "REPORT"):
            rng = np.random.default_rng(SEED)
            df = joined(con, kind)
            df = df[(df.winter == wy) & df.lead.isin(LEADS)]
            l1 = df[(df.lead == 1) & (df.obs >= EVENT[kind])]
            n_ev, n_res = len(l1), df.resort_id.nunique()
            usable = n_ev >= MIN_DAYS and l1.resort_id.nunique() >= MIN_RESORTS
            cell = {"days": int(len(df)), "lead1_events": int(n_ev), "resorts": int(n_res), "usable": bool(usable)}
            if len(df):
                obs = df.obs.to_numpy(float)
                vs = {c: boot_ratio(df[c].to_numpy(float), obs, df.local_date.tolist(), rng) for c in FC_COLS}
                ct = cats(df.v1.to_numpy(float), obs, HIT[kind])
                call = judge(kind, vs["v1"]) if usable else "INSUFFICIENT"
                cell.update({"V": vs, "cats": ct, "call": call})
                per = []
                for rid, g in df.groupby("resort_id"):
                    o = g.obs.to_numpy(float)
                    per.append((rid, len(g), int(((g.lead == 1) & (g.obs >= EVENT[kind])).sum()),
                                boot_ratio(g.v1.to_numpy(float), o, g.local_date.tolist(), np.random.default_rng(SEED)),
                                float(g.ecmwf_ifs025.sum() / max(o.sum(), 1e-9))))
                cell["per_resort"] = per
                L.append(f"| {kind} ({UNIT[kind]}) | {len(df)} | {n_ev} | {n_res} | {vs['v1'][0]:.2f} ({vs['v1'][1]:.2f}–{vs['v1'][2]:.2f}) | "
                         f"{vs['v1_pooled'][0]:.2f} | {vs['ecmwf_ifs025'][0]:.2f} | {vs['gfs_seamless'][0]:.2f} | {vs['gem_seamless'][0]:.2f} | "
                         f"{ct['freq_bias']:.2f} | {ct['csi']:.2f} | **{call}** |")
            else:
                call = "INSUFFICIENT"
                cell["call"] = call
                L.append(f"| {kind} ({UNIT[kind]}) | 0 | 0 | 0 | – | – | – | – | – | – | – | **INSUFFICIENT** |")
            calls[kind] = call
            res["cells"][f"{wn}|{kind}"] = cell
        L.append("\nPer resort (v1 V, 90% range; ECMWF raw V): ")
        for kind in ("SWE", "GAUGE", "REPORT"):
            per = res["cells"][f"{wn}|{kind}"].get("per_resort", [])
            if per:
                L.append(f"- {kind}: " + "; ".join(f"{r} n={n} ev={e} V {v[0]:.2f} ({v[1]:.2f}–{v[2]:.2f}), ECMWF {ec:.2f}"
                                                    for r, n, e, v, ec in per))
        usable = {k: c for k, c in calls.items() if c != "INSUFFICIENT"}
        if len(usable) < 2:
            a = "INSUFFICIENT"
        elif sum(c == "TOO WET" for c in usable.values()) >= 2 and "TOO DRY" not in usable.values():
            a = "TOO WET"
        elif sum(c in ("NO CLEAR BIAS", "TOO DRY") for c in usable.values()) >= 2 and "TOO WET" not in usable.values():
            a = "NOT TOO WET"
        else:
            a = "MIXED"
        winter_ans[wn] = a
        L.append(f"\n**{wn} answer: {a}** (calls: " + ", ".join(f"{k} {c}" for k, c in calls.items()) + ")\n")
    a1, a2 = winter_ans["2024-25"], winter_ans["2025-26"]
    dec = {x for x in (a1, a2) if x in ("TOO WET", "NOT TOO WET", "MIXED")}
    if a1 == a2:
        final = a1
    elif a1 in ("TOO WET", "NOT TOO WET") and a2 in ("TOO WET", "NOT TOO WET"):
        final = "WINTER-DEPENDENT"
    elif len(dec) == 1:
        final = f"{dec.pop()} (one winter only)"
    else:
        final = f"{a1} / {a2}"
    res["answer"] = {"per_winter": winter_ans, "final": final}
    L.insert(3, f"\n## Answer: **{final}** (2024-25: {a1}; 2025-26: {a2})\n")
    # ---- live season, not gated
    live = con.execute(f"""
      WITH x AS (
        SELECT resort_id, local_date, source, any_value(fc_amount) AS fc FROM (
          SELECT * FROM read_parquet('{pairs}')
          WHERE source IN ('nbm', 'noaa-hrrr', 'msc-hrdps') AND space = 'liquid' AND tier = 'mid' AND lead_day = 1
            AND resort_id IN {POOL_SQL} AND split = 'live' AND fc_amount IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY resort_id, local_date, source ORDER BY issue_ts DESC) = 1)
        GROUP BY ALL)
      SELECT f.resort_id, count(*) AS days, round(sum(f.v1), 1) AS v1_mm,
             round(sum(n.fc), 1) AS nbm_mm, round(sum(h.fc), 1) AS hrrr_mm, round(sum(d.fc), 1) AS hrdps_mm,
             round(sum(s.obs), 1) AS swe_mm, round(sum(g.obs), 1) AS gauge_mm, round(sum(r.obs), 1) AS report_cm,
             round(sum(f.v1 * rt.r / 10), 1) AS v1_snow_cm
      FROM fcd f
      LEFT JOIN (SELECT * FROM x WHERE source = 'nbm') n USING (resort_id, local_date)
      LEFT JOIN (SELECT * FROM x WHERE source = 'noaa-hrrr') h USING (resort_id, local_date)
      LEFT JOIN (SELECT * FROM x WHERE source = 'msc-hrdps') d USING (resort_id, local_date)
      LEFT JOIN t_swe s USING (resort_id, local_date) LEFT JOIN t_gauge g USING (resort_id, local_date)
      LEFT JOIN t_report r USING (resort_id, local_date) LEFT JOIN rat rt USING (resort_id, local_date, lead)
      WHERE f.lead = 1 AND f.winter = 2026 AND f.n_models = 3
      GROUP BY f.resort_id ORDER BY f.resort_id""").fetchall()
    res["live"] = [list(map(lambda z: None if z is None else (float(z) if isinstance(z, (int, float)) else str(z)), r)) for r in live]
    L.append("\n## Live 2026-27 so far, lead 1 (NOT gated; sums over each column's own days, so compare with care)\n")
    L.append("| resort | days with v1 | v1 mm | NBM mm | HRRR mm | HRDPS mm | SWE truth mm | gauge mm | v1 snow cm | reported cm |\n|---|---|---|---|---|---|---|---|---|---|")
    for r in live:
        L.append(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | {r[6]} | {r[7]} | {r[9]} | {r[8]} |")
    text = "\n".join(L) + "\n"
    if "snow-forecast" in text.lower():
        raise SystemExit("canada_interior_wet: report names a paid source; refusing")
    (out / "canada_interior_wet.md").write_text(text)
    (out / "canada_interior_wet.json").write_text(json.dumps(res, default=str, indent=1))
    print(text)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
