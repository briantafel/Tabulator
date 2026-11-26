"""Why do 11-07, 11-14, 11-21 (Saturdays) have no scored forecast rows? Read-only, prints only.
Looks at Open-Meteo Previous Runs hourly precipitation for one US resort (mid tier): hours stored per
resort-local day and issue, with the fetch dates that supplied them. Usage: saturday_gap_diag.py <bucket> <account_id>"""
import os
import sys

import duckdb

bucket, acct = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute(f"SET s3_region='auto'; SET s3_endpoint='{acct}.r2.cloudflarestorage.com'; SET s3_url_style='path';")
con.execute(f"SET s3_access_key_id='{os.environ['AWS_ACCESS_KEY_ID']}'; SET s3_secret_access_key='{os.environ['AWS_SECRET_ACCESS_KEY']}';")
con.execute("SET TimeZone='UTC'")
src = f"read_parquet('s3://{bucket}/archive/source=open-meteo-previous-runs/month=2026-1*/*.parquet', union_by_name=true)"
print("columns:", [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()])
con.execute(f"""CREATE TABLE x AS SELECT resort_id, tier, model, variable, period_label, valid_start, fetched_at FROM {src}
  WHERE variable = 'precip' AND tier = 'mid' AND CAST(valid_start AS DATE) BETWEEN DATE '2026-10-30' AND DATE '2026-11-26'""")
print("rows:", con.execute("SELECT count(*), count(DISTINCT resort_id) FROM x").fetchone())
print("\nmodels:", con.execute("SELECT model, count(*) FROM x GROUP BY 1 ORDER BY 1").fetchall())
print("\n=== A. distinct hours stored per UTC valid date, issue previous_day1, one model (gfs_seamless), all resorts ===")
print("date|dow|distinct_hours_per_resort(min,max)|resorts")
for r in con.execute("""SELECT d, dayname(d), min(h), max(h), count(*) FROM (
    SELECT resort_id, CAST(valid_start AS DATE) d, count(DISTINCT valid_start) h FROM x
    WHERE model = 'gfs_seamless' AND period_label = 'previous_day1' GROUP BY 1, 2) GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(v) for v in r))
print("\n=== B. same, by fetch date: how many rows each fetch supplied for valid dates around the Saturdays ===")
for day in ("2026-11-07", "2026-11-14", "2026-11-21", "2026-11-08"):
    print(f"valid date {day}:")
    for r in con.execute(f"""SELECT CAST(fetched_at AS DATE) fd, period_label, count(*), count(DISTINCT valid_start), count(DISTINCT resort_id)
      FROM x WHERE model = 'gfs_seamless' AND CAST(valid_start AS DATE) = DATE '{day}' AND period_label IN ('previous_day1','previous_day2','previous_day3')
      GROUP BY 1, 2 ORDER BY 1, 2""").fetchall():
        print("  ", r)
print("\n=== C. one resort (alta) hours by UTC date x issue, gfs_seamless ===")
for r in con.execute("""SELECT CAST(valid_start AS DATE) d, dayname(CAST(valid_start AS DATE)), period_label, count(DISTINCT valid_start)
  FROM x WHERE model='gfs_seamless' AND resort_id = (SELECT min(resort_id) FROM x WHERE resort_id LIKE '%alta%' OR resort_id LIKE 'alta')
  AND period_label IN ('previous_day1','previous_day2','previous_day3') AND CAST(valid_start AS DATE) BETWEEN DATE '2026-11-05' AND DATE '2026-11-09'
  GROUP BY ALL ORDER BY 1, 3""").fetchall():
    print("|".join(str(v) for v in r))
