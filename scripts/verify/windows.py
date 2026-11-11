"""Window-matched truth: score forecasts against 24 h observation windows.

Called from build.py after the forecast tables exist. Added 2026-11-11 for the
truth sources the other archive work brought in: CoCoRaHS, SNODAS, AMeDAS,
SLF study plots. SNOTEL and BC ASWS keep their own path in build.py
(resort-local midnight days); nothing here changes them or the SLR fit.

Three things each source gets right here:

1. DAY BOUNDARIES. Every truth row carries its own window in UTC (CoCoRaHS:
   the 24 h ending at the observer's reading, often ~7 am local; SNODAS: 06 UTC
   to 06 UTC; AMeDAS: 09 JST = 00 UTC; SLF study plots: the morning reading).
   Instead of forcing those onto a midnight day, each forecast is summed over
   the truth's own window, pro rata, and counts only if its periods cover all
   of it. Partial coverage is absent, never zero.

2. UNITS. TRUTH below pins every (source, variable) to its unit. A row with
   any other unit fails the build loudly.

3. HEIGHT. A station's elevation is compared with the resort's Snow-Forecast
   tier elevations and classed:
     slope   within 300 m of the mid tier
     upper   more than 300 m above it
     base    between 300 m below the bottom tier and 300 m below mid
     valley  more than 300 m below the bottom tier
     grid    SNODAS cell at the resort (no station height)
   Valley and base stations sit below the snow the forecasts describe, so
   they are scored only on the low "did it snow / rain" thresholds, never on
   powder amounts. Where a resort also has slope truth (SNOTEL / BC pillow),
   the valley-to-slope ratio is measured on shared days: the gap is learned
   from data, and reported, before anything uses it.

Plus a MATCHED SAMPLE comparison: for each truth product and lead day,
forecast sources are compared only on windows where all of them have a
forecast, so a source that started yesterday isn't judged on different
storms from one with two winters of history.

Outputs (written to the build's out dir; parquet stays in the private
bucket, the rest goes into the sealed report):
  wpairs.parquet, truth_scores.csv, matched_scores.csv, elevation_ratios.csv,
  truth_pairs.csv, truth_windows.md
"""
from __future__ import annotations

from pathlib import Path

# (source, variable) → (space, unit, product). Product names the truth in scores.
TRUTH = {
    ("cocorahs", "precip_24h"): ("liquid", "mm", "cocorahs"),
    ("cocorahs", "new_snow_24h"): ("snow", "cm", "cocorahs"),
    ("amedas", "precip_24h"): ("liquid", "mm", "amedas"),
    ("amedas", "new_snow_24h"): ("snow", "cm", "amedas"),
    ("slf", "new_snow_24h"): ("snow", "cm", "slf-plot"),          # manual study plots only (see below)
    ("slf", "new_snow_water_24h"): ("liquid", "mm", "slf-plot"),
    # SNODAS: the 24 h snowfall water is the model forcing (NWP precipitation),
    # so scoring models against it partly scores them against a model. Kept,
    # labelled; the assimilated snowpack gains below are the better truth.
    ("snodas", "snowfall_water_24h"): ("liquid", "mm", "snodas-forcing"),
}
# SNODAS instants → 24 h gains between consecutive 06 UTC snapshots.
SNODAS_GAINS = {
    "swe": ("liquid", "mm", "snodas-swe-gain"),
    "swe_max_5x5": ("liquid", "mm", "snodas-swe-gain-max5x5"),
    "snow_depth": ("snow", "cm", "snodas-depth-gain"),
    "snow_depth_max_5x5": ("snow", "cm", "snodas-depth-gain-max5x5"),
}
SNODAS_UNITS = {"swe": "mm", "swe_max_5x5": "mm", "snow_depth": "cm", "snow_depth_max_5x5": "cm"}
WINDOW_SOURCES = ("cocorahs", "amedas", "slf", "snodas")
SLOPE_M = 300.0          # height band for "slope"
MAX_GAIN = {"liquid": 150.0, "snow": 150.0}   # a 24 h gain above this is a sensor/analysis fault
FULL_CLASSES = ("slope", "upper", "grid")      # amounts comparable to a mid-mountain forecast
LOW_THRESHOLDS = {"liquid": (2.5, 10.0), "snow": (2.5,)}  # what valley/base truth may judge
MATCH_MIN = 30           # a matched sample smaller than this is not reported


