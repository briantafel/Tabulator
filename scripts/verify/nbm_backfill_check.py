"""NBM backfill check, read-only: row counts for one month and a sanity comparison against SNOTEL.

    python3 scripts/verify/nbm_backfill_check.py <bucket> <account_id> <yyyy-mm>

Counts backfilled NBM rows (run_id bf-nbm-*) by cycle hour, variable and resort, lists wanted 00z/12z cycles with no rows
(gaps) and the plausibility range per variable. Then a coarse sanity check, NOT a skill claim: NBM liquid for each resort-local
day, from the 12z cycle of the day before (lead ~17-20 h to ~41-44 h), against the SNOTEL SWE gain of that day at the nearest
mapped station (<= 25 km, no elevation matching: this is a "do the numbers line up" test, not the scoring pairing, which
lives in verify/build.py). Reports n, correlation, wet/dry ratio and yes/no hit rates at 2.5 and 10 mm. Both day alignments
of SNOTEL (reading at start or end of the date) are shown, as build.py tests them. Writes nothing.
"""
import json
import os
import sys
from calendar import monthrange
from pathlib import Path

import duckdb

bucket, acct, month = sys.argv[1], sys.argv[2], sys.argv[3]
y, m = int(month[:4]), int(month[5:])
ndays = monthrange(y, m)[1]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET TimeZone='UTC';")
con.execute(f"SET s3_region='auto'; SET s3_endpoint='{acct}.r2.cloudflarestorage.com'; SET s3_url_style='path';")
con.execute(f"SET s3_access_key_id='{os.environ['AWS_ACCESS_KEY_ID']}'; SET s3_secret_access_key='{os.environ['AWS_SECRET_ACCESS_KEY']}';")
con.execute(f"CREATE VIEW nbm AS SELECT * FROM read_parquet('s3://{bucket}/archive/source=nbm/month={month}/*.parquet', union_by_name=true) "
            "WHERE run_id LIKE 'bf-nbm-%'")

print(f"== NBM backfill {month}: rows by cycle hour and variable")
for r in con.execute("""SELECT hour(issued_at) AS cyc, variable, count(*) n, count(DISTINCT resort_id) resorts, count(DISTINCT issued_at) cycles,
                        round(min(value),2), round(avg(value),2), round(max(value),2), any_value(unit)
                        FROM nbm GROUP BY ALL ORDER BY 1, 2""").fetchall():
    print(" | ".join(str(x) for x in r))
tot = con.execute("SELECT count(*), count(DISTINCT issued_at), count(DISTINCT resort_id), count(DISTINCT parser_version), any_value(parser_version) FROM nbm").fetchone()
print(f"total rows {tot[0]}, cycles {tot[1]}, resorts {tot[2]}, parser versions {tot[3]} ({tot[4]})")
have = {r[0] for r in con.execute("SELECT DISTINCT strftime(issued_at, '%Y%m%d%H') FROM nbm").fetchall()}
want = [f"{y}{m:02d}{d:02d}{h:02d}" for d in range(1, ndays + 1) for h in (0, 12)]
missing = [w for w in want if w not in have]
print(f"wanted cycles {len(want)}, with rows {len(want) - len(missing)}, without rows {len(missing)}: {', '.join(missing) or 'none'}")
print("last lead per cycle (hours from issue to the last block end), min/median/max:",
      con.execute("SELECT min(l), median(l), max(l) FROM (SELECT issued_at, max(epoch(valid_end - issued_at)) / 3600 AS l FROM nbm GROUP BY 1)").fetchone())
dup = con.execute("SELECT count(*) FROM (SELECT 1 FROM nbm WHERE variable='precip' GROUP BY resort_id, issued_at, valid_start HAVING count(*) > 1)").fetchone()[0]
print(f"duplicate precip blocks (same resort, cycle, period): {dup}" + ("  <-- PROBLEM" if dup else ""))

resorts = {r["id"]: r["tz"] for r in json.loads(Path("src/data/resorts.json").read_text())["resorts"]}
con.execute("CREATE TABLE rz(resort_id VARCHAR, tz VARCHAR)")
con.executemany("INSERT INTO rz VALUES (?, ?)", list(resorts.items()))
con.execute(f"""CREATE VIEW sn_raw AS SELECT * FROM read_parquet('s3://{bucket}/archive/source=snotel/**/*.parquet', union_by_name=true, hive_partitioning=false)
                WHERE (kind = 'mapping') OR (kind='observation' AND period_label='daily' AND variable='swe'
                  AND valid_start >= TIMESTAMP '{y}-{m:02d}-01' - INTERVAL 3 DAY AND valid_start < TIMESTAMP '{y}-{m:02d}-01' + INTERVAL 36 DAY)""")
