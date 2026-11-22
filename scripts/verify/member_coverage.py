"""Do the collectors keep every ensemble member? Read-only; prints only.

For each forecast source, samples one month per winter (January) plus the current month straight from R2
(column-pruned reads, nothing downloaded) and prints, per model: rows, rows with no member number,
distinct members, distinct variables and resorts. Usage: member_coverage.py <bucket> <account_id>
"""
import os
import sys

import duckdb

bucket, acct = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute(f"SET s3_region='auto'; SET s3_endpoint='{acct}.r2.cloudflarestorage.com'; SET s3_url_style='path';")
con.execute(f"SET s3_access_key_id='{os.environ['AWS_ACCESS_KEY_ID']}'; SET s3_secret_access_key='{os.environ['AWS_SECRET_ACCESS_KEY']}';")
SOURCES = ["dynamical-ens", "noaa-gefs", "noaa-aigefs", "open-meteo-ensemble", "dwd-icon-eps", "meteoswiss-icon-eps",
           "ecmwf-opendata", "nbm", "noaa-hrrr", "msc-hrdps", "open-meteo-forecast", "open-meteo-previous-runs"]
MONTHS = ["2020-12", "2021-01", "2022-01", "2023-01", "2024-01", "2025-01", "2026-01", "2026-11"]
print("source | month | model | rows | rows_member_null | distinct_members | variables | resorts")
for src in SOURCES:
    for mo in MONTHS:
        g = f"s3://{bucket}/archive/source={src}/month={mo}/*.parquet"
        try:
            rows = con.execute(f"""SELECT coalesce(model, '-'), count(*), count(*) FILTER (WHERE member IS NULL),
                   count(DISTINCT member), count(DISTINCT variable), count(DISTINCT resort_id)
                FROM read_parquet('{g}', union_by_name = true) GROUP BY ALL ORDER BY 1""").fetchall()
        except Exception as e:  # no files that month, or no member column
            msg = str(e).splitlines()[0][:90]
            print(f"{src} | {mo} | -- | {msg}")
            continue
        for r in rows:
            print(f"{src} | {mo} | " + " | ".join(str(x) for x in r))