def window_truth(con, out: Path, log, thresholds: dict, paid_list: str, thin_events: int) -> dict:
    srcs = ", ".join(f"'{s}'" for s in WINDOW_SOURCES)
    have = {r[0] for r in con.execute(f"SELECT DISTINCT source FROM raw WHERE source IN ({srcs})").fetchall()}
    if not have:
        log("window truth: no CoCoRaHS / SNODAS / AMeDAS / SLF rows in the archive yet")
        return {"window_truth_rows": 0}

    # ------------------------------------------------------------ registry → table
    con.execute("CREATE TABLE treg(source VARCHAR, variable VARCHAR, space VARCHAR, unit VARCHAR, product VARCHAR)")
    con.executemany("INSERT INTO treg VALUES (?, ?, ?, ?, ?)",
                    [(s, v, sp, u, p) for (s, v), (sp, u, p) in TRUTH.items()])

    # Units: every truth row must carry the unit the registry expects.
    bad = con.execute(f"""
      SELECT r.source, r.variable, r.unit, t.unit AS want, count(*) FROM raw r JOIN treg t USING (source, variable)
      WHERE r.kind IN ('observation', 'analysis') AND r.unit IS DISTINCT FROM t.unit GROUP BY ALL""").fetchall()
    bad += con.execute(f"""
      SELECT source, variable, unit, NULL, count(*) FROM raw
      WHERE source = 'snodas' AND kind = 'analysis' AND variable IN ({", ".join(f"'{v}'" for v in SNODAS_UNITS)})
        AND unit IS DISTINCT FROM CASE WHEN variable LIKE 'swe%' THEN 'mm' ELSE 'cm' END GROUP BY ALL""").fetchall()
    if bad:
        raise SystemExit("window truth: unexpected units — " + "; ".join(
            f"{s}/{v} has '{u}' (want '{w or ('mm' if v.startswith('swe') else 'cm')}') ×{n}" for s, v, u, w, n in bad))

    # ------------------------------------------------------------ 24 h observation windows
    con.execute("""
    CREATE TABLE tw0 AS
    SELECT t.product, r.source AS truth_source, t.space,
           r.station_id, r.resort_id AS row_resort, r.valid_start AS ws, r.valid_end AS we, r.value AS obs
    FROM raw r JOIN treg t USING (source, variable)
    WHERE r.kind IN ('observation', 'analysis') AND r.value IS NOT NULL
      AND r.period_label IN ('24h', 'daily-24h')
      AND (r.source <> 'slf' OR r.station_id LIKE 'study-plot:%')
      AND abs(epoch(r.valid_end - r.valid_start) / 3600 - 24) < 0.5
    QUALIFY row_number() OVER (PARTITION BY r.source, r.station_id, coalesce(r.resort_id, ''), r.variable,
                                            r.valid_start, r.valid_end ORDER BY r.fetched_at DESC) = 1""")
    # SNODAS snowpack gains: snapshot(t) − snapshot(t − 24 h), per resort cell.
    for var, (space, _unit, product) in SNODAS_GAINS.items():
        con.execute(f"""
        INSERT INTO tw0
        WITH s AS (
          SELECT resort_id, station_id, valid_end AS t, value FROM raw
          WHERE source = 'snodas' AND kind = 'analysis' AND variable = '{var}' AND value IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY resort_id, station_id, valid_end ORDER BY fetched_at DESC) = 1
        ), g AS (
          SELECT *, lag(t) OVER w AS t0, lag(value) OVER w AS v0 FROM s
          WINDOW w AS (PARTITION BY resort_id, station_id ORDER BY t)
        )
        SELECT '{product}', 'snodas', '{space}', station_id || '{'#max5x5' if 'max' in var else ''}', resort_id,
               t0, t, greatest(value - v0, 0)
        FROM g WHERE t0 IS NOT NULL AND epoch(t - t0) = 86400""")
    con.execute(f"""DELETE FROM tw0 WHERE (space = 'liquid' AND obs > {MAX_GAIN['liquid']})
                                       OR (space = 'snow' AND obs > {MAX_GAIN['snow']})""")

    # ------------------------------------------------------------ station → resort, with height class
    con.execute(f"""
    CREATE TABLE tcand AS
    SELECT m.resort_id, m.station_id, m.source AS truth_source,
           arg_max(m.value, m.fetched_at) AS km, arg_max(m.elevation_m, m.fetched_at) AS st_elev,
           arg_max(m.value_text, m.fetched_at) AS station_name
    FROM raw m WHERE m.kind = 'mapping' AND m.source IN ({srcs}) AND m.source <> 'snodas'
    GROUP BY m.resort_id, m.station_id, m.source""")
    con.execute("""
    CREATE TABLE tiers AS
    SELECT resort_id,
           max(CASE WHEN tier = 'bot' THEN tier_elev END) AS bot_elev,
           max(CASE WHEN tier = 'mid' THEN tier_elev END) AS mid_elev,
           max(CASE WHEN tier = 'top' THEN tier_elev END) AS top_elev
    FROM tier_elev GROUP BY resort_id""")
    con.execute(f"""
    CREATE TABLE truth_pairs AS
    WITH station_products AS (
      SELECT DISTINCT product, truth_source, station_id FROM tw0 WHERE truth_source <> 'snodas'
    ), c AS (
      SELECT c.resort_id, p.product, c.truth_source, c.station_id, c.station_name, c.km, c.st_elev,
             t.bot_elev, t.mid_elev, c.st_elev - t.mid_elev AS delev_mid,
             CASE WHEN c.st_elev IS NULL OR t.mid_elev IS NULL THEN 'unknown'
                  WHEN abs(c.st_elev - t.mid_elev) <= {SLOPE_M} THEN 'slope'
                  WHEN c.st_elev > t.mid_elev THEN 'upper'
                  WHEN c.st_elev >= coalesce(t.bot_elev, t.mid_elev) - {SLOPE_M} THEN 'base'
                  ELSE 'valley' END AS elev_class
      FROM tcand c JOIN station_products p USING (truth_source, station_id)
      LEFT JOIN tiers t USING (resort_id)
    )
    SELECT * FROM c
    QUALIFY row_number() OVER (PARTITION BY resort_id, product
      ORDER BY km / 25 + coalesce(abs(delev_mid), 2 * {SLOPE_M}) / {SLOPE_M}) = 1
    UNION ALL
    SELECT DISTINCT row_resort, product, 'snodas', station_id, 'SNODAS cell', 0.0, NULL::INTEGER,
           t.bot_elev, t.mid_elev, NULL::INTEGER, 'grid'
    FROM tw0 LEFT JOIN tiers t ON t.resort_id = tw0.row_resort WHERE truth_source = 'snodas'""")
    con.execute(f"COPY (SELECT * FROM truth_pairs ORDER BY resort_id, product) TO '{out / 'truth_pairs.csv'}' (HEADER)")

    con.execute("""
    CREATE TABLE tw AS
    SELECT p.resort_id, r.region, r.tz, w.product, w.truth_source, w.space, w.station_id,
           p.km AS station_km, p.st_elev, p.delev_mid, p.elev_class, w.ws, w.we, w.obs
    FROM tw0 w JOIN truth_pairs p ON p.product = w.product AND p.station_id = w.station_id
      AND (w.truth_source <> 'snodas' OR p.resort_id = w.row_resort)
    JOIN resorts r ON r.resort_id = p.resort_id""")

    # ------------------------------------------------------------ forecasts summed over each window
    con.execute("""
    CREATE TABLE wf AS
    SELECT t.resort_id, t.region, t.tz, t.product, t.truth_source, t.space, t.station_id, t.station_km, t.st_elev,
           t.delev_mid, t.elev_class, t.ws, t.we, t.obs,
           f.source, f.kind, f.model, f.member, f.issue_key, min(f.issue_ts) AS issue_ts,
           sum(f.value * epoch(least(f.valid_end, t.we) - greatest(f.valid_start, t.ws))
                       / epoch(f.valid_end - f.valid_start)) AS amt,
           sum(epoch(least(f.valid_end, t.we) - greatest(f.valid_start, t.ws))) / 3600 AS cov_h
    FROM tw t JOIN f1 f ON f.resort_id = t.resort_id AND f.space = t.space AND f.tier = 'mid'
      AND f.valid_start < t.we AND f.valid_end > t.ws
    GROUP BY ALL
    HAVING abs(cov_h - epoch(t.we - t.ws) / 3600) < 0.01""")
    con.execute(f"""
    CREATE TABLE wpairs AS
    WITH l AS (
      SELECT *,
        CASE WHEN source = 'open-meteo-previous-runs' THEN CAST(regexp_extract(issue_key, '(\\d+)$', 1) AS INTEGER)
             WHEN kind = 'hindcast' THEN 0
             ELSE datediff('day', CAST(timezone(tz, issue_ts) AS DATE),
                                  CAST(timezone(tz, we - INTERVAL 1 SECOND) AS DATE)) END AS lead_day,
        CASE WHEN source = 'open-meteo-previous-runs' OR kind = 'hindcast' THEN NULL
             ELSE epoch(ws - issue_ts) / 3600 END AS lead_hours
      FROM wf
    )
    SELECT resort_id, region, product, truth_source, space, station_id, station_km, st_elev, delev_mid, elev_class,
           ws, we, any_value(obs) AS obs, source, source IN ({paid_list}) AS paid,
           source || CASE WHEN model <> '' THEN ':' || model ELSE '' END AS source_label,
           issue_key, min(issue_ts) AS issue_ts, lead_day, min(lead_hours) AS lead_hours,
           avg(amt) AS fc, list(amt) AS members, count(*) AS n_members,
           CASE WHEN month(we) >= 7 THEN year(we) ELSE year(we) - 1 END AS winter
    FROM l WHERE lead_day >= 0 AND (lead_hours IS NULL OR lead_hours > -1)
    GROUP BY resort_id, region, product, truth_source, space, station_id, station_km, st_elev, delev_mid,
             elev_class, ws, we, source, model, issue_key, lead_day""")
    con.execute("""ALTER TABLE wpairs ADD COLUMN split VARCHAR;
                   UPDATE wpairs SET split = CASE winter WHEN 2024 THEN 'train' WHEN 2025 THEN 'test' ELSE 'live' END""")
    con.execute(f"COPY wpairs TO '{out / 'wpairs.parquet'}' (FORMAT parquet, COMPRESSION zstd)")

    # ------------------------------------------------------------ scores, per truth product and height class
    con.execute("CREATE TABLE wthr(space VARCHAR, t DOUBLE, low BOOLEAN)")
    con.executemany("INSERT INTO wthr VALUES (?, ?, ?)",
                    [(s, t, t in LOW_THRESHOLDS[s]) for s, ts in thresholds.items() for t in ts])
    full = ", ".join(f"'{c}'" for c in FULL_CLASSES)
    score_sql = f"""
      SELECT {{keys}}, t AS threshold, count(*) AS n, count(DISTINCT resort_id) AS resorts,
             sum(CAST(o AS INT)) AS events,
             sum(CAST(f AND o AS INT)) AS hits, sum(CAST(NOT f AND o AS INT)) AS misses,
             sum(CAST(f AND NOT o AS INT)) AS false_alarms,
             hits / nullif(hits + misses, 0) AS pod, false_alarms / nullif(hits + false_alarms, 0) AS far,
             hits / nullif(hits + misses + false_alarms, 0) AS csi,
             (hits + false_alarms) / nullif(hits + misses, 0) AS freq_bias,
             avg(power(prob - CAST(o AS INT), 2)) AS brier,
             avg(abs(fc - obs)) AS mae, sum(fc) / nullif(sum(obs), 0) AS volume_ratio,
             sum(CAST(o AS INT)) < {thin_events} AS thin
      FROM (
        SELECT p.*, w.t, p.fc >= w.t AS f, p.obs >= w.t AS o,
               CASE WHEN p.n_members > 1 THEN len(list_filter(p.members, lambda x: x >= w.t)) / p.n_members END AS prob
        FROM {{src}} p JOIN wthr w ON w.space = p.space
        WHERE w.low OR p.elev_class IN ({full})
      ) s
      GROUP BY {{group}}"""
    con.execute("CREATE TABLE truth_scores AS " + score_sql.format(
        keys="product, elev_class, source_label, any_value(paid) AS paid, space, split, coalesce(region, 'ALL') AS region, lead_day",
        src="wpairs",
        group="GROUPING SETS ((product, elev_class, source_label, space, split, region, lead_day, t), "
              "(product, elev_class, source_label, space, split, lead_day, t))"))
    con.execute(f"COPY (SELECT * FROM truth_scores ORDER BY ALL) TO '{out / 'truth_scores.csv'}' (HEADER)")

    # ------------------------------------------------------------ matched sample
    groups = con.execute("""SELECT DISTINCT product, elev_class, space, lead_day FROM wpairs
                            WHERE lead_day BETWEEN 0 AND 7 ORDER BY ALL""").fetchall()
    con.execute("CREATE TABLE wmatch AS SELECT *, ''::VARCHAR AS matched_set FROM wpairs LIMIT 0")
    for product, ec, space, lead in groups:
        counts = con.execute("""SELECT source_label, count(DISTINCT (resort_id, ws)) FROM wpairs
                                WHERE product = ? AND elev_class = ? AND space = ? AND lead_day = ?
                                GROUP BY 1 ORDER BY 2 DESC, 1""", [product, ec, space, lead]).fetchall()
        chosen: list[str] = []
        for label, _n in counts:  # add sources while the shared sample stays usable
            trial = chosen + [label]
            n = con.execute(f"""SELECT count(*) FROM (SELECT resort_id, ws FROM wpairs
                                WHERE product = ? AND elev_class = ? AND space = ? AND lead_day = ?
                                  AND source_label IN ({", ".join("?" * len(trial))})
                                GROUP BY resort_id, ws HAVING count(DISTINCT source_label) = {len(trial)})""",
                            [product, ec, space, lead, *trial]).fetchone()[0]
            if n >= MATCH_MIN and (not chosen or n >= 0.5 * counts[0][1]):
                chosen = trial
        if len(chosen) < 2:
            continue
        ph = ", ".join("?" * len(chosen))
        con.execute(f"""
        INSERT INTO wmatch
        WITH k AS (
          SELECT resort_id, ws FROM wpairs
          WHERE product = ? AND elev_class = ? AND space = ? AND lead_day = ? AND source_label IN ({ph})
          GROUP BY resort_id, ws HAVING count(DISTINCT source_label) = {len(chosen)}
        )
        SELECT p.*, ? FROM wpairs p JOIN k USING (resort_id, ws)
        WHERE p.product = ? AND p.elev_class = ? AND p.space = ? AND p.lead_day = ? AND p.source_label IN ({ph})""",
                    [product, ec, space, lead, *chosen, " + ".join(chosen), product, ec, space, lead, *chosen])
    con.execute("CREATE TABLE matched_scores AS " + score_sql.format(
        keys="product, elev_class, matched_set, source_label, any_value(paid) AS paid, space, split, lead_day",
        src="wmatch",
        group="product, elev_class, matched_set, source_label, space, split, lead_day, t"))
    con.execute(f"COPY (SELECT * FROM matched_scores ORDER BY ALL) TO '{out / 'matched_scores.csv'}' (HEADER)")

    # ------------------------------------------------------------ the height gap, learned
    # Window truth vs slope truth (SNOTEL / BC pillow, build.py's truth2) at the
    # same resort. Windows are dated by their midpoint's local date; the
    # ratio is a sum over many shared days, so the few hours' offset between a
    # 7 am window and a midnight day mostly cancels.
    con.execute("""
    CREATE TABLE elevation_ratios AS
    WITH w AS (
      SELECT resort_id, region, product, elev_class, space, station_id, delev_mid,
             CAST(timezone(tz, ws + INTERVAL 12 HOUR) AS DATE) AS local_date, obs
      FROM tw
    ), s AS (
      SELECT resort_id, local_date, obs_swe_gain_mm AS liquid, obs_depth_gain_cm AS snow FROM truth2 WHERE tier = 'mid'
    ), j AS (
      SELECT w.*, CASE w.space WHEN 'liquid' THEN s.liquid ELSE s.snow END AS slope_obs
      FROM w JOIN s USING (resort_id, local_date)
    )
    SELECT product, elev_class, space, coalesce(region, 'ALL') AS region,
           count(DISTINCT resort_id) AS resorts, count(*) AS days,
           sum(CAST(slope_obs >= 2.5 AS INT)) AS slope_wet_days,
           round(median(delev_mid)) AS median_delev_m,
           sum(obs) / nullif(sum(slope_obs), 0) AS ratio_to_slope,
           corr(obs, slope_obs) AS r,
           avg(CAST((obs >= 2.5) = (slope_obs >= 2.5) AS DOUBLE)) AS wet_day_agreement
    FROM j WHERE slope_obs IS NOT NULL AND obs IS NOT NULL
    GROUP BY GROUPING SETS ((product, elev_class, space, region), (product, elev_class, space))""")
    con.execute(f"COPY (SELECT * FROM elevation_ratios ORDER BY ALL) TO '{out / 'elevation_ratios.csv'}' (HEADER)")

    stats = {
        "window_truth_rows": con.execute("SELECT count(*) FROM tw").fetchone()[0],
        "window_pairs": con.execute("SELECT count(*) FROM wpairs").fetchone()[0],
    }
    for product, n_res, n_win in con.execute("""SELECT product, count(DISTINCT resort_id), count(*) FROM tw
                                                GROUP BY 1 ORDER BY 1""").fetchall():
        log(f"window truth {product}: {n_res} resorts, {n_win} windows")
    for ec, n in con.execute("SELECT elev_class, count(*) FROM truth_pairs GROUP BY 1 ORDER BY 1").fetchall():
        log(f"  height class {ec}: {n} resort-product pairs")
    log(f"window pairs (forecast × truth window): {stats['window_pairs']}")
    (out / "truth_windows.md").write_text(_report(con))
    return stats


