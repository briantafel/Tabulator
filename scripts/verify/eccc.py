"""ECCC daily precipitation as a SEPARATE liquid truth for the Canadian resorts (2026-11-23).

Called from build.py after the forecast days (`fc`) and tier elevations (`tier_elev`) exist.
Never touches `station_pairs` or `pairs`: the SNOTEL / BC ASWS scores stay exactly as they were.

Writes to <outDir>:
  eccc_pairs.parquet          public forecasts (mid tier, liquid) at every Canadian resort, with the
                              ECCC truth of the resort's chosen station where there is one (else NULL)
  eccc_truth.parquet          daily truth at EVERY candidate station (chosen or not), after flags and shift
  eccc_station_pairs.csv      every candidate station per resort: distance, Δelev, coverage, strict, chosen

Rules
- Rows: source 'eccc-daily', parser_version eccc-daily-2 (live) or eccc-daily-history-2 (backfill) only;
  history-1 mapping rows put stations in the wrong place. Variable total_precip (mm). Null wrote no row.
- Flags (value_text): A accumulated over several days, F accumulated + estimated, E estimated,
  L may or may not have occurred, M missing → the day is dropped (NULL, never zero) and counted by flag.
  T (trace) is kept as the 0 it is stored as. Other flags are kept and counted.
- A record is the station's local STANDARD-time day, stored as its UTC span; it is dated by the resort's
  local date one hour into the span (same as the SNOTEL dailies). Whether that record belongs to the
  resort day before, the same day or the day after (some climate stations close their day in the
  morning) is decided by the data: shift −1 / 0 / +1, the one whose truth correlates best with the
  newest Open-Meteo run (previous_day0), pooled over the chosen stations — the SNOTEL rule.
- Station: build.py's strict rule (≤ 25 km and |Δelev| ≤ 300 m from the resort's mid tier) PLUS
  coverage: usable total_precip on ≥ MIN_COVERAGE of the Nov–Apr days between the first and last ECCC
  day in the archive. Among those, the build.py score (km/25 + |Δelev|/300) picks one per resort.
- Public sources only (FORECASTS); one forecast per source × resort × day × lead (issues averaged).
"""
from __future__ import annotations

from pathlib import Path

SOURCE = "eccc-daily"
GOOD_PARSERS = ("eccc-daily-2", "eccc-daily-history-2")
DROP_FLAGS = ("A", "F", "E", "L", "M")
MIN_COVERAGE = 0.6
FORECASTS = ("open-meteo-previous-runs", "nbm", "noaa-hrrr", "msc-hrdps")
MAX_PRECIP_MM = 150.0  # same ceiling build.py puts on a daily SWE gain


