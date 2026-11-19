#!/usr/bin/env python3
"""Daily digest: how accurate are we, by region and lead day (Brian, 2026-11-12).

    python3 scripts/verify/digest.py <archiveDir> <outDir> [--resorts src/data/resorts.json]

Runs after build.py, slr.py, blend.py and temps.py in verify.yml and reads
what they wrote to <outDir> (temp_pairs.parquet, pairs.parquet,
temp-model.json, blend.json) plus the raw archive for wind. Writes
digest.md and digest_*.csv into <outDir>. They contain paid-source scores, so
they go only into the sealed report and the private bucket — never the log.

Three questions:
1. TEMPERATURE. Our model (temps-v1: per-resort high correction + lead
   weights, fitted on 2024-25) vs Snow-Forecast (paid) vs NWS / NBM / the raw
   models, against SNOTEL daily TMAX / TMIN at strict mid pairs. Head-to-head
   only on the SAME resort-days, so a source is never judged on easier weather.
2. SNOWFALL. Hit rates (POD / FAR / CSI, frequency bias) at the build's
   thresholds against SNOTEL / BC pillow gains, by lead day and region. Ours
   = blend-v1, which is LIQUID only (snow needs the fitted SLR, not shipped),
   so ours is compared in liquid space; snow space shows the sources.
3. WIND. Snow-Forecast's per-tier wind and the public models' 10 m and
   700 hPa wind vs SLF IMIS stations (Swiss network, live since 2026-11-11),
   each station classed against the resort's tier heights. Sustained-wind
   error and the 45 mph veto. US/Canada wind truth arrives with Synoptic.

Rules: missing is dropped, never zero; every table prints its sample size;
fewer than THIN events → flagged thin, not a result.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb
import numpy as np

PAID = ("snow-forecast", "snow-forecast-hindcast")
THIN = 20
F = 9 / 5
KMH_TO_MPH = 0.621371
VETO_MPH = 45.0
# Macro regions so samples aren't split to nothing. Per-state rows are in the CSVs.
MACRO = {
    "California": "Sierra & Cascades", "Nevada": "Sierra & Cascades", "Oregon": "Sierra & Cascades",
    "Washington": "Sierra & Cascades",
    "Colorado": "Rockies", "Utah": "Rockies", "Wyoming": "Rockies", "Idaho": "Rockies", "Montana": "Rockies",
    "New Mexico": "Rockies",
    "Vermont": "Northeast", "New York": "Northeast",
    "Canada": "Canada",
    "Switzerland": "Alps", "Austria": "Alps", "France": "Alps", "Italy": "Alps",
    "Japan": "Japan", "Norway": "Scandinavia", "Sweden": "Scandinavia",
    "Chile": "Andes", "Argentina": "Andes", "Georgia": "Caucasus",
}
LEADS = list(range(0, 8))


def md(con, sql: str, empty: str = "_no data yet_") -> str:
    rel = con.execute(sql)
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    if not rows:
        return empty + "\n"
    fmt = lambda v: "—" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    out += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def setup(con, resorts_path: Path) -> None:
    meta = json.loads(resorts_path.read_text())["resorts"]
    con.execute("CREATE TABLE rz(resort_id VARCHAR, region VARCHAR, macro VARCHAR, tz VARCHAR)")
    con.executemany("INSERT INTO rz VALUES (?, ?, ?, ?)",
                    [(r["id"], r["region"], MACRO.get(r["region"], r["region"]), r["tz"]) for r in meta])


# --------------------------------------------------------------------------- temperature
def temperature(con, out: Path) -> str:
    tp = out / "temp_pairs.parquet"
    if not tp.exists():
        return "## Temperature\n\n_temp_pairs.parquet missing — build.py failed upstream._\n"
    con.execute(f"""
    CREATE TABLE td AS
    SELECT p.source_label, any_value(p.paid) AS paid, p.var, p.split, p.resort_id, any_value(z.macro) AS macro,
           p.local_date, p.lead_day AS lead, avg(p.fc_adj) AS fc, any_value(p.obs) AS obs
    FROM read_parquet('{tp}') p JOIN rz z USING (resort_id)
    WHERE p.pair_quality = 'strict' AND p.tier = 'mid' AND p.fc_adj IS NOT NULL AND p.lead_day BETWEEN 0 AND 7
    GROUP BY p.source_label, p.var, p.split, p.resort_id, p.local_date, p.lead_day""")
    # Ours = temps-v1 exactly as temps.py fitted it (Celsius; highs corrected; all three models required).
    mp = out / "temp-model.json"
    ours_note = "temps-v1 not found — ours not scored."
    if mp.exists():
        m = json.loads(mp.read_text())
        # Exactly what the app ships (promote_temps.py + scripts/temps/lib.js): a var × lead that
        # was not promoted gets equal weights and no correction.
        prom = m.get("promote", {})
        on = lambda v, l: bool(prom.get(v, {}).get(str(l)))
        con.execute("CREATE TABLE tw(var VARCHAR, lead INTEGER, model VARCHAR, w DOUBLE)")
        con.executemany("INSERT INTO tw VALUES (?, ?, ?, ?)",
                        [(v, l, mo, (m["weights"].get(v, {}).get(str(l), {}).get(mo, 1.0) if on(v, l) else 1.0))
                         for v in ("hi", "lo", "lift") for l in range(1, 8) for mo in m["models"]])
        con.execute("CREATE TABLE tc(var VARCHAR, lead INTEGER, model VARCHAR, resort_id VARCHAR, b DOUBLE)")
        tables = {"hi": m.get("high_bias", {}), "lo": m.get("low_bias", {}), "lift": m.get("lift_bias", {})}
        tc_rows = [(v, l, k.split("|")[0], k.split("|")[1], b) for v, t in tables.items()
                   for l in range(1, 8) if on(v, l) for k, b in t.items()]
        if tc_rows:  # nothing promoted → no corrections (equal weights only)
            con.executemany("INSERT INTO tc VALUES (?, ?, ?, ?, ?)", tc_rows)
        n_models = len(m["models"])
        con.execute(f"""
        INSERT INTO td
        SELECT 'ours (temps)', false, d.var, d.split, d.resort_id, any_value(d.macro), d.local_date, d.lead,
               sum(tw.w * (d.fc - coalesce(tc.b, 0))) / sum(tw.w),
               any_value(d.obs)
        FROM (SELECT *, split_part(source_label, ':', 2) AS model FROM td
              WHERE source_label LIKE 'open-meteo-previous-runs:%') d
        JOIN tw ON tw.var = d.var AND tw.lead = d.lead AND tw.model = d.model
        LEFT JOIN tc ON tc.var = d.var AND tc.lead = d.lead AND tc.model = d.model AND tc.resort_id = d.resort_id
        GROUP BY d.var, d.split, d.resort_id, d.local_date, d.lead HAVING count(*) = {n_models}""")
        ours_note = (f"Ours = {m.get('version', 'temps')} as the app applies it: per-resort correction + lead weights "
                     "over ECMWF / GEM / GFS, fitted on 2024-25, ONLY at promoted var × lead (else equal weights, "
                     "no correction). 2025-26 and this season are out of sample. Leads 1–7 only.")
    con.execute(f"""
    CREATE TABLE tday AS
    SELECT source_label, paid, var, split, macro, lead, count(*) AS n, count(DISTINCT resort_id) AS resorts,
           avg(abs(fc - obs)) * {F} AS mae_f, avg(fc - obs) * {F} AS bias_f,
           avg(CASE WHEN abs(fc - obs) * {F} <= 3 THEN 1.0 ELSE 0.0 END) AS within3
    FROM td GROUP BY GROUPING SETS ((source_label, paid, var, split, macro, lead), (source_label, paid, var, split, lead))""")
    con.execute("UPDATE tday SET macro = 'ALL' WHERE macro IS NULL")
    con.execute(f"COPY (SELECT * FROM tday ORDER BY ALL) TO '{out / 'digest_temp.csv'}' (HEADER)")

    # Head-to-head: identical resort-days where ours AND Snow-Forecast both forecast.
    con.execute(f"""
    CREATE TABLE th2h AS
    WITH k AS (SELECT var, split, resort_id, local_date, lead FROM td GROUP BY ALL
               HAVING bool_or(source_label = 'ours (temps)') AND bool_or(source_label = 'snow-forecast'))
    SELECT td.var, td.split, coalesce(td.macro, 'ALL') AS macro, td.lead, count(*) AS n,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'ours (temps)') * {F} AS ours,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'snow-forecast') * {F} AS sf,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'nws') * {F} AS nws,
           count(*) FILTER (WHERE source_label = 'ours (temps)') AS days
    FROM td JOIN k USING (var, split, resort_id, local_date, lead)
    GROUP BY GROUPING SETS ((td.var, td.split, td.macro, td.lead), (td.var, td.split, td.lead))""")
    con.execute("UPDATE th2h SET macro = 'ALL' WHERE macro IS NULL")
    con.execute(f"COPY (SELECT * FROM th2h ORDER BY ALL) TO '{out / 'digest_temp_h2h.csv'}' (HEADER)")

    parts = ["## 1. Temperature (°F, mean absolute error vs SNOTEL, strict mid pairs)\n", ours_note + "\n"]
    for var, name in (("hi", "Daily high"), ("lo", "Overnight low"), ("lift", "Lift-hours low (08–16, the −10 °F veto)")):
        parts += [f"\n### {name}: ours vs Snow-Forecast (paid) on the same resort-days\n",
                  "Lower is better. `sf − ours` > 0 means we beat the paid forecast. NWS shown where it covered the day.\n",
                  md(con, f"""SELECT split AS winter, macro AS region, lead, days,
                                round(ours, 1) AS ours, round(sf, 1) AS sf, round(sf - ours, 1) AS "sf − ours",
                                round(nws, 1) AS nws
                             FROM th2h WHERE var = '{var}' AND days > 0
                             ORDER BY CASE split WHEN 'live' THEN 0 WHEN 'test' THEN 1 ELSE 2 END,
                                      macro = 'ALL' DESC, macro, lead""",
                     "_no resort-days where both ours and Snow-Forecast forecast_")]
        parts += [f"\n### {name}: every source, all regions (own samples — not head-to-head)\n",
                  md(con, f"""PIVOT (SELECT split, source_label || CASE WHEN paid THEN ' (paid)' ELSE '' END AS source,
                                     lead, round(mae_f, 1) || ' (' || n || ')' AS v
                              FROM tday WHERE var = '{var}' AND macro = 'ALL' AND split IN ('test', 'live'))
                             ON lead USING any_value(v) GROUP BY split, source ORDER BY split, source""")]
    veto_c = (-10 - 32) * 5 / 9
    parts += ["\n### The −10 °F deal breaker: lift-hours low at or below −10 °F (all regions, own samples)\n",
              "A false alarm removes a resort that was skiable; a miss keeps one that wasn't.\n",
              md(con, f"""SELECT split, source_label AS source, lead, count(*) AS days,
                               count(*) FILTER (WHERE obs <= {veto_c}) AS "cold days",
                               count(*) FILTER (WHERE fc <= {veto_c}) AS "vetoed",
                               round(count(*) FILTER (WHERE fc <= {veto_c} AND obs <= {veto_c})
                                     / nullif(count(*) FILTER (WHERE obs <= {veto_c}), 0), 2) AS pod,
                               round(count(*) FILTER (WHERE fc <= {veto_c} AND obs > {veto_c})
                                     / nullif(count(*) FILTER (WHERE fc <= {veto_c}), 0), 2) AS far
                        FROM td WHERE var = 'lift' AND lead IN (1, 3, 5) AND split IN ('test', 'live')
                        GROUP BY ALL ORDER BY split, lead, source""")]
    parts += ["\n### Bias by region, lead 1–3 (°F, + = forecast too warm)\n",
              md(con, f"""PIVOT (SELECT var, macro AS region, source_label AS source,
                                 round(sum(bias_f * n) / sum(n), 1) AS b
                          FROM tday WHERE lead BETWEEN 1 AND 3 AND macro <> 'ALL' AND split IN ('test', 'live')
                            AND (source_label IN ('ours (temps)', 'snow-forecast', 'nws', 'nbm')
                                 OR source_label LIKE 'dynamical-ens%')
                          GROUP BY ALL) ON source USING any_value(b) GROUP BY var, region ORDER BY var, region""")]
    return "\n".join(parts)


# --------------------------------------------------------------------------- snowfall
def snowfall(con, out: Path) -> str:
    pp = out / "pairs.parquet"
    if not pp.exists():
        return "## Snowfall\n\n_pairs.parquet missing — build.py failed upstream._\n"
    con.execute(f"""
    CREATE TABLE sd AS
    SELECT p.source_label, any_value(p.paid) AS paid, p.space, p.split, p.resort_id, any_value(z.region) AS region,
           any_value(z.macro) AS macro, p.local_date, p.lead_day AS lead, avg(p.fc_amount) AS fc, any_value(p.obs) AS obs
    FROM read_parquet('{pp}') p JOIN rz z USING (resort_id)
    WHERE p.obs IS NOT NULL AND p.fc_amount IS NOT NULL AND p.pair_quality = 'strict' AND p.tier = 'mid'
      AND p.lead_day BETWEEN 0 AND 7
    GROUP BY p.source_label, p.space, p.split, p.resort_id, p.local_date, p.lead_day""")
    bp = out / "blend.json"
    ours_note = "blend-v1 not found — ours not scored."
    if bp.exists():
        b = json.loads(bp.read_text())
        con.execute("CREATE TABLE bw(lead INTEGER, model VARCHAR, w DOUBLE)")
        con.executemany("INSERT INTO bw VALUES (?, ?, ?)",
                        [(int(l), m, v) for l, ws in b["weights"].items() for m, v in ws.items()])
        con.execute("CREATE TABLE bf(model VARCHAR, lead INTEGER, region VARCHAR, f DOUBLE)")
        # Trace floor (blend.py), only where promoted — exactly what the live forecast applies.
        con.execute("CREATE TABLE bfloor(lead INTEGER, f DOUBLE)")
        fl = [(int(l), float(f)) for l, f in (b.get("trace_floor_mm") or {}).items()
              if (b.get("trace_floor_promote") or {}).get(l)]
        if fl:
            con.executemany("INSERT INTO bfloor VALUES (?, ?)", fl)
        bf_rows = [(k.split("|")[0], int(k.split("|")[1]), k.split("|")[2], v) for k, v in b["factors"].items()]
        if bf_rows:
            con.executemany("INSERT INTO bf VALUES (?, ?, ?, ?)", bf_rows)
        con.execute("CREATE TABLE bpool(model VARCHAR, lead INTEGER, f DOUBLE)")
        con.executemany("INSERT INTO bpool VALUES (?, ?, ?)",
                        [(k.split("|")[0], int(k.split("|")[1]), v) for k, v in b["pooled_factors"].items()])
        # Same arithmetic as blend.py: region factor else pooled; weights re-normalised over models present.
        con.execute("""
        INSERT INTO sd
        SELECT 'ours (blend-v1)', false, 'liquid', d.split, d.resort_id, any_value(d.region), any_value(d.macro),
               d.local_date, d.lead, sum(bw.w * d.fc * coalesce(bf.f, bpool.f, 1.0)) / sum(bw.w), any_value(d.obs)
        FROM (SELECT *, split_part(source_label, ':', 2) AS model FROM sd
              WHERE space = 'liquid' AND source_label LIKE 'open-meteo-previous-runs:%') d
        JOIN bw ON bw.lead = d.lead AND bw.model = d.model
        LEFT JOIN bf ON bf.model = d.model AND bf.lead = d.lead AND bf.region = d.region
        LEFT JOIN bpool ON bpool.model = d.model AND bpool.lead = d.lead
        GROUP BY d.split, d.resort_id, d.local_date, d.lead""")
        con.execute("""UPDATE sd SET fc = 0 FROM bfloor
                       WHERE sd.source_label = 'ours (blend-v1)' AND sd.lead = bfloor.lead AND sd.fc < bfloor.f""")
        ours_note = ("Ours = blend-v1: region-corrected, inverse-error weighted ECMWF / GEM / GFS precipitation, "
                     "fitted on 2024-25 (LIQUID, mm of water). Leads 1–7.")
    # Ours in SNOW: blend-v1 water × SLR (slr.py; v2 is fitted on same-station new snow + water). Same arithmetic
    # as scripts/projections/build_dyn.py: SLR = a + b·T clamped, at the slope temperature; warm days (> 2 °C) = rain.
    sp = out / "slr.json"
    slr_note = "No fitted SLR — ours has no snow number."
    if bp.exists() and sp.exists():
        sl = json.loads(sp.read_text())
        prom = sl.get("promote") or {}
        con.execute(f"""
        CREATE TABLE stemp AS
        SELECT resort_id, local_date, lead_day AS lead, split, avg(fc_temp_c) AS t
        FROM read_parquet('{pp}') WHERE source = 'open-meteo-previous-runs' AND space = 'liquid' AND tier = 'mid'
          AND fc_temp_c IS NOT NULL GROUP BY ALL""")
        lo_, hi_ = sl["clamp"]
        # slr-v3: a resort's region line where promoted, else pooled (same as the app).
        con.execute("CREATE TABLE sline(resort_id VARCHAR, a DOUBLE, b DOUBLE)")
        lines = [(rid, e["a"], e["b"]) for rid, reg in (sl.get("region_of") or {}).items()
                 for e in [(sl.get("regions") or {}).get(reg, {})] if e.get("promoted") and "a" in e]
        if lines:
            con.executemany("INSERT INTO sline VALUES (?, ?, ?)", lines)
        con.execute(f"""
        INSERT INTO sd
        SELECT 'ours (blend × SLR)', false, 'snow', o.split, o.resort_id, o.region, o.macro, o.local_date, o.lead,
               CASE WHEN t.t > 2 THEN 0 ELSE o.fc * least(greatest(coalesce(l.a, {sl['a']}) + coalesce(l.b, {sl['b']}) * t.t,
                                                                  {lo_}), {hi_}) / 10 END,
               s.obs
        FROM sd o JOIN stemp t USING (resort_id, local_date, lead, split)
        LEFT JOIN sline l ON l.resort_id = o.resort_id
        JOIN (SELECT DISTINCT resort_id, local_date, lead, split, obs FROM sd WHERE space = 'snow') s
          USING (resort_id, local_date, lead, split)
        WHERE o.source_label = 'ours (blend-v1)'""")
        slr_note = (f"Ours in snow = blend-v1 water × {sl.get('version')} (SLR = {sl['a']} + {sl['b']}·T); "
                    f"promoted at leads {sorted(k for k, v in prom.items() if v) or 'none'}. "
                    "Snow truth here is SNOTEL depth gain, which settles — every source is judged on it the same way, "
                    "but a correct ratio will look like a slight over-forecast.")
    con.execute("CREATE TABLE sthr(space VARCHAR, t DOUBLE)")
    con.executemany("INSERT INTO sthr VALUES (?, ?)",
                    [("liquid", 2.5), ("liquid", 10.0), ("liquid", 20.0), ("snow", 2.5), ("snow", 15.0), ("snow", 30.0)])
    sc = f"""
      count(*) AS n, sum(CAST(o AS INT)) AS events,
      sum(CAST(f AND o AS INT)) / nullif(sum(CAST(o AS INT)), 0) AS pod,
      sum(CAST(f AND NOT o AS INT)) / nullif(sum(CAST(f AS INT)), 0) AS far,
      sum(CAST(f AND o AS INT)) / nullif(sum(CAST(f OR o AS INT)), 0) AS csi,
      sum(CAST(f AS INT)) / nullif(sum(CAST(o AS INT)), 0) AS freq_bias,
      sum(CAST(o AS INT)) < {THIN} AS thin"""
    con.execute(f"""
    CREATE TABLE sscore AS
    WITH s AS (SELECT sd.*, sthr.t, sd.fc >= sthr.t AS f, sd.obs >= sthr.t AS o FROM sd JOIN sthr USING (space))
    SELECT source_label, any_value(paid) AS paid, space, split, coalesce(macro, 'ALL') AS macro, lead, t AS threshold, {sc}
    FROM s GROUP BY GROUPING SETS ((source_label, space, split, macro, lead, t), (source_label, space, split, lead, t))""")
    con.execute(f"COPY (SELECT * FROM sscore ORDER BY ALL) TO '{out / 'digest_snow.csv'}' (HEADER)")

    # Head-to-head in each space against Snow-Forecast on identical resort-days.
    con.execute(f"""
    CREATE TABLE sh2h AS
    WITH k AS (SELECT space, split, resort_id, local_date, lead FROM sd GROUP BY ALL
               HAVING bool_or(source_label = 'snow-forecast')
                  AND bool_or(source_label IN ('ours (blend-v1)', 'ours (blend × SLR)',
                                               'open-meteo-previous-runs:ecmwf_ifs025'))),
         s AS (SELECT sd.*, sthr.t, sd.fc >= sthr.t AS f, sd.obs >= sthr.t AS o
               FROM sd JOIN k USING (space, split, resort_id, local_date, lead) JOIN sthr USING (space))
    SELECT source_label, any_value(paid) AS paid, space, split, coalesce(macro, 'ALL') AS macro, lead, t AS threshold, {sc}
    FROM s GROUP BY GROUPING SETS ((source_label, space, split, macro, lead, t), (source_label, space, split, lead, t))""")
    con.execute(f"COPY (SELECT * FROM sh2h ORDER BY ALL) TO '{out / 'digest_snow_h2h.csv'}' (HEADER)")

    def csi_table(table: str, space: str, thr: float, where: str = "") -> str:
        return md(con, f"""PIVOT (SELECT split, macro AS region,
                                   replace(source_label, 'open-meteo-previous-runs:', '') ||
                                     CASE WHEN paid THEN ' (paid)' ELSE '' END AS source,
                                   lead, round(csi, 2) || CASE WHEN thin THEN '*' ELSE '' END AS v
                            FROM {table} WHERE space = '{space}' AND threshold = {thr} AND lead BETWEEN 1 AND 7 {where})
                           ON lead USING any_value(v) GROUP BY split, region, source
                           ORDER BY CASE split WHEN 'live' THEN 0 ELSE 1 END, region = 'ALL' DESC, region, source""")

    gate = snow_gate(con)
    parts = ["## 2. Snowfall and precipitation (hit rates vs SNOTEL / BC pillows, strict mid pairs)\n",
             ours_note, "\n" + slr_note + "\n", gate,
             "\nCSI = hits ÷ (hits + misses + false alarms): 1 is perfect, 0 is useless. "
             "`*` = fewer than 20 observed events (thin — not a result). Columns are lead days.\n",
             "\n### Snow ≥ 15 cm (powder day), Snow-Forecast vs the models on the same resort-days\n",
             csi_table("sh2h", "snow", 15.0),
             "\n### Any snow ≥ 2.5 cm, same resort-days\n",
             csi_table("sh2h", "snow", 2.5, "AND macro = 'ALL'"),
             "\n### Water ≥ 10 mm — ours (blend-v1) vs Snow-Forecast vs models, same resort-days\n",
             csi_table("sh2h", "liquid", 10.0),
             "\n### Hit rate and false alarms at snow ≥ 15 cm, all regions, lead 1 / 3 / 5\n",
             md(con, """SELECT split, replace(source_label, 'open-meteo-previous-runs:', '') AS source, lead,
                               n, events, round(pod, 2) AS pod, round(far, 2) AS far, round(csi, 2) AS csi,
                               round(freq_bias, 2) AS "freq bias"
                        FROM sh2h WHERE space = 'snow' AND threshold = 15 AND macro = 'ALL' AND lead IN (1, 3, 5)
                        ORDER BY split, lead, csi DESC NULLS LAST"""),
             "\n### Own samples (each source on every day it forecast — NOT head-to-head), snow ≥ 15 cm, all regions\n",
             csi_table("sscore", "snow", 15.0, "AND macro = 'ALL' AND split IN ('test', 'live')"),
             "\n### Own samples, snow ≥ 15 cm, by region (test winter)\n",
             csi_table("sscore", "snow", 15.0, "AND macro <> 'ALL' AND split = 'test' AND (source_label LIKE 'ours%' "
                       "OR source_label = 'open-meteo-previous-runs:ecmwf_ifs025' OR paid)"),
             "\n### Own samples, water ≥ 10 mm, all regions\n",
             csi_table("sscore", "liquid", 10.0, "AND macro = 'ALL' AND split IN ('test', 'live')"),
             "\n### Sample: observed snow ≥ 15 cm days by region (same-day sample)\n",
             md(con, """PIVOT (SELECT split, macro AS region, lead, max(events) AS e FROM sh2h
                               WHERE space = 'snow' AND threshold = 15 AND lead BETWEEN 1 AND 7 GROUP BY ALL)
                        ON lead USING any_value(e) GROUP BY split, region ORDER BY split, region""")]
    return "\n".join(parts)


GATE_EVENTS = 40      # observed ≥ 15 cm days on shared resort-days before a lead can be judged
GATE_LEADS = range(1, 7)


def snow_gate(con) -> str:
    """Days 1–6 show Snow-Forecast today. Ours may replace it at a lead only when, on the SAME resort-days
    (live season, then test winter if Snow-Forecast was archived there), ours beats it at snow ≥ 15 cm with
    the whole 90 % date-bootstrap range above zero, ≥ GATE_EVENTS observed events, and is not worse at ≥ 2.5 cm."""
    rng = np.random.default_rng(20261115)
    rows = []
    for split in ("live", "test"):
        for lead in GATE_LEADS:
            r = con.execute(f"""
              WITH k AS (SELECT resort_id, local_date FROM sd WHERE space = 'snow' AND split = '{split}' AND lead = {lead}
                         GROUP BY ALL HAVING bool_or(source_label = 'snow-forecast')
                            AND bool_or(source_label = 'ours (blend × SLR)'))
              SELECT sd.local_date, max(CASE WHEN source_label = 'ours (blend × SLR)' THEN fc END) AS ours,
                     max(CASE WHEN source_label = 'snow-forecast' THEN fc END) AS sf, any_value(obs) AS obs
              FROM sd JOIN k USING (resort_id, local_date)
              WHERE sd.space = 'snow' AND sd.split = '{split}' AND sd.lead = {lead}
              GROUP BY sd.resort_id, sd.local_date""").fetchnumpy()
            n = len(r["obs"])
            row = {"split": split, "lead": lead, "days": n}
            if n == 0:
                rows.append({**row, "status": "no shared days"}); continue
            ud, inv = np.unique(r["local_date"], return_inverse=True)
            idx = rng.integers(0, len(ud), size=(1000, len(ud)))
            for thr in (2.5, 15.0):
                o = r["obs"] >= thr
                res = []
                for col in ("ours", "sf"):
                    f = r[col] >= thr
                    H = np.bincount(inv, (f & o).astype(int), len(ud)); FA = np.bincount(inv, (f & ~o).astype(int), len(ud))
                    M = np.bincount(inv, (~f & o).astype(int), len(ud))
                    res.append((H.sum() / max(H.sum() + M.sum() + FA.sum(), 1),
                                H[idx].sum(1) / np.maximum(H[idx].sum(1) + M[idx].sum(1) + FA[idx].sum(1), 1)))
                d = res[0][1] - res[1][1]
                row[f"ev{thr:g}"] = int(o.sum())
                row[f"ours{thr:g}"], row[f"sf{thr:g}"] = float(res[0][0]), float(res[1][0])
                row[f"d{thr:g}"] = (float(np.percentile(d, 5)), float(np.percentile(d, 95)))
            if row["ev15"] < GATE_EVENTS:
                row["status"] = f"too few powder days ({row['ev15']} of {GATE_EVENTS})"
            elif row["d15"][0] > 0 and row["d2.5"][1] >= 0:
                row["status"] = "OURS AHEAD — eligible to replace Snow-Forecast"
            elif row["d15"][1] < 0:
                row["status"] = "Snow-Forecast ahead"
            else:
                row["status"] = "no real difference yet"
            rows.append(row)
    f = lambda v: "—" if v is None else f"{v:.2f}"
    rng_ = lambda t: "—" if t is None else f"{t[0]:+.2f} to {t[1]:+.2f}"
    lines = ["\n### Gate: may ours replace Snow-Forecast on days 1–6?\n",
             f"Rule: same resort-days, ≥ {GATE_EVENTS} observed ≥ 15 cm days, ours − Snow-Forecast CSI at 15 cm "
             "above zero across the 90% range, and not worse at 2.5 cm. Until a lead passes, the app keeps "
             "Snow-Forecast there.\n",
             "| winter | lead | shared days | ≥15 events | ours CSI 15 | SF CSI 15 | ours − SF (15) | ours − SF (2.5) | status |",
             "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['split']} | {r['lead']} | {r['days']} | {r.get('ev15', '—')} | {f(r.get('ours15'))} | "
                     f"{f(r.get('sf15'))} | {rng_(r.get('d15'))} | {rng_(r.get('d2.5'))} | {r['status']} |")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- wind
def wind(con, archive: Path, out: Path) -> str:
    def view(name: str, source: str) -> bool:
        # Wind truth starts 2026-11-11: read only this month on, not two winters of ensembles.
        files = sorted(str(p) for p in archive.glob(f"source={source}/month=*/*.parquet")
                       if p.parent.name[len("month="):] >= "2026-11")
        if not files:
            con.execute(f"CREATE TABLE {name} AS SELECT NULL::VARCHAR AS source WHERE false")
            return False
        fl = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
        con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet({fl}, union_by_name = true, hive_partitioning = false)")
        return True

    head = ["## 3. Wind (mph) vs measured wind on the mountain\n",
            "Truth: SLF IMIS stations (Swiss network; snow stations and ridge wind stations within 30 km), "
            "half-hourly, live since 2026-11-11. No US or Canadian wind truth is archived yet "
            "(Synoptic trial from December), so every other region reads 'no truth'.\n"]
    if not view("slf_raw", "slf"):
        return "\n".join(head + ["_no SLF rows in the archive_\n"])
    view("sf_raw", "snow-forecast")
    has_dyn = view("dyn_raw", "dynamical-ens")
    has_ec = view("ec_raw", "ecmwf-opendata")

    con.execute("""
    CREATE TABLE wst AS
    SELECT resort_id, station_id, any_value(elevation_m) AS st_elev, any_value(value_text) AS st_type
    FROM slf_raw WHERE kind = 'mapping' AND station_id LIKE 'imis:%' AND resort_id IS NOT NULL
    GROUP BY resort_id, station_id""")
    con.execute("""
    CREATE TABLE wobs AS
    SELECT station_id, valid_end AS t,
           max(CASE WHEN variable = 'wind_speed_mean' THEN value END) AS spd,
           max(CASE WHEN variable = 'wind_gust_max' THEN value END) AS gust
    FROM (SELECT * FROM slf_raw WHERE kind = 'observation' AND station_id LIKE 'imis:%'
            AND variable IN ('wind_speed_mean', 'wind_gust_max') AND value IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY station_id, variable, valid_end ORDER BY fetched_at DESC) = 1)
    GROUP BY station_id, valid_end""")
    n_obs = con.execute("SELECT count(*), count(DISTINCT station_id), strftime(min(t), '%Y-%m-%d %H:%MZ'), strftime(max(t), '%Y-%m-%d %H:%MZ') FROM wobs WHERE spd IS NOT NULL").fetchone()
    # Tier heights from Snow-Forecast's own pages; each station goes to the nearest tier.
    con.execute("""
    CREATE TABLE tiers AS
    SELECT resort_id, tier, median(elevation_m) AS tier_elev FROM sf_raw
    WHERE source = 'snow-forecast' AND kind = 'forecast' AND tier IN ('bot', 'mid', 'top') AND elevation_m IS NOT NULL
    GROUP BY resort_id, tier""")
    con.execute("""
    CREATE TABLE wcls AS
    SELECT w.*, t.tier, t.tier_elev, w.st_elev - t.tier_elev AS delev
    FROM wst w JOIN tiers t USING (resort_id)
    QUALIFY row_number() OVER (PARTITION BY w.resort_id, w.station_id ORDER BY abs(w.st_elev - t.tier_elev)) = 1""")

    # Forecast windows from each source → observed mean / max over the same window (≥ 80 % of half-hours).
    con.execute("""
    CREATE TABLE wfc(source VARCHAR, paid BOOLEAN, resort_id VARCHAR, tier VARCHAR, issue TIMESTAMPTZ,
                     valid_start TIMESTAMPTZ, valid_end TIMESTAMPTZ, fc_kmh DOUBLE, kind VARCHAR)""")
    con.execute("""
    INSERT INTO wfc
    SELECT 'snow-forecast', true, resort_id, tier, fetched_at, valid_start, valid_end, value, 'period mean'
    FROM sf_raw WHERE source = 'snow-forecast' AND kind = 'forecast' AND variable = 'wind_speed'
      AND value IS NOT NULL AND tier IN ('bot', 'mid', 'top') AND valid_start >= TIMESTAMPTZ '2026-11-10'""")
    if has_dyn:
        con.execute("""
        INSERT INTO wfc
        SELECT 'dynamical-ens:' || model, false, resort_id, NULL, issued_at, valid_start, valid_end,
               median(value), 'block max (10 m)'
        FROM dyn_raw WHERE kind = 'forecast' AND variable = 'wind_speed_max' AND value IS NOT NULL
          AND valid_start >= TIMESTAMPTZ '2026-11-10' AND resort_id IN (SELECT resort_id FROM wst)
        GROUP BY model, resort_id, issued_at, valid_start, valid_end""")
    if has_ec:
        con.execute("""
        INSERT INTO wfc
        SELECT 'ecmwf-opendata:' || model || ' 700 hPa', false, resort_id, 'top', issued_at, valid_start, valid_end,
               median(value), 'instant (free air)'
        FROM ec_raw WHERE variable = 'wspd_700hpa' AND value IS NOT NULL
          AND valid_start >= TIMESTAMPTZ '2026-11-10' AND resort_id IN (SELECT resort_id FROM wst)
        GROUP BY model, resort_id, issued_at, valid_start, valid_end""")
    con.execute("""
    CREATE TABLE wpair AS
    WITH f AS (SELECT wfc.*, z.tz FROM wfc JOIN rz z USING (resort_id)),
         m AS (
      SELECT f.source, f.paid, f.kind, f.resort_id, c.station_id, c.tier AS st_tier, c.st_type, f.issue, f.tz,
             f.valid_start, f.valid_end, f.fc_kmh,
             -- instants: the half-hour reading ending at that time; windows: mean / max over the window
             avg(o.spd) AS obs_mean, max(o.spd) AS obs_max_mean, max(o.gust) AS obs_gust, count(o.spd) AS n_half,
             greatest(1, epoch(f.valid_end - f.valid_start) / 1800) AS need
      FROM f JOIN wcls c ON c.resort_id = f.resort_id AND (f.tier IS NULL OR f.tier = c.tier)
      JOIN wobs o ON o.station_id = c.station_id
        AND ((f.valid_end = f.valid_start AND o.t = f.valid_end)
             OR (o.t > f.valid_start AND o.t <= f.valid_end))
      GROUP BY ALL)
    SELECT *, datediff('day', CAST(timezone(tz, issue) AS DATE), CAST(timezone(tz, valid_start) AS DATE)) AS lead,
           CASE WHEN kind = 'block max (10 m)' THEN obs_max_mean ELSE obs_mean END AS obs_kmh
    FROM m WHERE n_half >= 0.8 * need AND issue <= valid_start""")
    con.execute(f"""
    CREATE TABLE wscore AS
    SELECT source, any_value(paid) AS paid, any_value(kind) AS kind, st_tier AS station_class, lead,
           count(*) AS n, count(DISTINCT station_id) AS stations, count(DISTINCT CAST(valid_start AS DATE)) AS days,
           avg(abs(fc_kmh - obs_kmh)) * {KMH_TO_MPH} AS mae_mph, avg(fc_kmh - obs_kmh) * {KMH_TO_MPH} AS bias_mph,
           avg(obs_kmh) * {KMH_TO_MPH} AS obs_mean_mph,
           sum(CAST(obs_kmh * {KMH_TO_MPH} >= {VETO_MPH} AS INT)) AS veto_obs,
           sum(CAST(fc_kmh * {KMH_TO_MPH} >= {VETO_MPH} AS INT)) AS veto_fc,
           sum(CAST(fc_kmh * {KMH_TO_MPH} >= {VETO_MPH} AND obs_kmh * {KMH_TO_MPH} >= {VETO_MPH} AS INT)) AS veto_hit,
           sum(CAST(obs_gust * {KMH_TO_MPH} >= {VETO_MPH} AS INT)) AS gust45_obs
    FROM wpair WHERE lead BETWEEN 0 AND 7 GROUP BY source, st_tier, lead""")
    con.execute(f"COPY (SELECT * FROM wscore ORDER BY ALL) TO '{out / 'digest_wind.csv'}' (HEADER)")
    stations = md(con, """SELECT tier AS "class (nearest tier)", count(*) AS stations,
                                 round(avg(delev)) AS "avg m from tier", string_agg(DISTINCT st_type, ', ') AS types
                          FROM wcls GROUP BY tier ORDER BY tier""")
    parts = head + [
        f"Truth so far: {n_obs[0]} half-hour readings from {n_obs[1]} stations, {n_obs[2]} → {n_obs[3]}.\n",
        "\n### Stations by height class\n", stations,
        "\n### Sustained wind error by station height and lead (mph; own samples)\n",
        "Snow-Forecast's period wind is compared with the station's mean over the period at the matching tier. "
        "Model 10 m block maxima are compared with the highest half-hour mean in the block. "
        "700 hPa is free-air wind, compared with top-class stations at that instant.\n",
        md(con, """SELECT source || CASE WHEN paid THEN ' (paid)' ELSE '' END AS source, station_class AS class, lead,
                          n, days, round(mae_mph, 1) AS mae, round(bias_mph, 1) AS bias, round(obs_mean_mph, 1) AS "obs mean",
                          veto_obs AS "≥45 obs", veto_fc AS "≥45 fc", veto_hit AS "≥45 hit", gust45_obs AS "gust≥45 obs"
                   FROM wscore ORDER BY source, class, lead"""),
    ]
    return "\n".join(parts)


# --------------------------------------------------------------------------- resort reports
def resort_reports(con, out: Path) -> str:
    """What skiers are told the next morning (Brian, 2026-11-17): every snow forecast scored against the
    resort's own reported new snow (OnTheSnow `reported_daily_snow`, archived since Oct 2026). Self-reported
    and often generous, so it sits BESIDE the gauge truth, never replaces it. Fresh snow on a board — the
    definition the app's daily number aims at. No station needed, so every app resort that reports counts."""
    pp = out / "pairs.parquet"
    head = ["## 4. Against resort-reported new snow (what skiers are told)\n",
            "Truth: each resort's own daily new-snow report (OnTheSnow). Self-reported, unaudited, often generous; "
            "a fresh-snow (board) number, not settled depth. `*` = fewer than 20 observed events (thin).\n"]
    if not pp.exists():
        return "\n".join(head + ["_pairs.parquet missing_\n"])
    con.execute(f"""
    CREATE TABLE rb AS
    SELECT p.source_label, any_value(p.paid) AS paid, p.space, p.split, p.resort_id, any_value(z.region) AS region,
           any_value(z.macro) AS macro, p.local_date, p.lead_day AS lead, avg(p.fc_amount) AS fc
    FROM read_parquet('{pp}') p JOIN rz z USING (resort_id)
    WHERE p.fc_amount IS NOT NULL AND coalesce(p.tier, 'mid') = 'mid' AND p.lead_day BETWEEN 0 AND 7
    GROUP BY p.source_label, p.space, p.split, p.resort_id, p.local_date, p.lead_day""")
    con.execute(f"""
    CREATE TABLE rep AS
    SELECT resort_id, local_date, any_value(ots_reported_cm) AS rep FROM read_parquet('{pp}')
    WHERE ots_reported_cm IS NOT NULL GROUP BY ALL""")
    n_rep = con.execute("SELECT count(*), count(DISTINCT resort_id), min(local_date), max(local_date) FROM rep").fetchone()
    if not n_rep[0]:
        return "\n".join(head + ["_no resort reports paired yet_\n"])
    # Ours, exactly as in section 2 but without needing a gauge on the day (bw / bf / bpool / stemp / sline).
    have = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables").fetchall()}
    if {"bw", "bf", "bpool", "stemp", "bfloor"} <= have:
        sl = json.loads((out / "slr.json").read_text())
        lo_, hi_ = sl["clamp"]
        line = "LEFT JOIN sline l ON l.resort_id = o.resort_id" if "sline" in have else \
               "LEFT JOIN (SELECT NULL::VARCHAR AS resort_id, NULL::DOUBLE AS a, NULL::DOUBLE AS b) l ON false"
        con.execute(f"""
        INSERT INTO rb
        WITH w0 AS (
          SELECT d.split, d.resort_id, any_value(d.region) AS region, any_value(d.macro) AS macro, d.local_date, d.lead,
                 sum(bw.w * d.fc * coalesce(bf.f, bpool.f, 1.0)) / sum(bw.w) AS fc0
          FROM (SELECT *, split_part(source_label, ':', 2) AS model FROM rb
                WHERE space = 'liquid' AND source_label LIKE 'open-meteo-previous-runs:%') d
          JOIN bw ON bw.lead = d.lead AND bw.model = d.model
          LEFT JOIN bf ON bf.model = d.model AND bf.lead = d.lead AND bf.region = d.region
          LEFT JOIN bpool ON bpool.model = d.model AND bpool.lead = d.lead
          GROUP BY d.split, d.resort_id, d.local_date, d.lead),
             w AS (SELECT w0.*, CASE WHEN w0.fc0 < coalesce(bfloor.f, 0) THEN 0 ELSE w0.fc0 END AS fc
                   FROM w0 LEFT JOIN bfloor ON bfloor.lead = w0.lead)
        SELECT 'ours (blend × SLR)', false, 'snow', o.split, o.resort_id, o.region, o.macro, o.local_date, o.lead,
               CASE WHEN t.t > 2 THEN 0 ELSE o.fc * least(greatest(coalesce(l.a, {sl['a']}) + coalesce(l.b, {sl['b']}) * t.t,
                                                                  {lo_}), {hi_}) / 10 END
        FROM w o JOIN stemp t USING (resort_id, local_date, lead, split) {line}""")
    # Which day does a report belong to? A report dated D is the 24 h ending that MORNING, so it may match the
    # forecast for D (lag 0) or D − 1 (lag 1). Chosen by the data, pooled over sources, and printed.
    lags = con.execute("""
      SELECT lag, corr(r.fc, rep.rep), count(*) FROM (SELECT 0 AS lag UNION ALL SELECT 1) g
      JOIN rb r ON r.space = 'snow' AND r.lead BETWEEN 1 AND 3
      JOIN rep ON rep.resort_id = r.resort_id AND rep.local_date = r.local_date + g.lag
      GROUP BY lag ORDER BY lag""").fetchall()
    good = [x for x in lags if x[1] is not None and x[1] == x[1]]  # drop NULL / NaN correlations
    lag = max(good, key=lambda x: x[1])[0] if good else 0
    con.execute(f"""
    CREATE TABLE rr AS
    SELECT r.*, rep.rep AS obs FROM rb r JOIN rep ON rep.resort_id = r.resort_id AND rep.local_date = r.local_date + {lag}
    WHERE r.space = 'snow'""")
    con.execute(f"COPY (SELECT * FROM rr ORDER BY ALL) TO '{out / 'digest_resort_reports.csv'}' (HEADER)")
    sc = f"""count(*) AS n, sum(CAST(obs >= t AS INT)) AS events,
      sum(CAST(fc >= t AND obs >= t AS INT)) / nullif(sum(CAST(obs >= t AS INT)), 0) AS pod,
      sum(CAST(fc >= t AND obs < t AS INT)) / nullif(sum(CAST(fc >= t AS INT)), 0) AS far,
      sum(CAST(fc >= t AND obs >= t AS INT)) / nullif(sum(CAST(fc >= t OR obs >= t AS INT)), 0) AS csi,
      sum(CAST(fc >= t AS INT)) / nullif(sum(CAST(obs >= t AS INT)), 0) AS freq_bias,
      sum(fc) FILTER (WHERE fc > 0 OR obs > 0) / nullif(sum(obs) FILTER (WHERE fc > 0 OR obs > 0), 0) AS volume,
      sum(CAST(obs >= t AS INT)) < {THIN} AS thin"""
    # Head-to-head: the same resort-days for ours, Snow-Forecast and OnTheSnow's own forecast.
    con.execute(f"""
    CREATE TABLE rrs AS
    WITH k AS (SELECT split, resort_id, local_date, lead FROM rr GROUP BY ALL
               HAVING bool_or(source_label = 'ours (blend × SLR)') AND bool_or(source_label = 'snow-forecast')),
         x AS (SELECT rr.*, t FROM rr JOIN k USING (split, resort_id, local_date, lead)
               CROSS JOIN (SELECT 2.5 AS t UNION ALL SELECT 15.0) th
               WHERE source_label IN ('ours (blend × SLR)', 'snow-forecast', 'onthesnow',
                                      'open-meteo-previous-runs:ecmwf_ifs025'))
    SELECT split, source_label, any_value(paid) AS paid, lead, t AS threshold, {sc} FROM x GROUP BY split, source_label, lead, t""")
    con.execute(f"COPY (SELECT * FROM rrs ORDER BY ALL) TO '{out / 'digest_resort_reports_h2h.csv'}' (HEADER)")
    lag_txt = ", ".join(f"lag {l}: r = {c:.2f} (n {n})" for l, c, n in good) or "no correlation yet, lag 0 by default"
    return "\n".join(head + [
        f"Reports paired: {n_rep[0]} resort-days from {n_rep[1]} resorts, {n_rep[2]} → {n_rep[3]}. "
        f"Report dated D matched to the forecast for D − {lag} ({lag_txt}).\n",
        "\n### Same resort-days: ours vs Snow-Forecast vs OnTheSnow's forecast vs raw ECMWF (7:1)\n",
        "`volume` = forecast ÷ reported snow on days either had snow (1.0 = same total). `freq bias` > 1 = forecasts "
        "the event more often than it is reported.\n",
        md(con, """SELECT split, replace(source_label, 'open-meteo-previous-runs:', '') ||
                          CASE WHEN paid THEN ' (paid)' ELSE '' END AS source,
                          lead, threshold AS "≥ cm", n, events, round(pod, 2) AS pod, round(far, 2) AS far,
                          round(csi, 2) || CASE WHEN thin THEN '*' ELSE '' END AS csi, round(freq_bias, 2) AS "freq bias",
                          round(volume, 2) AS volume
                   FROM rrs WHERE lead IN (1, 2, 3, 5) ORDER BY split, threshold DESC, lead, csi DESC NULLS LAST"""),
    ])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("archive", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--resorts", type=Path, default=Path(__file__).resolve().parents[2] / "src/data/resorts.json")
    a = ap.parse_args()
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    setup(con, a.resorts)
    sections = []
    for name, fn in (("temperature", lambda: temperature(con, a.out)), ("snowfall", lambda: snowfall(con, a.out)),
                     ("wind", lambda: wind(con, a.archive, a.out)),
                     ("resort reports", lambda: resort_reports(con, a.out))):
        try:
            sections.append(fn())
        except Exception as e:  # loud in the report AND the exit code, but the other sections still print
            sections.append(f"## {name}\n\n**FAILED:** `{type(e).__name__}: {e}`\n")
    text = ("# Tabulator accuracy digest\n\n"
            "Winters: `test` = 2025-26 (out of sample for our models), `live` = this season. "
            "Regions are grouped; per-state rows are in digest_*.csv. Contains paid-source scores — private.\n\n"
            + "\n".join(sections))
    (a.out / "digest.md").write_text(text)
    if "**FAILED:**" in text:
        raise SystemExit("digest: a section failed — see digest.md")


if __name__ == "__main__":
    main()
