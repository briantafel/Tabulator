"""Three read-only checks on the live truth (SNOTEL) after the 11-22..24 storm. Prints only.

  1. California and Colorado/Utah stations, hour by hour, Nov 20-25: was California's Nov 22 zero real,
     and when did Colorado's 53 mm fall (which local day)?
  2. Missing Saturdays (11-07, 11-14, 11-21): where do the rows disappear? SNOTEL daily rows by date and
     station, the collector's fetch dates, the day-gain chain, and the scored pairs.
Usage: truth_gap_diag.py <archive dir with source=snotel> <verify dir with pairs.parquet + station_pairs.csv>
"""
import glob
import sys

import duckdb

arch, ver = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
files = sorted(glob.glob(f"{arch}/**/source=snotel/**/*.parquet", recursive=True) + glob.glob(f"{arch}/source=snotel/**/*.parquet", recursive=True))
files = sorted(set(files))
print("snotel files:", len(files))
fl = "[" + ", ".join("'" + f + "'" for f in files) + "]"
con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet({fl}, union_by_name=true)")
print("columns:", [r[0] for r in con.execute("DESCRIBE raw").fetchall()])
con.execute(f"CREATE VIEW pairs AS SELECT * FROM read_parquet('{ver}/pairs.parquet')")
print("pairs columns:", [r[0] for r in con.execute("DESCRIBE pairs").fetchall()])
con.execute(f"CREATE TABLE sp AS SELECT * FROM read_csv('{ver}/station_pairs.csv', header=true)")
print("station_pairs columns:", [r[0] for r in con.execute("DESCRIBE sp").fetchall()])
con.execute("""CREATE TABLE reg AS SELECT DISTINCT resort_id, region FROM pairs""")
con.execute("""CREATE TABLE st AS SELECT DISTINCT sp.station_id, reg.region, sp.resort_id, sp.tier FROM sp JOIN reg USING (resort_id)
  WHERE truth_source = 'snotel' AND tier = 'mid' AND pair_quality = 'strict'""")
print("strict mid SNOTEL stations by region:", con.execute("SELECT region, count(DISTINCT station_id) FROM st GROUP BY 1 ORDER BY 1").fetchall())
TZ = {"California": "America/Los_Angeles"}  # everything else in this check is Mountain

print("\n=== 1. hourly look, local days 11-20..11-25 (per station, per local day) ===")
print("region|station|local_day|hrs|swe_first|swe_last|swe_net|swe_max-min|depth_first|depth_last|precip_net|tmin|tmax")
for reg_name in ("California", "Colorado", "Utah"):
    tz = TZ.get(reg_name, "America/Denver")
    rows = con.execute(f"""
      WITH h AS (SELECT station_id, variable, value, timezone('{tz}', valid_start) AS lt FROM raw
        WHERE source='snotel' AND kind='observation' AND period_label='hourly' AND value IS NOT NULL
        QUALIFY row_number() OVER (PARTITION BY station_id, variable, valid_start ORDER BY fetched_at DESC) = 1),
      x AS (SELECT s.station_id, CAST(lt AS DATE) d, lt, variable, value FROM h JOIN st s USING (station_id) WHERE s.region = '{reg_name}'
            AND CAST(lt AS DATE) BETWEEN DATE '2026-11-20' AND DATE '2026-11-25')
      SELECT '{reg_name}', station_id, d,
        count(DISTINCT lt) FILTER (WHERE variable='swe'),
        round(arg_min(value, lt) FILTER (WHERE variable='swe'),1), round(arg_max(value, lt) FILTER (WHERE variable='swe'),1),
        round(arg_max(value, lt) FILTER (WHERE variable='swe') - arg_min(value, lt) FILTER (WHERE variable='swe'),1),
        round(max(value) FILTER (WHERE variable='swe') - min(value) FILTER (WHERE variable='swe'),1),
        round(arg_min(value, lt) FILTER (WHERE variable='snow_depth'),1), round(arg_max(value, lt) FILTER (WHERE variable='snow_depth'),1),
        round(arg_max(value, lt) FILTER (WHERE variable='precip_accum') - arg_min(value, lt) FILTER (WHERE variable='precip_accum'),1),
        round(min(value) FILTER (WHERE variable='temp'),1), round(max(value) FILTER (WHERE variable='temp'),1)
      FROM x GROUP BY station_id, d ORDER BY station_id, d""").fetchall()
    for r in rows:
        print("|".join(str(v) for v in r))