def eccc_truth(con, out: Path, log, strict_km: float, strict_delev_m: float) -> dict:
    has_pv = "parser_version" in [c[0] for c in con.execute("DESCRIBE raw").fetchall()]
    if not has_pv:
        log("eccc-daily: archive has no parser_version column; ECCC truth skipped")
        return {"eccc_pairs": 0}
    good = ", ".join(f"'{p}'" for p in GOOD_PARSERS)
    n_all = con.execute(f"SELECT count(*) FROM raw WHERE source = '{SOURCE}' AND variable = 'total_precip'").fetchone()[0]
    con.execute(f"""
    CREATE TABLE ec_obs AS
    SELECT station_id, valid_start, value, nullif(upper(trim(value_text)), '') AS flag FROM raw
    WHERE source = '{SOURCE}' AND kind = 'observation' AND period_label = 'daily' AND variable = 'total_precip'
      AND value IS NOT NULL AND parser_version IN ({good})
    QUALIFY row_number() OVER (PARTITION BY station_id, valid_start ORDER BY fetched_at DESC) = 1""")
    n_obs = con.execute("SELECT count(*) FROM ec_obs").fetchone()[0]
    if n_obs == 0:
        log(f"eccc-daily: no usable total_precip rows ({n_all} rows of any parser); ECCC truth skipped")
        return {"eccc_pairs": 0}
    flags = con.execute("SELECT flag, count(*) FROM ec_obs GROUP BY flag ORDER BY flag NULLS FIRST").fetchall()
    dropped = {f: n for f, n in flags if f in DROP_FLAGS}
    log(f"eccc-daily total_precip: {n_obs} station-days (eccc-daily-2 + history-2; {n_all - n_obs} other-parser/duplicate rows "
        f"left out); flags: " + ", ".join(f"{f or 'none'} {n}" for f, n in flags))
    log(f"eccc-daily dropped by flag (A/F/E/L/M): {sum(dropped.values())} — "
        + (", ".join(f"{f} {n}" for f, n in sorted(dropped.items())) or "none"))
    drop = ", ".join(f"'{f}'" for f in DROP_FLAGS)
    faults = con.execute(f"SELECT count(*) FROM ec_obs WHERE coalesce(flag, '') NOT IN ({drop}) AND value > {MAX_PRECIP_MM}").fetchone()[0]
    con.execute(f"""
    CREATE TABLE ec_use AS SELECT * FROM ec_obs
    WHERE coalesce(flag, '') NOT IN ({drop}) AND value BETWEEN 0 AND {MAX_PRECIP_MM}""")
    if faults:
        log(f"eccc-daily: {faults} days above {MAX_PRECIP_MM:g} mm dropped as faults")

    # Candidate stations (mapping rows from the good parsers only), newest fetch wins.
    con.execute(f"""
    CREATE TABLE ec_cand AS
    SELECT resort_id, station_id, arg_max(value, fetched_at) AS km, arg_max(elevation_m, fetched_at) AS st_elev,
           arg_max(value_text, fetched_at) AS station_name
    FROM raw WHERE source = '{SOURCE}' AND kind = 'mapping' AND parser_version IN ({good}) AND resort_id IS NOT NULL
    GROUP BY resort_id, station_id""")
    # Coverage over Nov–Apr days of the archive's ECCC span.
    con.execute("""
    CREATE TABLE ec_days AS
    WITH s AS (SELECT CAST(min(valid_start) AS DATE) AS d0, CAST(max(valid_start) AS DATE) AS d1 FROM ec_obs)
    SELECT CAST(unnest(generate_series(CAST(d0 AS TIMESTAMP), CAST(d1 AS TIMESTAMP), INTERVAL 1 DAY)) AS DATE) AS d FROM s""")
    n_days = con.execute("SELECT count(*) FROM ec_days WHERE month(d) IN (11, 12, 1, 2, 3, 4)").fetchone()[0]
    con.execute(f"""
    CREATE TABLE ec_cov AS
    SELECT station_id, count(DISTINCT CAST(valid_start + INTERVAL 1 HOUR AS DATE)) / {max(n_days, 1)}.0 AS coverage
    FROM ec_use WHERE month(valid_start + INTERVAL 1 HOUR) IN (11, 12, 1, 2, 3, 4) GROUP BY station_id""")
    con.execute(f"""
    CREATE TABLE ec_pairs_all AS
    WITH c AS (
      SELECT c.resort_id, t.tier_elev, c.station_id, c.station_name, c.km, c.st_elev, c.st_elev - t.tier_elev AS delev,
             c.km / {strict_km} + abs(c.st_elev - t.tier_elev) / {strict_delev_m} AS score,
             coalesce(c.km <= {strict_km} AND abs(c.st_elev - t.tier_elev) <= {strict_delev_m}, false) AS strict,
             coalesce(v.coverage, 0) AS coverage
      FROM ec_cand c LEFT JOIN tier_elev t ON t.resort_id = c.resort_id AND t.tier = 'mid'
      LEFT JOIN ec_cov v USING (station_id)
    )
    , e AS (SELECT *, strict AND coverage >= {MIN_COVERAGE} AS eligible FROM c)
    SELECT *, eligible AND row_number() OVER (PARTITION BY resort_id ORDER BY eligible DESC, score, station_id) = 1 AS chosen
    FROM e""")
    con.execute(f"COPY (SELECT * FROM ec_pairs_all ORDER BY resort_id, chosen DESC, score) TO '{out / 'eccc_station_pairs.csv'}' (HEADER)")
    n_strict, n_thin, n_chosen = con.execute("""
      SELECT count(DISTINCT resort_id) FILTER (WHERE strict),
             count(*) FILTER (WHERE strict AND NOT eligible), count(*) FILTER (WHERE chosen) FROM ec_pairs_all""").fetchone()
    log(f"eccc-daily stations: {n_chosen} resorts with a strict, covered mid-tier station "
        f"({n_strict} resorts had a strict one; {n_thin} strict stations under {MIN_COVERAGE:.0%} Nov–Apr coverage of {n_days} days)")

    # Truth at every candidate station, dated by the resort's local day (unshifted).
    con.execute("""
    CREATE TABLE ec_t0 AS
    SELECT p.resort_id, p.station_id, CAST(timezone(r.tz, o.valid_start + INTERVAL 1 HOUR) AS DATE) AS rec_date,
           o.value AS obs, o.flag
    FROM ec_use o JOIN ec_pairs_all p USING (station_id) JOIN resorts r USING (resort_id)""")
    # The data picks the alignment: truth for resort day D = the record dated D + shift.
    r = {}
    for s in (-1, 0, 1):
        r[s] = con.execute(f"""
          SELECT corr(f.fc_amount, t.obs), count(*) FROM fc f
          JOIN ec_pairs_all p ON p.resort_id = f.resort_id AND p.chosen
          JOIN ec_t0 t ON t.resort_id = f.resort_id AND t.station_id = p.station_id AND t.rec_date = f.local_date + {s}
          WHERE f.source = 'open-meteo-previous-runs' AND f.issue_key = 'previous_day0' AND f.space = 'liquid'
            AND f.tier = 'mid'""").fetchone()
    valid = {s: v for s, v in r.items() if v[0] is not None and v[1]}
    shift = max(valid, key=lambda s: valid[s][0]) if valid else 0
    log("eccc-daily day alignment (truth for day D = record D+shift; r vs newest model run): "
        + ", ".join(f"{s:+d}: r={v[0]:.3f} n={v[1]}" if v[0] is not None else f"{s:+d}: n={v[1]}" for s, v in r.items())
        + f" → shift {shift:+d}" + ("" if valid else " (no overlap: default 0)"))
    # Per-station check, so a station that keeps a different day stands out (public names, public data).
    con.execute("""
    CREATE TABLE ec_station_align AS
    SELECT p.resort_id, p.station_id, s.shift, corr(f.fc_amount, t.obs) AS r, count(*) AS n
    FROM fc f JOIN ec_pairs_all p ON p.resort_id = f.resort_id
    CROSS JOIN (SELECT unnest([-1, 0, 1]) AS shift) s
    JOIN ec_t0 t ON t.resort_id = f.resort_id AND t.station_id = p.station_id AND t.rec_date = f.local_date + s.shift
    WHERE f.source = 'open-meteo-previous-runs' AND f.issue_key = 'previous_day0' AND f.space = 'liquid' AND f.tier = 'mid'
    GROUP BY ALL""")
    con.execute(f"COPY (SELECT * FROM ec_station_align ORDER BY ALL) TO '{out / 'eccc_alignment.csv'}' (HEADER)")

    con.execute(f"""
    CREATE TABLE ec_truth AS
    SELECT t.resort_id, t.station_id, p.station_name, p.km AS station_km, p.st_elev AS station_elev_m,
           p.delev AS station_delev_m, p.strict, p.coverage, p.chosen,
           t.rec_date - {shift} AS local_date, t.obs, t.flag,
           CASE WHEN month(t.rec_date - {shift}) >= 7 THEN year(t.rec_date - {shift}) ELSE year(t.rec_date - {shift}) - 1 END AS winter
    FROM ec_t0 t JOIN ec_pairs_all p USING (resort_id, station_id)""")
    con.execute(f"COPY ec_truth TO '{out / 'eccc_truth.parquet'}' (FORMAT parquet)")

    src = ", ".join(f"'{s}'" for s in FORECASTS)
    con.execute(f"""
    CREATE TABLE ec_pairs AS
    WITH f AS (
      SELECT source, source || CASE WHEN model <> '' THEN ':' || model ELSE '' END AS source_label, model,
             resort_id, region, lead_day, local_date, avg(fc_amount) AS fc_amount, count(*) AS n_issues
      FROM fc WHERE source IN ({src}) AND space = 'liquid' AND tier = 'mid' AND region = 'Canada'
        AND member = -1
      GROUP BY source, source_label, model, resort_id, region, lead_day, local_date
    )
    SELECT f.*, 'mid' AS tier, p.station_id, p.station_name, p.km AS station_km, p.st_elev AS station_elev_m,
           p.delev AS station_delev_m, t.obs, t.flag AS obs_flag,
           CASE WHEN month(f.local_date) >= 7 THEN year(f.local_date) ELSE year(f.local_date) - 1 END AS winter
    FROM f LEFT JOIN ec_pairs_all p ON p.resort_id = f.resort_id AND p.chosen
    LEFT JOIN ec_truth t ON t.resort_id = f.resort_id AND t.station_id = p.station_id AND t.local_date = f.local_date""")
    con.execute("""
    ALTER TABLE ec_pairs ADD COLUMN split VARCHAR;
    UPDATE ec_pairs SET split = CASE WHEN winter = 2024 THEN 'train' WHEN winter = 2025 THEN 'test'
                                     WHEN winter < 2024 THEN 'hist' ELSE 'live' END""")
    con.execute(f"COPY ec_pairs TO '{out / 'eccc_pairs.parquet'}' (FORMAT parquet, COMPRESSION zstd)")
    n_pairs, n_truth = con.execute("SELECT count(*), count(obs) FROM ec_pairs").fetchone()
    by = con.execute("SELECT split, count(obs) FROM ec_pairs GROUP BY split ORDER BY split").fetchall()
    log(f"eccc_pairs: {n_pairs} forecast days at Canadian resorts, {n_truth} with ECCC truth ("
        + ", ".join(f"{s} {n}" for s, n in by) + ")")
    return {"eccc_pairs": n_pairs, "eccc_pairs_with_truth": n_truth, "eccc_shift": shift,
            "eccc_dropped_by_flag": dropped, "eccc_resorts": n_chosen}
