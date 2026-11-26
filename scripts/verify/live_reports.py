"""Print resort-reported daily snow (OnTheSnow) for the live season as JSON lines. Read-only.
One row per (resort, report date): latest fetched value. Usage: live_reports.py <bucket> <account_id>"""
import json
import os
import sys

import duckdb

bucket, acct = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute(f"SET s3_region='auto'; SET s3_endpoint='{acct}.r2.cloudflarestorage.com'; SET s3_url_style='path';")
con.execute(f"SET s3_access_key_id='{os.environ['AWS_ACCESS_KEY_ID']}'; SET s3_secret_access_key='{os.environ['AWS_SECRET_ACCESS_KEY']}';")
rows = con.execute(f"""SELECT resort_id, CAST(valid_start AS DATE) AS vs, arg_max(value, fetched_at) AS cm
  FROM read_parquet('s3://{bucket}/archive/source=onthesnow/month=2026-1*/*.parquet', union_by_name = true)
  WHERE variable = 'reported_daily_snow' AND value IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2""").fetchall()
for r, d, v in rows:
    print("REPORT " + json.dumps({"r": r, "vs": str(d), "cm": v}))
print(f"REPORT_COUNT {len(rows)}")