def _table(con, sql: str) -> str:
    rel = con.execute(sql)
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    if not rows:
        return "_no rows yet_\n"
    fmt = lambda v: "—" if v is None else (f"{v:.2f}" if isinstance(v, float) else str(v))
    return "\n".join(["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
                     + ["| " + " | ".join(fmt(v) for v in r) + " |" for r in rows]) + "\n"


def _report(con) -> str:
    return "\n".join([
        "# Window-matched truth (CoCoRaHS, SNODAS, AMeDAS, SLF) — PRIVATE\n",
        "Forecasts summed over each observation's own 24 h window. Valley/base stations are judged only on",
        "the low thresholds (liquid ≥ 2.5 / 10 mm, snow ≥ 2.5 cm).\n",
        "## Coverage\n",
        _table(con, """SELECT product, elev_class, count(DISTINCT resort_id) AS resorts, count(*) AS windows,
                              min(ws)::DATE AS first, max(we)::DATE AS last FROM tw GROUP BY 1, 2 ORDER BY 1, 2"""),
        "\n## Station → resort pairs (height vs the Snow-Forecast mid tier)\n",
        _table(con, """SELECT resort_id, product, station_name, round(km, 1) AS km, st_elev, mid_elev, delev_mid, elev_class
                       FROM truth_pairs WHERE product <> 'snodas-forcing' AND product NOT LIKE 'snodas-%max5x5'
                       ORDER BY elev_class, resort_id, product"""),
        "\n## The height gap: window truth ÷ slope truth (SNOTEL / BC pillow) on shared days\n",
        _table(con, """SELECT product, elev_class, space, resorts, days, slope_wet_days, median_delev_m,
                              round(ratio_to_slope, 2) AS ratio, round(r, 2) AS r, round(wet_day_agreement, 2) AS wet_agree
                       FROM elevation_ratios WHERE region = 'ALL' ORDER BY product, space, elev_class"""),
        "\n## Liquid ≥ 2.5 mm, all regions: CSI by lead day\n",
        _table(con, """PIVOT (SELECT product || ' / ' || elev_class || ' / ' || split AS truth, source_label, lead_day,
                                     round(csi, 2) AS csi FROM truth_scores
                              WHERE space = 'liquid' AND threshold = 2.5 AND region = 'ALL' AND lead_day <= 7)
                       ON lead_day USING any_value(csi) GROUP BY truth, source_label ORDER BY truth, source_label"""),
        "\n## Matched sample (same windows for every source in the set), liquid ≥ 2.5 mm\n",
        _table(con, """SELECT product, elev_class, lead_day, matched_set, source_label, n, events,
                              round(csi, 2) AS csi, round(freq_bias, 2) AS bias, round(brier, 3) AS brier, thin
                       FROM matched_scores WHERE space = 'liquid' AND threshold = 2.5
                       ORDER BY product, elev_class, lead_day, csi DESC"""),
    ]) + "\n"