print("\n=== 1b. daily-row truth that scoring used, by region x day (pairs.parquet, liquid strict mid, lead 1) ===")
print("region|day|resorts|sum obs mm|resorts>=2.5")
for r in con.execute("""SELECT region, local_date, count(DISTINCT resort_id), round(sum(obs),1), sum(CAST(obs>=2.5 AS INT))
  FROM (SELECT DISTINCT region, resort_id, local_date, obs FROM pairs WHERE space='liquid' AND pair_quality='strict' AND tier='mid'
        AND obs IS NOT NULL AND lead_day=1) WHERE region IN ('California','Colorado','Utah') AND local_date BETWEEN DATE '2026-11-19' AND DATE '2026-11-25'
  GROUP BY 1,2 ORDER BY 1,2""").fetchall():
    print("|".join(str(v) for v in r))

print("\n=== 2a. SNOTEL daily rows by valid date (strict mid stations): distinct stations with swe ===")
print("valid_date(UTC)|dow|stations_swe|stations_depth|stations_any|rows|fetch_dates")
for r in con.execute("""SELECT CAST(valid_start AS DATE) d, dayname(CAST(valid_start AS DATE)),
  count(DISTINCT station_id) FILTER (WHERE variable='swe'), count(DISTINCT station_id) FILTER (WHERE variable='snow_depth'),
  count(DISTINCT station_id), count(*), string_agg(DISTINCT CAST(CAST(fetched_at AS DATE) AS VARCHAR), ',')
  FROM raw WHERE source='snotel' AND kind='observation' AND period_label='daily' AND CAST(valid_start AS DATE) BETWEEN DATE '2026-10-30' AND DATE '2026-11-26'
  AND station_id IN (SELECT station_id FROM st) GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))

print("\n=== 2b. SNOTEL hourly distinct stations / hours by UTC date ===")
for r in con.execute("""SELECT CAST(valid_start AS DATE) d, dayname(CAST(valid_start AS DATE)), count(DISTINCT station_id), count(DISTINCT valid_start), count(*)
  FROM raw WHERE source='snotel' AND kind='observation' AND period_label='hourly' AND variable='swe'
  AND CAST(valid_start AS DATE) BETWEEN DATE '2026-11-01' AND DATE '2026-11-26' AND station_id IN (SELECT station_id FROM st) GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))

print("\n=== 2c. collector fetch dates (all snotel rows, any period) ===")
for r in con.execute("""SELECT CAST(fetched_at AS DATE) d, dayname(CAST(fetched_at AS DATE)), count(*), count(DISTINCT station_id)
  FROM raw WHERE CAST(fetched_at AS DATE) BETWEEN DATE '2026-11-01' AND DATE '2026-11-26' GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))

print("\n=== 2d. scored pairs: distinct resorts with obs, by local day and lead (liquid, strict, mid) ===")
print("local_date|dow|lead1 resorts|lead2|lead3|forecast rows lead1 (any obs)")
for r in con.execute("""SELECT local_date, dayname(local_date),
  count(DISTINCT resort_id) FILTER (WHERE lead_day=1 AND obs IS NOT NULL), count(DISTINCT resort_id) FILTER (WHERE lead_day=2 AND obs IS NOT NULL),
  count(DISTINCT resort_id) FILTER (WHERE lead_day=3 AND obs IS NOT NULL), count(DISTINCT resort_id) FILTER (WHERE lead_day=1)
  FROM pairs WHERE space='liquid' AND pair_quality='strict' AND tier='mid' AND local_date BETWEEN DATE '2026-10-30' AND DATE '2026-11-26'
  AND source_label LIKE 'open-meteo-previous-runs:%' GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))

print("\n=== 2e. does the day-gain chain explain it? daily readings present on day D but gain needs D+1 (start-of-day) ===")
print("For each date, stations that have a reading that day but none the next:")
for r in con.execute("""WITH d AS (SELECT DISTINCT station_id, CAST(valid_start AS DATE) d FROM raw WHERE source='snotel' AND kind='observation'
  AND period_label='daily' AND variable='swe' AND value IS NOT NULL AND station_id IN (SELECT station_id FROM st)
  AND CAST(valid_start AS DATE) BETWEEN DATE '2026-10-30' AND DATE '2026-11-26')
  SELECT a.d, dayname(a.d), count(*) FROM d a LEFT JOIN d b ON a.station_id=b.station_id AND b.d = a.d + 1
  WHERE b.d IS NULL GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))
