#!/usr/bin/env python3
"""Turn one run's archive rows (gzipped NDJSON) into Parquet.

    python3 scripts/archive/to_parquet.py <rowsDir> <outDir> <runId> <yyyy-mm>

Writes <outDir>/source=<source>/month=<yyyy-mm>/<runId>.parquet per source.
The column types below are the archive's schema; scripts/archive/common.js
lists the same columns in the same order. Keep the two in step.

Rows are sorted before writing so repeated values sit together, which is
most of why Parquet compresses this shape so well.
"""
import sys
from pathlib import Path

import duckdb

SCHEMA = {
    "source": "VARCHAR", "kind": "VARCHAR", "resort_id": "VARCHAR", "tier": "VARCHAR",
    "elevation_m": "INTEGER", "lat": "DOUBLE", "lon": "DOUBLE", "station_id": "VARCHAR",
    "issued_at": "TIMESTAMPTZ", "fetched_at": "TIMESTAMPTZ",
    "valid_start": "TIMESTAMPTZ", "valid_end": "TIMESTAMPTZ", "period_label": "VARCHAR",
    "variable": "VARCHAR", "value": "DOUBLE", "value_text": "VARCHAR", "unit": "VARCHAR",
    "model": "VARCHAR", "member": "SMALLINT", "run_id": "VARCHAR", "parser_version": "VARCHAR",
}


def main(rows_dir: str, out_dir: str, run_id: str, month: str) -> int:
    con = duckdb.connect()
    con.execute("SET TimeZone = 'UTC'")
    columns = "{" + ", ".join(f"'{k}': '{v}'" for k, v in SCHEMA.items()) + "}"
    total = 0
    for path in sorted(Path(rows_dir).glob("*.ndjson.gz")):
        source = path.name.removesuffix(".ndjson.gz")
        target = Path(out_dir) / f"source={source}" / f"month={month}" / f"{run_id}.parquet"
        target.parent.mkdir(parents=True, exist_ok=True)
        con.execute(
            f"CREATE OR REPLACE TABLE rows AS SELECT * FROM read_json('{path}', "
            f"format='newline_delimited', columns={columns}, compression='gzip')"
        )
        n = con.execute("SELECT count(*) FROM rows").fetchone()[0]
        if n == 0:
            print(f"  {source}: no rows, skipped", file=sys.stderr)
            continue
        con.execute(
            f"COPY (SELECT * FROM rows ORDER BY resort_id, station_id, variable, model, member, valid_start) "
            f"TO '{target}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 500000)"
        )
        back = con.execute(f"SELECT count(*) FROM read_parquet('{target}')").fetchone()[0]
        if back != n:
            raise SystemExit(f"{source}: wrote {back} rows, expected {n}")
        print(f"  {source}: {n} rows -> {target} ({target.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)
        total += n
    if total == 0:
        raise SystemExit("no rows converted")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    sys.exit(main(*sys.argv[1:]))
