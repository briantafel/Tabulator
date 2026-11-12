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
        con.execute("CREATE TABLE tw(var VARCHAR, lead INTEGER, model VARCHAR, w DOUBLE)")
        con.executemany("INSERT INTO tw VALUES (?, ?, ?, ?)",
                        [(v, int(l), mo, x) for v, ls in m["weights"].items() for l, ws in ls.items() for mo, x in ws.items()])
        con.execute("CREATE TABLE tc(model VARCHAR, resort_id VARCHAR, b DOUBLE)")
        con.executemany("INSERT INTO tc VALUES (?, ?, ?)",
                        [(k.split("|")[0], k.split("|")[1], v) for k, v in m["high_bias"].items()])
        n_models = len(m["models"])
        con.execute(f"""
        INSERT INTO td
        SELECT 'ours (temps-v1)', false, d.var, d.split, d.resort_id, any_value(d.macro), d.local_date, d.lead,
               sum(tw.w * (d.fc - CASE WHEN d.var = 'hi' THEN coalesce(tc.b, 0) ELSE 0 END)) / sum(tw.w),
               any_value(d.obs)
        FROM (SELECT *, split_part(source_label, ':', 2) AS model FROM td
              WHERE source_label LIKE 'open-meteo-previous-runs:%') d
        JOIN tw ON tw.var = d.var AND tw.lead = d.lead AND tw.model = d.model
        LEFT JOIN tc ON tc.model = d.model AND tc.resort_id = d.resort_id
        GROUP BY d.var, d.split, d.resort_id, d.local_date, d.lead HAVING count(*) = {n_models}""")
        ours_note = ("temps-v1 = per-resort high correction + inverse-error lead weights over ECMWF / GEM / GFS, "
                     "fitted on 2024-25. 2025-26 and this season are out of sample. Leads 1–7 only.")
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
               HAVING bool_or(source_label = 'ours (temps-v1)') AND bool_or(source_label = 'snow-forecast'))
    SELECT td.var, td.split, coalesce(td.macro, 'ALL') AS macro, td.lead, count(*) AS n,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'ours (temps-v1)') * {F} AS ours,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'snow-forecast') * {F} AS sf,
           avg(abs(td.fc - td.obs)) FILTER (WHERE source_label = 'nws') * {F} AS nws,
           count(*) FILTER (WHERE source_label = 'ours (temps-v1)') AS days
    FROM td JOIN k USING (var, split, resort_id, local_date, lead)
    GROUP BY GROUPING SETS ((td.var, td.split, td.macro, td.lead), (td.var, td.split, td.lead))""")
    con.execute("UPDATE th2h SET macro = 'ALL' WHERE macro IS NULL")
    con.execute(f"COPY (SELECT * FROM th2h ORDER BY ALL) TO '{out / 'digest_temp_h2h.csv'}' (HEADER)")

    parts = ["## 1. Temperature (°F, mean absolute error vs SNOTEL, strict mid pairs)\n", ours_note + "\n"]
    for var, name in (("hi", "Daily high"), ("lo", "Daily low")):
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
    parts += ["\n### Bias by region, lead 1–3 (°F, + = forecast too warm)\n",
              md(con, f"""PIVOT (SELECT var, macro AS region, source_label AS source,
                                 round(sum(bias_f * n) / sum(n), 1) AS b
                          FROM tday WHERE lead BETWEEN 1 AND 3 AND macro <> 'ALL' AND split IN ('test', 'live')
                            AND (source_label IN ('ours (temps-v1)', 'snow-forecast', 'nws', 'nbm')
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
        con.executemany("INSERT INTO bf VALUES (?, ?, ?, ?)",
                        [(k.split("|")[0], int(k.split("|")[1]), k.split("|")[2], v) for k, v in b["factors"].items()])
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
        ours_note = ("Ours = blend-v1: region-corrected, inverse-error weighted ECMWF / GEM / GFS precipitation, "
                     "fitted on 2024-25. It is LIQUID (mm of water); turning it into snow needs the fitted SLR, "
                     "which isn't approved yet. Leads 1–7.")
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
                  AND bool_or(source_label IN ('ours (blend-v1)', 'open-meteo-previous-runs:ecmwf_ifs025'))),
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

    parts = ["## 2. Snowfall and precipitation (hit rates vs SNOTEL / BC pillows, strict mid pairs)\n",
             ours_note,
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
             "\n### Sample: observed snow ≥ 15 cm days by region (same-day sample)\n",
             md(con, """PIVOT (SELECT split, macro AS region, lead, max(events) AS e FROM sh2h
                               WHERE space = 'snow' AND threshold = 15 AND lead BETWEEN 1 AND 7 GROUP BY ALL)
                        ON lead USING any_value(e) GROUP BY split, region ORDER BY split, region""")]
    return "\n".join(parts)


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
                     ("wind", lambda: wind(con, a.archive, a.out))):
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
