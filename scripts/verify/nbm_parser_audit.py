"""Read-only: which parser and which runs wrote the NBM rows issued 2024-11-01 → 2026-04-30 (00z/12z), the rows
blend_nbm.py scores. pairs.parquet does not carry parser_version or run_id, so this reads the archive itself.

    python3 scripts/verify/nbm_parser_audit.py <bucket> <account_id>

Exits non-zero if any row in that range is from a parser other than nbm-3 (verify/build.py drops nbm-1/2 anyway; a
non-zero count here means the backfill did not replace them and the scored rows need a second look).
"""
import os
import sys

import duckdb

bucket, acct = sys.argv[1], sys.argv[2]
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET TimeZone='UTC';")
con.execute(f"SET s3_region='auto'; SET s3_endpoint='{acct}.r2.cloudflarestorage.com'; SET s3_url_style='path';")
con.execute(f"SET s3_access_key_id='{os.environ['AWS_ACCESS_KEY_ID']}'; SET s3_secret_access_key='{os.environ['AWS_SECRET_ACCESS_KEY']}';")
months = [f"{y}-{m:02d}" for y, m in [(2024, 11), (2024, 12)] + [(2025, m) for m in range(1, 13)] + [(2026, m) for m in range(1, 5)]]
files = [f"s3://{bucket}/archive/source=nbm/month={m}/*.parquet" for m in months]
con.execute(f"CREATE VIEW n AS SELECT parser_version, run_id, issued_at FROM read_parquet({files}, union_by_name=true) "
            "WHERE issued_at >= TIMESTAMP '2024-11-01' AND issued_at < TIMESTAMP '2026-05-01' AND hour(issued_at) IN (0, 12)")
rows = con.execute("""SELECT coalesce(parser_version, '(none)') pv,
                             CASE WHEN run_id LIKE 'bf-nbm-%' THEN 'backfill (bf-nbm-*)' ELSE 'other run' END kind,
                             count(*), count(DISTINCT issued_at), strftime(min(issued_at), '%Y-%m-%d %HZ'), strftime(max(issued_at), '%Y-%m-%d %HZ')
                      FROM n GROUP BY ALL ORDER BY 1, 2""").fetchall()
print("| parser | run kind | rows | cycles | first | last |\n|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(str(x) for x in r) + " |")
bad = sum(r[2] for r in rows if r[0] != "nbm-3")
print(f"\nRows from a parser other than nbm-3: {bad}")
if bad:
    raise SystemExit(f"::error::{bad} NBM rows in the scored range are not nbm-3")
