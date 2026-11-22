"""Truth coverage by winter: which observation sources reach back how far, and for how many places.

Read-only. Prints a table per (source, variable, period) of days, places and first/last date for each
winter (a winter starts in July, so Nov-Apr stays together). Changes nothing; nothing is scored.
Usage: python3 scripts/verify/truth_coverage.py <archive dir>   (must hold the truth sources' parquet)
"""
import sys
from pathlib import Path

import duckdb

arch = Path(sys.argv[1])
files = sorted(str(p) for p in arch.rglob("*.parquet"))
if not files:
    raise SystemExit(f"no parquet files under {arch}")
con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
flist = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
con.execute(f"CREATE VIEW raw AS SELECT * FROM read_parquet({flist}, union_by_name = true, hive_partitioning = false)")
cols = {r[0] for r in con.execute("DESCRIBE raw").fetchall()}
place = "coalesce(resort_id, station_id)" if {"resort_id", "station_id"} <= cols else ("resort_id" if "resort_id" in cols else "station_id")
print(f"files: {len(files)}; columns: {sorted(cols)}")
rows = con.execute(f"""
  SELECT source, kind, variable, period_label,
         CASE WHEN month(valid_start) >= 7 THEN year(valid_start) ELSE year(valid_start) - 1 END AS winter,
         count(*) AS n, count(DISTINCT CAST(valid_start AS DATE)) AS days, count(DISTINCT {place}) AS places,
         min(CAST(valid_start AS DATE)) AS first_day, max(CAST(valid_start AS DATE)) AS last_day,
         count(*) FILTER (WHERE value IS NULL) AS null_n
  FROM raw WHERE kind = 'observation' OR kind = 'analysis'
  GROUP BY ALL ORDER BY source, variable, period_label, winter
""").fetchall()
print("source | kind | variable | period | winter | rows | days | places | first | last | null")
for r in rows:
    print(" | ".join(str(x) for x in r))
