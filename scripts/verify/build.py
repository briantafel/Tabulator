#!/usr/bin/env python3
"""Build the verification table: every archived forecast paired with what fell.

    python3 scripts/verify/build.py <archiveDir> <outDir> [--resorts src/data/resorts.json]

<archiveDir> holds the bucket's `archive/` tree (source=*/month=*/*.parquet).
Writes to <outDir>:
  pairs.parquet          one row per forecast × resort × tier × resort-local day × space
  scores.parquet/.csv    hit rates, errors and volume ratios by source, lead day, region
  station_pairs.csv      which SNOTEL station stands in for each resort and tier
  report.md              the readable summary (contains paid-source scores: PRIVATE)
  log.txt                public-safe counts only (printed to the Action log)

Rules (project instructions + claude/verification-table-plan.md):
- Missing is NULL, never zero. A forecast day counts only when the forecast's
  periods cover all of that resort-local day; a partial day is dropped.
- Precipitation ("liquid", mm) and snowfall ("snow", cm) are scored
  separately. Open-Meteo's snowfall is precip × 0.7, so its liquid score is
  the one that means something.
- Truth is SNOTEL: liquid = daily SWE gain, snow = daily depth gain. Resort
  reports (OnTheSnow, "reported the following day") sit beside them as a
  flagged column and are never scored as truth. The Snow-Forecast hindcast is
  a forecast (its model at 0–6 h lead), never truth.
- Paid sources are tagged; nothing about them goes into log.txt, which the
  public Action log shows.
- Failures are loud: an impossible state raises instead of writing a table.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

PAID = ("snow-forecast", "snow-forecast-hindcast")
FORECAST_SOURCES = ("open-meteo-previous-runs", "open-meteo-ensemble", "snow-forecast",
                    "snow-forecast-hindcast", "nws", "onthesnow")
THRESHOLDS = {"liquid": (2.5, 10.0, 20.0), "snow": (2.5, 15.0, 30.0)}  # mm / cm per 24 h
STRICT_KM, STRICT_DELEV_M = 25.0, 300.0
MAX_SWE_GAIN_MM, MAX_DEPTH_GAIN_CM = 150.0, 150.0  # above this a daily gain is a sensor fault
THIN_EVENTS = 20  # fewer observed events than this → the score is flagged thin


def log(lines: list[str], msg: str) -> None:
    lines.append(msg)
    print(msg, file=sys.stderr)


def build(archive: Path, out: Path, resorts_path: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    public_log: list[str] = []
    files = sorted(str(p) for p in archive.rglob("*.parquet"))
    if not files:
        raise SystemExit(f"no parquet files under {archive}")

    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    file_list = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
    con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet({file_list}, union_by_name = true, hive_partitioning = false)")

    meta = json.loads(resorts_path.read_text())
    combine_max = meta.get("combine", {}).get("rule") == "max"
    resorts = [(r["id"], r["region"], r["tz"], len(r.get("slugs", [])) > 1) for r in meta["resorts"]]
    con.execute("CREATE TABLE resorts(resort_id VARCHAR, region VARCHAR, tz VARCHAR, multi_slug BOOLEAN)")
    con.executemany("INSERT INTO resorts VALUES (?, ?, ?, ?)", resorts)

    # ---------------------------------------------------------------- forecasts
    # Archived Snow-Forecast rows before parser sf-archive-3 / sf-hindcast-2 end
    # "night" 12 real hours after 18:00, which overlaps (spring) or leaves a gap
    # (autumn) across DST. Snow-Forecast's night is 18:00 → 06:00 local.
    con.execute("""
    CREATE VIEW fsrc AS
    SELECT r.* REPLACE (
      CASE WHEN r.source IN ('snow-forecast', 'snow-forecast-hindcast') AND r.period_label = 'night'
           THEN timezone(z.tz, CAST(CAST(timezone(z.tz, r.valid_start) AS DATE) + 1 AS TIMESTAMP) + INTERVAL 6 HOUR)
           ELSE r.valid_end END AS valid_end)
    FROM raw r LEFT JOIN resorts z USING (resort_id)""")
    con.execute(f"""
    CREATE TABLE f0 AS
    SELECT source, kind, resort_id, coalesce(tier, 'mid') AS tier, coalesce(station_id, '') AS station_id,
           coalesce(model, '') AS model, coalesce(member, -1) AS member,
           CASE WHEN variable = 'snow' THEN 'snow' ELSE 'liquid' END AS space,
           CASE WHEN source = 'open-meteo-previous-runs' THEN period_label
                ELSE strftime(coalesce(issued_at, fetched_at), '%Y-%m-%dT%H:%M:%SZ') END AS issue_key,
           CASE WHEN source = 'open-meteo-previous-runs' THEN NULL ELSE coalesce(issued_at, fetched_at) END AS issue_ts,
           valid_start, valid_end, value, fetched_at
    FROM fsrc
    WHERE kind IN ('forecast', 'hindcast') AND source IN {FORECAST_SOURCES}
      AND variable IN ('snow', 'precip') AND value IS NOT NULL AND resort_id IS NOT NULL
      AND valid_end > valid_start
    QUALIFY row_number() OVER (
      PARTITION BY source, resort_id, tier, station_id, model, member, issue_key, valid_start, valid_end, variable
      ORDER BY fetched_at DESC) = 1
    """)
    if con.execute("SELECT count(*) FROM f0").fetchone()[0] == 0:
        raise SystemExit("no forecast rows in the archive")
    unknown = con.execute("SELECT DISTINCT resort_id FROM f0 ANTI JOIN resorts USING (resort_id)").fetchall()
    if unknown:
        raise SystemExit(f"forecast rows for resorts not in resorts.json: {[u[0] for u in unknown]}")

    # Several slugs (Palisades) are faces of one mountain: snow takes the max.
    bad = con.execute("""
      SELECT DISTINCT source || '/' || resort_id FROM f0 JOIN resorts USING (resort_id)
      GROUP BY source, resort_id, multi_slug HAVING count(DISTINCT station_id) > 1 AND NOT multi_slug""").fetchall()
    if bad:
        raise SystemExit(f"several station_ids for single-slug resorts: {[b[0] for b in bad]}")
    agg = "max" if combine_max else "sum"
    con.execute(f"""
    CREATE TABLE f1 AS
    SELECT source, kind, resort_id, tier, model, member, space, issue_key, min(issue_ts) AS issue_ts,
           valid_start, valid_end, {agg}(value) AS value
    FROM f0 GROUP BY ALL""")

    # Split every period across the resort-local days it overlaps, pro rata.
    con.execute("""
    CREATE TABLE fday AS
    WITH x AS (
      SELECT f.*, r.tz, r.region,
             CAST(timezone(r.tz, f.valid_start) AS DATE) AS d0,
             CAST(timezone(r.tz, f.valid_end - INTERVAL 1 SECOND) AS DATE) AS d1
      FROM f1 f JOIN resorts r USING (resort_id)
    ), y AS (
      SELECT x.*, CAST(unnest(generate_series(CAST(d0 AS TIMESTAMP), CAST(d1 AS TIMESTAMP), INTERVAL 1 DAY)) AS DATE) AS local_date
      FROM x
    ), z AS (
      SELECT y.*, timezone(tz, CAST(local_date AS TIMESTAMP)) AS day_start,
             timezone(tz, CAST(local_date AS TIMESTAMP) + INTERVAL 1 DAY) AS day_end
      FROM y
    )
    SELECT source, kind, resort_id, region, tz, tier, model, member, space, issue_key,
           min(issue_ts) AS issue_ts, local_date, any_value(day_start) AS day_start,
           sum(value * epoch(least(valid_end, day_end) - greatest(valid_start, day_start))
                     / epoch(valid_end - valid_start)) AS fc_amount,
           sum(epoch(least(valid_end, day_end) - greatest(valid_start, day_start))) / 3600 AS cov_h,
           any_value(epoch(day_end - day_start) / 3600) AS day_h
    FROM z GROUP BY source, kind, resort_id, region, tz, tier, model, member, space, issue_key, local_date
    """)
    over = con.execute("SELECT count(*) FROM fday WHERE cov_h > day_h + 0.01").fetchone()[0]
    if over:
        # Details (may name paid sources) go to the sealed report; the public log gets counts only.
        con.execute(f"""COPY (
          SELECT d.source, d.resort_id, d.tier, d.model, d.member, d.space, d.issue_key, d.local_date, d.cov_h, d.day_h,
                 (SELECT string_agg(strftime(f.valid_start, '%m-%d %H:%M') || '→' || strftime(f.valid_end, '%m-%d %H:%M')
                                    || '=' || CAST(f.value AS VARCHAR), '; ' ORDER BY f.valid_start)
                  FROM f1 f WHERE f.source = d.source AND f.resort_id = d.resort_id AND f.tier = d.tier
                    AND f.model = d.model AND f.member = d.member AND f.space = d.space AND f.issue_key = d.issue_key
                    AND f.valid_end > d.day_start AND f.valid_start < d.day_start + INTERVAL 1 DAY) AS periods
          FROM fday d WHERE d.cov_h > d.day_h + 0.01 ORDER BY d.source, d.resort_id, d.local_date LIMIT 300
        ) TO '{out / 'diagnostics.csv'}' (HEADER)""")
        by = con.execute(f"""SELECT CASE WHEN source IN {PAID} THEN 'a paid source' ELSE source END, count(*)
                             FROM fday WHERE cov_h > day_h + 0.01 GROUP BY 1 ORDER BY 1""").fetchall()
        msg = f"{over} forecast days are covered more than once (overlapping periods within one issue): " + \
              ", ".join(f"{s} {n}" for s, n in by) + ". Details in the sealed report's diagnostics.csv."
        (out / "log.txt").write_text(msg + "\n")
        raise SystemExit(msg)
    con.execute("DELETE FROM fday WHERE cov_h < day_h - 0.01")  # partial day: not zero, just not scorable

    con.execute("""
    CREATE TABLE fc AS
    SELECT *,
      CASE WHEN source = 'open-meteo-previous-runs' THEN CAST(regexp_extract(issue_key, '(\\d+)$', 1) AS INTEGER)
           WHEN kind = 'hindcast' THEN 0
           ELSE datediff('day', CAST(timezone(tz, issue_ts) AS DATE), local_date) END AS lead_day,
      CASE WHEN source = 'open-meteo-previous-runs' THEN 24.0 * CAST(regexp_extract(issue_key, '(\\d+)$', 1) AS INTEGER)
           WHEN kind = 'hindcast' THEN 0.0
           ELSE epoch(day_start - issue_ts) / 3600 END AS lead_hours
    FROM fday""")
    con.execute("DELETE FROM fc WHERE lead_day < 0")

    # ---------------------------------------------------------------- forecast temperature
    # Snow-to-liquid ratio depends on the temperature WHILE it precipitates, so
    # each forecast day gets the 2 m temperature weighted by each 6 h block's
    # precipitation (plain mean when the day is dry). Open-Meteo sources only.
    con.execute("""
    CREATE TABLE ft AS
    WITH b AS (
      SELECT source, resort_id, coalesce(tier, 'mid') AS tier, coalesce(model, '') AS model,
             coalesce(member, -1) AS member,
             CASE WHEN source = 'open-meteo-previous-runs' THEN period_label
                  ELSE strftime(coalesce(issued_at, fetched_at), '%Y-%m-%dT%H:%M:%SZ') END AS issue_key,
             valid_start,
             avg(CASE WHEN variable IN ('temp_min', 'temp_max') THEN value END) AS t_mid,
             max(CASE WHEN variable = 'precip' THEN value END) AS p
      FROM raw
      WHERE source IN ('open-meteo-previous-runs', 'open-meteo-ensemble')
        AND variable IN ('temp_min', 'temp_max', 'precip') AND value IS NOT NULL
      GROUP BY ALL
    )
    SELECT b.source, b.resort_id, b.tier, b.model, b.member, b.issue_key,
           CAST(timezone(r.tz, b.valid_start + INTERVAL 3 HOUR) AS DATE) AS local_date,
           coalesce(sum(b.p * b.t_mid) / nullif(sum(CASE WHEN b.t_mid IS NOT NULL THEN b.p END), 0),
                    avg(b.t_mid)) AS fc_temp_c
    FROM b JOIN resorts r USING (resort_id)
    GROUP BY ALL""")

    # ---------------------------------------------------------------- truth: SNOTEL
    con.execute("""
    CREATE TABLE cand AS
    SELECT resort_id, station_id, arg_max(value, fetched_at) AS km, arg_max(elevation_m, fetched_at) AS st_elev,
           arg_max(value_text, fetched_at) AS station_name
    FROM raw WHERE source = 'snotel' AND kind = 'mapping' GROUP BY resort_id, station_id""")
    con.execute("""
    CREATE TABLE tier_elev AS
    SELECT resort_id, tier, mode(elevation_m) AS tier_elev FROM raw
    WHERE source IN ('snow-forecast', 'snow-forecast-hindcast') AND kind IN ('forecast', 'hindcast')
      AND elevation_m IS NOT NULL AND tier IS NOT NULL GROUP BY ALL""")
    con.execute(f"""
    CREATE TABLE station_pairs AS
    WITH c AS (
      SELECT t.resort_id, t.tier, t.tier_elev, c.station_id, c.station_name, c.km, c.st_elev,
             c.st_elev - t.tier_elev AS delev,
             c.km / {STRICT_KM} + abs(c.st_elev - t.tier_elev) / {STRICT_DELEV_M} AS score,
             c.km <= {STRICT_KM} AND abs(c.st_elev - t.tier_elev) <= {STRICT_DELEV_M} AS strict
      FROM tier_elev t JOIN cand c USING (resort_id)
    )
    SELECT resort_id, tier, tier_elev, station_id, station_name, km, st_elev, delev,
           CASE WHEN strict THEN 'strict' ELSE 'loose' END AS pair_quality
    FROM c QUALIFY row_number() OVER (PARTITION BY resort_id, tier ORDER BY strict DESC, score) = 1""")

    con.execute("""
    CREATE TABLE sn AS
    SELECT station_id, variable, valid_start, value FROM raw
    WHERE source = 'snotel' AND kind = 'observation' AND period_label = 'daily'
      AND variable IN ('swe', 'snow_depth', 'precip_accum') AND value IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY station_id, variable, valid_start ORDER BY fetched_at DESC) = 1""")

    # Is a daily SNOTEL value the reading at the START of its date or the END?
    # Test both against the newest model run's precipitation; the data decides.
    con.execute("""
    CREATE TABLE sn_day AS
    SELECT p.resort_id, p.tier, s.station_id, s.variable,
           CAST(timezone(r.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE) AS obs_date, s.value
    FROM sn s JOIN station_pairs p USING (station_id) JOIN resorts r USING (resort_id)""")
    con.execute("""
    CREATE TABLE sn_gain AS
    SELECT *,
      CASE WHEN datediff('day', obs_date, lead(obs_date) OVER w) = 1 THEN lead(value) OVER w - value END AS gain_start,
      CASE WHEN datediff('day', lag(obs_date) OVER w, obs_date) = 1 THEN value - lag(value) OVER w END AS gain_end
    FROM sn_day WINDOW w AS (PARTITION BY resort_id, tier, station_id, variable ORDER BY obs_date)""")
    corr = con.execute("""
      SELECT corr(f.fc_amount, g.gain_start), corr(f.fc_amount, g.gain_end), count(*)
      FROM fc f JOIN sn_gain g ON g.resort_id = f.resort_id AND g.tier = f.tier AND g.obs_date = f.local_date
      WHERE f.source = 'open-meteo-previous-runs' AND f.issue_key = 'previous_day0' AND f.space = 'liquid'
        AND g.variable = 'swe'""").fetchone()
    c_start, c_end, n_corr = corr
    if not n_corr:
        raise SystemExit("no overlap between model precipitation and SNOTEL SWE — cannot pair truth")
    align = "start" if (c_start or -1) >= (c_end or -1) else "end"
    log(public_log, f"SNOTEL day alignment: start-of-day r={c_start:.3f}, end-of-day r={c_end:.3f} "
                    f"(n={n_corr}) → using {align}-of-day readings")

    con.execute(f"""
    CREATE TABLE truth AS
    SELECT resort_id, tier, obs_date AS local_date, any_value(station_id) AS station_id,
      max(CASE WHEN variable = 'swe' THEN gain_{align} END) AS d_swe,
      max(CASE WHEN variable = 'snow_depth' THEN gain_{align} END) AS d_depth,
      max(CASE WHEN variable = 'precip_accum' THEN gain_{align} END) AS d_precip
    FROM sn_gain GROUP BY resort_id, tier, obs_date""")
    con.execute(f"""
    CREATE TABLE truth2 AS
    SELECT resort_id, tier, local_date, station_id,
      CASE WHEN d_swe IS NULL OR d_swe > {MAX_SWE_GAIN_MM} THEN NULL ELSE greatest(d_swe, 0) END AS obs_swe_gain_mm,
      CASE WHEN d_depth IS NULL OR d_depth > {MAX_DEPTH_GAIN_CM} THEN NULL ELSE greatest(d_depth, 0) END AS obs_depth_gain_cm,
      CASE WHEN d_precip IS NULL OR d_precip < 0 OR d_precip > {MAX_SWE_GAIN_MM} THEN NULL ELSE d_precip END AS obs_precip_gain_mm,
      (d_swe > {MAX_SWE_GAIN_MM} OR d_depth > {MAX_DEPTH_GAIN_CM}) AS sensor_flag
    FROM truth""")

    # ---------------------------------------------------------------- resort reports (flagged)
    con.execute("""
    CREATE TABLE ots AS
    WITH o AS (
      SELECT r.resort_id, CAST(timezone(r.tz, o.valid_start) AS DATE) AS local_date, o.value, o.fetched_at,
             CAST(timezone(r.tz, o.fetched_at) AS DATE) AS fdate
      FROM raw o JOIN resorts r USING (resort_id)
      WHERE o.source = 'onthesnow' AND o.variable = 'reported_daily_snow' AND o.value IS NOT NULL
    )
    SELECT resort_id, local_date, value AS ots_reported_cm, fdate = local_date + 1 AS ots_next_day
    FROM o WHERE fdate > local_date
    QUALIFY row_number() OVER (PARTITION BY resort_id, local_date
      ORDER BY (fdate = local_date + 1) DESC,
               CASE WHEN fdate = local_date + 1 THEN -epoch(fetched_at) ELSE epoch(fetched_at) END) = 1""")

    # ---------------------------------------------------------------- the table
    paid_list = ", ".join(f"'{p}'" for p in PAID)
    con.execute(f"""
    CREATE TABLE pairs AS
    SELECT f.source, f.kind, f.source IN ({paid_list}) AS paid,
           f.source || CASE WHEN f.model <> '' THEN ':' || f.model ELSE '' END AS source_label,
           f.resort_id, f.region, f.tier, f.model, f.member, f.space, f.issue_key, f.issue_ts,
           f.lead_day, f.lead_hours, f.local_date, f.fc_amount, ft.fc_temp_c,
           p.station_id, p.pair_quality, p.km AS station_km, p.delev AS station_delev_m,
           t.obs_swe_gain_mm, t.obs_depth_gain_cm, t.obs_precip_gain_mm, t.sensor_flag,
           CASE WHEN t.obs_swe_gain_mm >= 5 THEN t.obs_depth_gain_cm * 10 / t.obs_swe_gain_mm END AS obs_slr,
           CASE f.space WHEN 'liquid' THEN t.obs_swe_gain_mm ELSE t.obs_depth_gain_cm END AS obs,
           o.ots_reported_cm, o.ots_next_day,
           CASE WHEN month(f.local_date) >= 7 THEN year(f.local_date) ELSE year(f.local_date) - 1 END AS winter
    FROM fc f
    LEFT JOIN ft ON ft.source = f.source AND ft.resort_id = f.resort_id AND ft.tier = f.tier
      AND ft.model = f.model AND ft.member = f.member AND ft.issue_key = f.issue_key AND ft.local_date = f.local_date
    LEFT JOIN station_pairs p ON p.resort_id = f.resort_id AND p.tier = f.tier
    LEFT JOIN truth2 t ON t.resort_id = f.resort_id AND t.tier = f.tier AND t.local_date = f.local_date
    LEFT JOIN ots o ON o.resort_id = f.resort_id AND o.local_date = f.local_date""")
    con.execute("""
    ALTER TABLE pairs ADD COLUMN split VARCHAR;
    UPDATE pairs SET split = CASE winter WHEN 2024 THEN 'train' WHEN 2025 THEN 'test' ELSE 'live' END""")
    con.execute(f"COPY pairs TO '{out / 'pairs.parquet'}' (FORMAT parquet, COMPRESSION zstd)")

    # ---------------------------------------------------------------- scores
    con.execute("CREATE TABLE thr(space VARCHAR, t DOUBLE)")
    con.executemany("INSERT INTO thr VALUES (?, ?)", [(s, t) for s, ts in THRESHOLDS.items() for t in ts])
    con.execute("""
    CREATE TABLE det AS
    SELECT source_label, paid, space, split, region, resort_id, lead_day, local_date, issue_key,
           avg(fc_amount) AS fc, list(fc_amount) AS members, count(*) AS n_members, any_value(obs) AS obs
    FROM pairs WHERE obs IS NOT NULL AND pair_quality = 'strict' AND tier = 'mid'
    GROUP BY source_label, paid, space, split, region, resort_id, lead_day, local_date, issue_key""")
    con.execute(f"""
    CREATE TABLE scores AS
    WITH s AS (
      SELECT d.*, thr.t,
             d.fc >= thr.t AS f, d.obs >= thr.t AS o,
             CASE WHEN d.n_members > 1 THEN len(list_filter(d.members, lambda x: x >= thr.t)) / d.n_members END AS prob
      FROM det d JOIN thr USING (space)
    )
    SELECT source_label, any_value(paid) AS paid, space, split, coalesce(region, 'ALL') AS region, lead_day, t AS threshold,
           count(*) AS n, count(DISTINCT resort_id) AS resorts,
           sum(CAST(o AS INT)) AS events,
           sum(CAST(f AND o AS INT)) AS hits, sum(CAST(NOT f AND o AS INT)) AS misses,
           sum(CAST(f AND NOT o AS INT)) AS false_alarms, sum(CAST(NOT f AND NOT o AS INT)) AS correct_negatives,
           hits / nullif(hits + misses, 0) AS pod,
           false_alarms / nullif(hits + false_alarms, 0) AS far,
           hits / nullif(hits + misses + false_alarms, 0) AS csi,
           (hits + false_alarms) / nullif(hits + misses, 0) AS freq_bias,
           avg(power(prob - CAST(o AS INT), 2)) AS brier,
           avg(abs(fc - obs)) AS mae, avg(fc - obs) AS mean_error,
           sum(fc) / nullif(sum(obs), 0) AS volume_ratio,
           sum(CAST(o AS INT)) < {THIN_EVENTS} AS thin
    FROM s
    GROUP BY GROUPING SETS ((source_label, space, split, region, lead_day, t), (source_label, space, split, lead_day, t))""")
    con.execute(f"COPY (SELECT * FROM scores ORDER BY ALL) TO '{out / 'scores.parquet'}' (FORMAT parquet)")
    con.execute(f"COPY (SELECT * FROM scores ORDER BY ALL) TO '{out / 'scores.csv'}' (HEADER)")
    con.execute(f"COPY (SELECT * FROM station_pairs ORDER BY resort_id, tier) TO '{out / 'station_pairs.csv'}' (HEADER)")

    # ---------------------------------------------------------------- checks + logs
    stats = {}
    for name, q in {
        "forecast_days": "SELECT count(*) FROM fc",
        "pairs_with_truth": "SELECT count(*) FROM pairs WHERE obs IS NOT NULL",
        "resorts_with_strict_pair": "SELECT count(DISTINCT resort_id) FROM station_pairs WHERE pair_quality = 'strict' AND tier = 'mid'",
        "resorts_with_any_pair": "SELECT count(DISTINCT resort_id) FROM station_pairs WHERE tier = 'mid'",
        "resorts_total": "SELECT count(*) FROM resorts",
        "sensor_flags": "SELECT count(*) FROM truth2 WHERE sensor_flag",
        "ots_days": "SELECT count(*) FROM ots",
    }.items():
        stats[name] = con.execute(q).fetchone()[0]
    if stats["pairs_with_truth"] == 0:
        raise SystemExit("no forecast day found its truth — check station pairs and day alignment")
    stats["alignment"] = {"used": align, "r_start": c_start, "r_end": c_end, "n": n_corr}
    for k, v in stats.items():
        if k != "alignment":
            log(public_log, f"{k}: {v}")
    for src, n in con.execute(f"""SELECT source, count(*) FROM fc WHERE source NOT IN ({paid_list})
                                  GROUP BY source ORDER BY source""").fetchall():
        log(public_log, f"  {src}: {n} forecast days")
    (out / "log.txt").write_text("\n".join(public_log) + "\n")
    (out / "report.md").write_text(report(con, stats))
    return stats


def table(con, sql: str) -> str:
    rel = con.execute(sql)
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    if not rows:
        return "_no rows_\n"
    fmt = lambda v: "—" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]
    return "\n".join(lines) + "\n"


def report(con, stats: dict) -> str:
    a = stats["alignment"]
    parts = [
        "# Verification table — first report\n",
        "PRIVATE: contains paid-source scores. Mid tier, strict station pairs only.\n",
        "## Coverage\n",
        f"- Forecast days: {stats['forecast_days']:,}; with truth: {stats['pairs_with_truth']:,}",
        f"- Resorts with a strict SNOTEL pair (mid): {stats['resorts_with_strict_pair']} of {stats['resorts_total']} "
        f"(any pair: {stats['resorts_with_any_pair']})",
        f"- SNOTEL day alignment used: {a['used']}-of-day (r start {a['r_start']:.3f} vs end {a['r_end']:.3f}, n {a['n']:,})",
        f"- Daily gains dropped as sensor faults: {stats['sensor_flags']}; resort-report days: {stats['ots_days']}\n",
        "## Station pairs (mid tier)\n",
        table(con, "SELECT resort_id, station_name, round(km, 1) AS km, delev AS delev_m, pair_quality FROM station_pairs WHERE tier = 'mid' ORDER BY pair_quality DESC, resort_id"),
        "\n## Liquid ≥ 10 mm/day, judged on 2025-26 (test), all regions: CSI by lead day\n",
        table(con, """PIVOT (SELECT source_label, lead_day, round(csi, 2) AS csi FROM scores
                      WHERE space = 'liquid' AND threshold = 10 AND split = 'test' AND region = 'ALL' AND lead_day <= 7)
                      ON lead_day USING any_value(csi) GROUP BY source_label ORDER BY source_label"""),
        "\n## Snow ≥ 15 cm/day (depth gain), 2025-26, all regions: CSI by lead day\n",
        table(con, """PIVOT (SELECT source_label, lead_day, round(csi, 2) AS csi FROM scores
                      WHERE space = 'snow' AND threshold = 15 AND split = 'test' AND region = 'ALL' AND lead_day <= 7)
                      ON lead_day USING any_value(csi) GROUP BY source_label ORDER BY source_label"""),
        "\n## Volume ratio (forecast ÷ observed liquid), lead day 1, both past winters, by region\n",
        "Above 1 = forecasts too wet. The research expects global models to run dry in the West.\n",
        table(con, """PIVOT (SELECT source_label, region, round(sum(volume_ratio * n) / sum(n), 2) AS r FROM scores
                      WHERE space = 'liquid' AND threshold = 2.5 AND lead_day = 1 AND split IN ('train', 'test')
                      AND region <> 'ALL' GROUP BY ALL) ON region USING any_value(r) GROUP BY source_label"""),
        "\n## Sample size: observed events per region (liquid, lead day 1, test winter)\n",
        table(con, """SELECT region, threshold, max(events) AS events, max(resorts) AS resorts FROM scores
                      WHERE space = 'liquid' AND lead_day = 1 AND split = 'test' GROUP BY ALL ORDER BY region, threshold"""),
        "\n## Every source, lead 0 (shortest lead — the only footing where the hindcast compares)\n",
        table(con, """SELECT source_label, space, threshold, n, events, round(pod, 2) pod, round(far, 2) far,
                      round(csi, 2) csi, round(freq_bias, 2) bias, round(mae, 2) mae, thin FROM scores
                      WHERE lead_day = 0 AND region = 'ALL' AND split IN ('test') ORDER BY space, threshold, source_label"""),
    ]
    return "\n".join(parts) + "\n"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("archive", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--resorts", type=Path, default=Path("src/data/resorts.json"))
    a = ap.parse_args()
    build(a.archive, a.out, a.resorts)
