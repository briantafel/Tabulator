#!/usr/bin/env python3
"""Canada water check: public forecasts vs ECCC daily precipitation, and the blend's Canada factors.

    python3 scripts/model/canada_water.py <eccc_pairs.parquet> <public/blend.json> <outDir>

Reads eccc_pairs.parquet and eccc_truth.parquet (scripts/verify/eccc.py) and the LIVE blend.json.
Writes canada_water_report.md and canada_water.json. Report only: no factor and nothing in the app
changes because of this script.

Public models and public truth only (Open-Meteo previous runs, NBM, HRRR, HRDPS; ECCC). The report is
published unsealed; the script refuses to write it if it names a paid source.

1. Per resort × model × lead group (0, 1-2, 3-5, 6-7) and per split (train 2024-25, test 2025-26, live):
   volume ratio Σforecast ÷ Σobserved, raw and with blend-v1's Canada factor (Open-Meteo models,
   leads 1-7 only: no other model has a v1 factor), CSI at 2.5 / 10 / 20 mm, wet days (≥ 1 mm),
   events (observed days ≥ 10 mm), each with a 90% date-block bootstrap range (blocks of 7 days,
   resampled with replacement, so a multi-day storm is kept whole and resorts sharing a storm move together).
2. Refit: Canada factor per model × lead on ECCC truth, TRAINING winter only, with blend.py's rule —
   Σobs ÷ Σforecast, shrunk toward blend-v1's pooled (all-region) factor with weight n_wet/(n_wet+40),
   clamped to [0.5, 2]. Judged on the TEST winter, with v1's weights, the blend (all three models present)
   corrected by v1 vs by the refit.

DECISION RULE (written 2026-11-23, before the first run). For each lead group (1-3, 4-7) and pooled 1-7,
the refit counts as BETTER only if all three hold on the test winter:
  a. the 90% range of CSI(refit) − CSI(v1) at ≥ 10 mm is above 0 (5th percentile > 0);
  b. the volume ratio moves closer to 1: |vol_refit − 1| < |vol_v1 − 1|;
  c. no threshold's range is below 0: at 2.5, 10 and 20 mm the 95th percentile of the CSI difference ≥ 0.
The pooled 1-7 verdict is the headline; the groups say where it comes from. Anything else is "not shown".
How many events: the half-width of the CSI-difference range scales as 1/√events, so the events needed to
resolve a difference δ are events_now × (half_width_now / δ)², reported for δ = 0.02 and 0.05.
CAVEAT: ECCC gauges undercatch snow — the more wind and the colder, the more (often 20-50 % for snowfall at
exposed sites). ECCC truth is low, so ratios read wet and a refit to it is pulled DRY. A refit that
"wins" on gauge truth can still be too dry on the slope.
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from blend import CLAMP, SHRINK_DAYS, WET_MM  # noqa: E402

FORECASTS = ("open-meteo-previous-runs", "nbm", "noaa-hrrr", "msc-hrdps")
OM_MODELS = ("ecmwf_ifs025", "gem_seamless", "gfs_seamless")
LEAD_GROUPS = {"0": (0,), "1-2": (1, 2), "3-5": (3, 4, 5), "6-7": (6, 7)}
JUDGE_GROUPS = {"1-3": (1, 2, 3), "4-7": (4, 5, 6, 7), "1-7": tuple(range(1, 8))}
THRESHOLDS = (2.5, 10.0, 20.0)
EVENT_MM = 10.0
BLOCK_DAYS = 7
N_BOOT = 1000
SEED = 20261123
EPOCH = date(2024, 7, 1)
PAID_WORDS = ("snow-forecast", "snowforecast", "(paid)")
REGION = "Canada"


def short(label: str) -> str:
    return {"open-meteo-previous-runs:ecmwf_ifs025": "ECMWF", "open-meteo-previous-runs:gem_seamless": "GEM",
            "open-meteo-previous-runs:gfs_seamless": "GFS", "nbm:nbm": "NBM"}.get(
        label, label.replace("noaa-hrrr", "HRRR").replace("msc-hrdps", "HRDPS"))


def arr(x) -> np.ndarray:
    """A DuckDB numpy column (masked where NULL) → float array with NaN."""
    return np.ma.filled(np.ma.asarray(x).astype(float), np.nan)


def blocks(dates) -> tuple[np.ndarray, int]:
    days = np.asarray(dates).astype("datetime64[D]").astype(np.int64) - np.datetime64(EPOCH, "D").astype(np.int64)
    b = days // BLOCK_DAYS
    ub, inv = np.unique(b, return_inverse=True)
    return inv, len(ub)


def boot_idx(rng, nb: int) -> np.ndarray:
    return rng.integers(0, nb, size=(N_BOOT, nb))


def cell(fc, obs, inv, nb, idx, fcv1=None) -> dict:
    """Volume ratio and CSI at each threshold, with 90% block-bootstrap ranges."""
    sum_b = lambda x: np.bincount(inv, x, nb)
    so, sf = sum_b(obs), sum_b(fc)
    bo, bf = so[idx].sum(1), sf[idx].sum(1)
    r = {"days": int(len(obs)), "wet": int((obs >= WET_MM).sum()), "events": int((obs >= EVENT_MM).sum()),
         "vol": sf.sum() / so.sum() if so.sum() > 0 else None,
         "vol_r": rng_pct(bf / np.where(bo > 0, bo, np.nan))}
    if fcv1 is not None and not np.isnan(fcv1).any():
        sv = sum_b(fcv1)
        r["vol_v1"] = sv.sum() / so.sum() if so.sum() > 0 else None
        r["vol_v1_r"] = rng_pct(sv[idx].sum(1) / np.where(bo > 0, bo, np.nan))
    for t in THRESHOLDS:
        f, o = fc >= t, obs >= t
        h, fa, m = sum_b((f & o).astype(float)), sum_b((f & ~o).astype(float)), sum_b((~f & o).astype(float))
        den = h.sum() + fa.sum() + m.sum()
        r[f"csi{t:g}"] = h.sum() / den if den else None
        bh, bd = h[idx].sum(1), (h[idx] + fa[idx] + m[idx]).sum(1)
        r[f"csi{t:g}_r"] = rng_pct(bh / np.where(bd > 0, bd, np.nan))
    return r


def rng_pct(x) -> tuple | None:
    x = x[~np.isnan(x)]
    return (float(np.percentile(x, 5)), float(np.percentile(x, 95))) if len(x) else None


def fmt(v, r=None, p=2) -> str:
    if v is None:
        return "—"
    s = f"{v:.{p}f}"
    return s + (f" ({r[0]:.{p}f}–{r[1]:.{p}f})" if r else "")


def load(con, pairs: Path, blend: dict) -> None:
    src = ", ".join(f"'{s}'" for s in FORECASTS)
    con.execute(f"""CREATE TABLE p AS SELECT * FROM read_parquet('{pairs}')
                    WHERE source IN ({src}) AND region = '{REGION}'""")
    con.execute("CREATE TABLE fac(model VARCHAR, lead INTEGER, f DOUBLE)")
    con.executemany("INSERT INTO fac VALUES (?, ?, ?)",
                    [(k.split("|")[0], int(k.split("|")[1]), v) for k, v in blend["factors"].items()
                     if k.endswith("|" + REGION)])
    con.execute("""CREATE TABLE s AS
                   SELECT p.*, CASE WHEN p.source = 'open-meteo-previous-runs' THEN p.fc_amount * fac.f END AS fc_v1
                   FROM p LEFT JOIN fac ON fac.model = p.model AND fac.lead = p.lead_day
                   WHERE p.obs IS NOT NULL AND p.station_id IS NOT NULL""")


def scores(con, rng) -> tuple[list, list]:
    """(Canada pooled rows, per-resort rows)."""
    pooled, per = [], []
    labels = [r[0] for r in con.execute("SELECT DISTINCT source_label FROM s ORDER BY 1").fetchall()]
    for split in ("train", "test", "live"):
        for lab in labels:
            for g, leads in LEAD_GROUPS.items():
                ls = ", ".join(map(str, leads))
                for rid in (None,) + tuple(r[0] for r in con.execute(
                        f"SELECT DISTINCT resort_id FROM s WHERE split = '{split}' AND source_label = '{lab}' "
                        f"AND lead_day IN ({ls}) ORDER BY 1").fetchall()):
                    wh = f"split = '{split}' AND source_label = '{lab}' AND lead_day IN ({ls})" + \
                         (f" AND resort_id = '{rid}'" if rid else "")
                    d = con.execute(f"SELECT local_date, fc_amount, obs, fc_v1 FROM s WHERE {wh}").fetchnumpy()
                    if len(d["obs"]) == 0:
                        continue
                    inv, nb = blocks(d["local_date"])
                    v1 = arr(d["fc_v1"]) if lab.startswith("open-meteo") and 0 not in leads else None
                    c = cell(arr(d["fc_amount"]), arr(d["obs"]), inv, nb, boot_idx(rng, nb), v1)
                    c.update({"split": split, "model": short(lab), "leads": g, "resort": rid or "ALL"})
                    (per if rid else pooled).append(c)
    order = {"train": 0, "test": 1, "live": 2}
    per.sort(key=lambda c: (c["resort"], order[c["split"]], c["model"], list(LEAD_GROUPS).index(c["leads"])))
    return pooled, per


def table(rows: list, with_resort: bool) -> str:
    head = (["resort"] if with_resort else []) + ["split", "model", "leads", "days", "wet days", "events ≥10",
                                                  "volume raw", "volume v1", "CSI ≥2.5", "CSI ≥10", "CSI ≥20"]
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for c in rows:
        cells = ([c["resort"]] if with_resort else []) + [c["split"], c["model"], c["leads"], str(c["days"]), str(c["wet"]),
                 str(c["events"]), fmt(c["vol"], c["vol_r"]), fmt(c.get("vol_v1"), c.get("vol_v1_r")),
                 fmt(c["csi2.5"], c["csi2.5_r"]), fmt(c["csi10"], c["csi10_r"]), fmt(c["csi20"], c["csi20_r"])]
        out.append("| " + " | ".join(cells) + " |")
    return "\n".join(out) + "\n" if rows else "_no rows_\n"


def refit(con, blend: dict) -> dict:
    rows = con.execute(f"""
      SELECT model, lead_day, sum(obs), sum(fc_amount), sum(CAST(obs >= {WET_MM} AS INT)), count(*)
      FROM s WHERE split = 'train' AND source = 'open-meteo-previous-runs' AND lead_day BETWEEN 1 AND 7
      GROUP BY ALL ORDER BY ALL""").fetchall()
    out = {}
    for model, lead, so, sf, wet, n in rows:
        pool = float(blend["pooled_factors"].get(f"{model}|{lead}", 1.0))
        raw = so / sf if sf else None
        w = wet / (wet + SHRINK_DAYS)
        f = float(np.clip(w * (raw if raw is not None else pool) + (1 - w) * pool, *CLAMP))
        out[f"{model}|{lead}|{REGION}"] = {"refit": round(f, 3), "raw_ratio": None if raw is None else round(raw, 3),
                                           "wet_days": int(wet), "days": int(n), "pooled_v1": pool,
                                           "v1": blend["factors"].get(f"{model}|{lead}|{REGION}")}
    return out


def judge(con, blend: dict, fits: dict, rng) -> list:
    con.execute("CREATE TABLE rf(model VARCHAR, lead INTEGER, f DOUBLE)")
    con.executemany("INSERT INTO rf VALUES (?, ?, ?)",
                    [(k.split("|")[0], int(k.split("|")[1]), v["refit"]) for k, v in fits.items()])
    con.execute("CREATE TABLE w(lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO w VALUES (?, ?, ?)",
                    [(int(l), m, v) for l, ws in blend["weights"].items() for m, v in ws.items()])
    con.execute("""
    CREATE TABLE jt AS
    SELECT s.resort_id, s.local_date, s.lead_day AS lead, any_value(s.obs) AS obs,
           sum(w.w * s.fc_amount) / sum(w.w) AS b_raw,
           sum(w.w * s.fc_v1) / sum(w.w) AS b_v1,
           sum(w.w * s.fc_amount * coalesce(rf.f, 1.0)) / sum(w.w) AS b_refit, count(*) AS n
    FROM s JOIN w ON w.lead = s.lead_day AND w.model = s.model
    LEFT JOIN rf ON rf.model = s.model AND rf.lead = s.lead_day
    WHERE s.split = 'test' AND s.source = 'open-meteo-previous-runs' AND s.fc_v1 IS NOT NULL
    GROUP BY s.resort_id, s.local_date, s.lead_day""")
    res = []
    for g, leads in JUDGE_GROUPS.items():
        d = con.execute(f"SELECT local_date, obs, b_raw, b_v1, b_refit FROM jt WHERE n = 3 AND lead IN "
                        f"({', '.join(map(str, leads))})").fetchnumpy()
        if len(d["obs"]) == 0:
            res.append({"leads": g, "days": 0}); continue
        inv, nb = blocks(d["local_date"]); idx = boot_idx(rng, nb)
        obs = arr(d["obs"])
        sb = lambda x: np.bincount(inv, x, nb)
        so = sb(obs)
        r = {"leads": g, "days": int(len(obs)), "events": int((obs >= EVENT_MM).sum()), "wet": int((obs >= WET_MM).sum())}
        for name in ("b_raw", "b_v1", "b_refit"):
            r[f"vol_{name}"] = sb(arr(d[name])).sum() / so.sum() if so.sum() else None
        ok_c = True
        for t in THRESHOLDS:
            o = obs >= t
            boots = {}
            for name in ("b_v1", "b_refit"):
                f = arr(d[name]) >= t
                h, fa, m = sb((f & o).astype(float)), sb((f & ~o).astype(float)), sb((~f & o).astype(float))
                den = h.sum() + fa.sum() + m.sum()
                r[f"csi{t:g}_{name}"] = h.sum() / den if den else None
                bd = (h[idx] + fa[idx] + m[idx]).sum(1)
                boots[name] = h[idx].sum(1) / np.where(bd > 0, bd, np.nan)
            diff = boots["b_refit"] - boots["b_v1"]
            r[f"events{t:g}"] = int(o.sum())
            r[f"diff{t:g}"] = (None if r[f"csi{t:g}_b_v1"] is None or r[f"csi{t:g}_b_refit"] is None
                               else r[f"csi{t:g}_b_refit"] - r[f"csi{t:g}_b_v1"])
            r[f"diff{t:g}_r"] = rng_pct(diff)
            if r[f"diff{t:g}_r"] is None or r[f"diff{t:g}_r"][1] < 0:
                ok_c = False
        ra = r["diff10_r"] is not None and r["diff10_r"][0] > 0
        rb = (r["vol_b_v1"] is not None and r["vol_b_refit"] is not None
              and abs(r["vol_b_refit"] - 1) < abs(r["vol_b_v1"] - 1))
        r.update({"a": ra, "b": rb, "c": ok_c, "better": ra and rb and ok_c})
        if r["diff10_r"]:
            hw = (r["diff10_r"][1] - r["diff10_r"][0]) / 2
            r["half_width10"] = hw
            for delta in (0.02, 0.05):
                r[f"need{delta:g}"] = int(np.ceil(r["events10"] * (hw / delta) ** 2)) if r["events10"] else None
        res.append(r)
    return res


def whistler(con, pairs: Path, truth: Path, blend: dict) -> str:
    if not truth.exists():
        return "_no eccc_truth.parquet_\n"
    con.execute(f"CREATE TABLE wt AS SELECT * FROM read_parquet('{truth}') WHERE resort_id = 'whistler'")
    st = con.execute("""SELECT station_id, any_value(station_name), any_value(station_elev_m), any_value(round(station_km, 1)),
                               any_value(station_delev_m), any_value(strict), any_value(round(coverage, 2)), any_value(chosen),
                               count(*) FILTER (WHERE winter >= 2026)
                        FROM wt GROUP BY station_id ORDER BY any_value(station_elev_m) DESC NULLS LAST""").fetchall()
    lines = ["| station | name | elev m | km | Δelev vs mid m | strict | Nov–Apr coverage | chosen | days this season |",
             "|---|---|---|---|---|---|---|---|---|"]
    lines += ["| " + " | ".join("—" if v is None else str(v) for v in r) + " |" for r in st]
    if not st:
        return "_no ECCC candidate stations for Whistler_\n"
    # The check station: the highest candidate with this season's data (Roundhouse, 1835 m, when it reports).
    chk = next((r for r in st if r[8]), None)
    out = "\n".join(lines) + "\n"
    if not chk:
        return out + "\n_no candidate station has data this season yet_\n"
    sid, name, elev = chk[0], chk[1], chk[2]
    con.execute(f"""CREATE TABLE wf AS SELECT * FROM read_parquet('{pairs}')
                    WHERE resort_id = 'whistler' AND split = 'live' AND lead_day >= 1
                      AND source IN ({', '.join(f"'{x}'" for x in FORECASTS)})""")
    con.execute("CREATE TABLE ww(lead INTEGER, model VARCHAR, w DOUBLE)")
    con.executemany("INSERT INTO ww VALUES (?, ?, ?)",
                    [(int(l), m, v) for l, ws in blend["weights"].items() for m, v in ws.items()])
    rows = con.execute(f"""
      WITH m AS (SELECT source_label, local_date, arg_min(lead_day, lead_day) AS lead, arg_min(fc_amount, lead_day) AS fc
                 FROM wf GROUP BY ALL),
           b AS (SELECT f.local_date, f.lead_day,
                        sum(ww.w * f.fc_amount * coalesce(fac.f, 1)) / sum(ww.w) AS v1, count(*) AS n
                 FROM wf f JOIN ww ON ww.lead = f.lead_day AND ww.model = f.model
                 LEFT JOIN fac ON fac.model = f.model AND fac.lead = f.lead_day
                 WHERE f.source = 'open-meteo-previous-runs' GROUP BY ALL HAVING count(*) = 3),
           bm AS (SELECT local_date, arg_min(lead_day, lead_day) AS lead, arg_min(v1, lead_day) AS v1 FROM b GROUP BY ALL)
      SELECT d.local_date, t.obs, t.flag,
             list(printf('%s %.1f (L%d)', m.source_label, m.fc, m.lead) ORDER BY m.source_label) AS fcs,
             any_value(bm.v1), any_value(bm.lead)
      FROM (SELECT DISTINCT local_date FROM wf WHERE local_date >= DATE '2026-11-15') d
      LEFT JOIN wt t ON t.station_id = '{sid}' AND t.local_date = d.local_date
      LEFT JOIN m ON m.local_date = d.local_date
      LEFT JOIN bm ON bm.local_date = d.local_date
      GROUP BY d.local_date, t.obs, t.flag ORDER BY d.local_date""").fetchall()
    tl = [f"\nCheck station: **{name}** ({sid}, {elev} m). Water, mm. Each model at its shortest lead ≥ 1 "
          "(L = lead day); 'v1 blend' = the three Open-Meteo models with v1's Canada factors and weights.\n",
          "| date | observed mm | flag | forecasts mm | v1 blend mm |", "|---|---|---|---|---|"]
    for dte, obs, flag, fcs, v1, lead in rows:
        fl = ", ".join(short(x.split(" ")[0]) + " " + " ".join(x.split(" ")[1:]) for x in (fcs or []) if x)
        tl.append(f"| {dte} | {fmt(obs, p=1)} | {flag or ''} | {fl} | {fmt(v1, p=1)}{f' (L{lead})' if lead else ''} |")
    return out + "\n".join(tl) + "\n"


def main(pairs: Path, blend_path: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    rep = out / "canada_water_report.md"
    if not pairs.exists():
        rep.write_text("# Canada water check — ECCC truth\n\n_No eccc_pairs.parquet: the verify build found no usable "
                       "ECCC daily rows._\n")
        print("canada_water: no eccc_pairs.parquet", file=sys.stderr); return
    blend = json.loads(blend_path.read_text())
    con = duckdb.connect()
    load(con, pairs, blend)
    rng = np.random.default_rng(SEED)
    n = con.execute("SELECT count(*), count(DISTINCT resort_id) FROM s").fetchone()
    pooled, per = scores(con, rng)
    fits = refit(con, blend)
    jr = judge(con, blend, fits, rng)
    res = con.execute("""SELECT resort_id, any_value(station_id), any_value(station_name), any_value(station_elev_m),
                                any_value(round(station_km, 1)), any_value(station_delev_m),
                                count(DISTINCT local_date) FILTER (WHERE split = 'train'),
                                count(DISTINCT local_date) FILTER (WHERE split = 'test'),
                                count(DISTINCT local_date) FILTER (WHERE split = 'live')
                         FROM s GROUP BY resort_id ORDER BY resort_id""").fetchall()
    fl = lambda b: "yes" if b else "no"
    jl = ["| leads | days | wet | events ≥10 | volume raw | volume v1 | volume refit | CSI≥2.5 v1→refit (Δ range) | "
          "CSI≥10 v1→refit (Δ range) | CSI≥20 v1→refit (Δ range) | a | b | c | BETTER |", "|" + "---|" * 14]
    for r in jr:
        if not r["days"]:
            jl.append(f"| {r['leads']} | 0 |" + " — |" * 12); continue
        cs = lambda t: (f"{fmt(r[f'csi{t:g}_b_v1'])}→{fmt(r[f'csi{t:g}_b_refit'])} "
                        f"({fmt(r[f'diff{t:g}'])}; {fmt(r[f'diff{t:g}_r'][0]) if r[f'diff{t:g}_r'] else '—'} to "
                        f"{fmt(r[f'diff{t:g}_r'][1]) if r[f'diff{t:g}_r'] else '—'})")
        jl.append(f"| {r['leads']} | {r['days']} | {r['wet']} | {r['events']} | {fmt(r['vol_b_raw'])} | {fmt(r['vol_b_v1'])} | "
                  f"{fmt(r['vol_b_refit'])} | {cs(2.5)} | {cs(10)} | {cs(20)} | {fl(r['a'])} | {fl(r['b'])} | {fl(r['c'])} | "
                  f"**{'BETTER' if r['better'] else 'not shown'}** |")
    head = next((r for r in jr if r["leads"] == "1-7"), {})
    need = (f"At ≥ 10 mm, leads 1-7, the test winter has {head.get('events10', 0)} events and the CSI-difference range "
            f"has half-width {head.get('half_width10', float('nan')):.3f}. Resolving a difference of 0.05 needs about "
            f"{head.get('need0.05', '—')} events; 0.02 needs about {head.get('need0.02', '—')}."
            if head.get("half_width10") is not None else "Too few test-winter events to size the range.")
    fx = ["| model | lead | v1 factor | v1 pooled (shrink target) | ECCC train Σobs÷Σfc | wet days | refit |",
          "|---|---|---|---|---|---|---|"]
    fx += [f"| {short('open-meteo-previous-runs:' + k.split('|')[0])} | {k.split('|')[1]} | {fmt(v['v1'])} | "
           f"{fmt(v['pooled_v1'])} | {fmt(v['raw_ratio'])} | {v['wet_days']} | {fmt(v['refit'])} |"
           for k, v in sorted(fits.items(), key=lambda kv: (kv[0].split('|')[0], int(kv[0].split('|')[1])))]
    parts = [
        "# Canada water check — ECCC daily precipitation as truth\n",
        "Public models and public truth only. Report only: no factor or app setting was changed.\n",
        "## Decision rule (fixed before the first run)\n",
        "The refit Canada factors count as BETTER than v1, per lead group and pooled 1-7 on the 2025-26 test winter, "
        "only if: **a** the 90% range of CSI(refit) − CSI(v1) at ≥ 10 mm is above 0; **b** the volume ratio moves "
        "closer to 1; **c** no threshold's range lies below 0 (95th percentile ≥ 0 at 2.5, 10 and 20 mm). "
        "The range half-width scales as 1/√events: events needed for a difference δ ≈ events × (half-width ÷ δ)².\n",
        "**Gauge undercatch.** ECCC gauges catch less snow than falls — more in wind and cold, often 20–50% for snowfall at "
        "exposed sites. So volume ratios here read WET and a factor refit to this truth is pulled DRY. Treat a "
        "volume ratio near 1.2–1.4 as possibly unbiased on the slope.\n",
        "## Truth\n",
        f"{n[0]:,} forecast-days with ECCC truth at {n[1]} resorts (strict mid-tier station, ≥ 60% Nov–Apr coverage, "
        "accumulated / estimated / missing days dropped — counts in the build log). Forecasts: one per model × resort × "
        "day × lead (issues averaged). Ranges: 90%, 7-day date-block bootstrap.\n",
        "| resort | station | name | elev m | km | Δelev vs mid m | train days | test days | live days |",
        "|---|---|---|---|---|---|---|---|---|",
        *["| " + " | ".join("—" if v is None else str(v) for v in r) + " |" for r in res],
        "\n## Refit vs v1 — judged on the test winter (blend of the three Open-Meteo models, v1 weights)\n",
        "\n".join(jl),
        f"\n**Headline (leads 1-7): {'BETTER' if head.get('better') else 'not shown'}.** {need}\n",
        "\n### Factors: v1 (live) vs refit on ECCC training truth\n",
        "\n".join(fx) + "\n",
        "\n## Canada pooled — volume ratio and CSI by model, lead group and split\n",
        "volume = Σforecast ÷ Σobserved (1.00 = unbiased); v1 = with blend-v1's Canada factor (Open-Meteo, leads 1-7).\n",
        table(pooled, False),
        "\n## Whistler this season — the check\n",
        whistler(con, pairs, pairs.parent / "eccc_truth.parquet", blend),
        "\n## Per resort\n",
        table(per, True),
    ]
    text = "\n".join(parts) + "\n"
    low = text.lower()
    if any(w in low for w in PAID_WORDS):
        raise SystemExit("canada_water: the report names a paid source; refusing to write it")
    rep.write_text(text)
    (out / "canada_water.json").write_text(json.dumps({"refit_factors": fits, "judgement": [
        {k: v for k, v in r.items()} for r in jr]}, indent=2, default=str) + "\n")
    print(f"canada_water: {n[0]} pairs at {n[1]} resorts; headline {'BETTER' if head.get('better') else 'not shown'}",
          file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