con.execute("""CREATE TABLE cand AS SELECT resort_id, station_id, arg_max(value, fetched_at) AS km FROM sn_raw WHERE kind='mapping' GROUP BY resort_id, station_id""")
con.execute("""CREATE TABLE near AS SELECT resort_id, station_id, km FROM cand WHERE km <= 25 QUALIFY row_number() OVER (PARTITION BY resort_id ORDER BY km) = 1""")
print(f"== SNOTEL sanity: {con.execute('SELECT count(*) FROM near').fetchone()[0]} resorts with a SNOTEL station within 25 km")
con.execute("""CREATE TABLE sn AS SELECT station_id, valid_start, value FROM sn_raw WHERE kind='observation'
               QUALIFY row_number() OVER (PARTITION BY station_id, valid_start ORDER BY fetched_at DESC) = 1""")
con.execute("""CREATE TABLE gain AS
  SELECT n.resort_id, CAST(timezone(z.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE) AS d, s.value AS v,
         lead(s.value) OVER w - s.value AS g_start, s.value - lag(s.value) OVER w AS g_end,
         datediff('day', CAST(timezone(z.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE), lead(CAST(timezone(z.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE)) OVER w) AS gap_next,
         datediff('day', lag(CAST(timezone(z.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE)) OVER w, CAST(timezone(z.tz, s.valid_start + INTERVAL 1 HOUR) AS DATE)) AS gap_prev
  FROM sn s JOIN near n USING (station_id) JOIN rz z USING (resort_id)
  WINDOW w AS (PARTITION BY n.resort_id, s.station_id ORDER BY s.valid_start)""")
# NBM liquid per resort-local day D from the 12z cycle of D-1 (pro rata across 6 h blocks; a full 24 h of coverage only).
con.execute(f"""CREATE TABLE fc AS
  WITH b AS (SELECT n.resort_id, z.tz, n.issued_at, n.valid_start, n.valid_end, n.value FROM nbm n JOIN rz z USING (resort_id)
             WHERE n.variable='precip' AND hour(n.issued_at) = 12),
  x AS (SELECT b.*, CAST(unnest(generate_series(CAST(CAST(timezone(tz, valid_start) AS DATE) AS TIMESTAMP),
                                                CAST(CAST(timezone(tz, valid_end - INTERVAL 1 SECOND) AS DATE) AS TIMESTAMP), INTERVAL 1 DAY)) AS DATE) AS d FROM b)
  , c AS (SELECT resort_id, d, issued_at, valid_start, valid_end, value, timezone(tz, CAST(d AS TIMESTAMP)) ds, timezone(tz, CAST(d AS TIMESTAMP) + INTERVAL 1 DAY) de FROM x
          WHERE CAST(issued_at AS DATE) = d - 1)
  SELECT resort_id, d, sum(value * epoch(least(valid_end, de) - greatest(valid_start, ds)) / epoch(valid_end - valid_start)) AS nbm_mm,
         sum(epoch(least(valid_end, de) - greatest(valid_start, ds))) / 3600 AS cov_h
  FROM c GROUP BY resort_id, d HAVING sum(epoch(least(valid_end, de) - greatest(valid_start, ds))) / 3600 >= 23.99""")
for name, col, gapcol in (("reading at START of date", "g_start", "gap_next"), ("reading at END of date", "g_end", "gap_prev")):
    r = con.execute(f"""SELECT count(*), round(corr(f.nbm_mm, g.{col}), 3), round(sum(f.nbm_mm), 0), round(sum(g.{col}), 0),
        round(sum(f.nbm_mm) / nullif(sum(g.{col}), 0), 2),
        count(*) FILTER (WHERE g.{col} >= 2.5 AND f.nbm_mm >= 2.5), count(*) FILTER (WHERE g.{col} >= 2.5 AND f.nbm_mm < 2.5),
        count(*) FILTER (WHERE g.{col} < 2.5 AND f.nbm_mm >= 2.5),
        count(*) FILTER (WHERE g.{col} >= 10 AND f.nbm_mm >= 10), count(*) FILTER (WHERE g.{col} >= 10 AND f.nbm_mm < 10),
        count(*) FILTER (WHERE g.{col} < 10 AND f.nbm_mm >= 10), count(DISTINCT f.resort_id)
        FROM fc f JOIN gain g ON g.resort_id = f.resort_id AND g.d = f.d WHERE g.{gapcol} = 1 AND g.{col} BETWEEN -0.01 AND 300""").fetchone()
    n, rr, sf, ss, ratio, h25, m25, fa25, h10, m10, fa10, nres = r
    csi = lambda h, mi, fa: round(h / (h + mi + fa), 3) if (h + mi + fa) else None
    print(f"SNOTEL SWE gain, {name}: n={n} resort-days ({nres} resorts), r={rr}, NBM total {sf} mm vs SNOTEL {ss} mm (ratio {ratio})")
    print(f"   >=2.5 mm: hits {h25} misses {m25} false alarms {fa25} CSI {csi(h25, m25, fa25)}; >=10 mm: hits {h10} misses {m10} false alarms {fa10} CSI {csi(h10, m10, fa10)}")
print("(Coarse: nearest station without elevation matching, one cycle per day; SNOTEL SWE steps are 2.54 mm. Not a skill claim.)")
