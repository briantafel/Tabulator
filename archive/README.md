# Forecast archive

Every forecast and observation Tabulator can reach, kept forever, so the app
can learn how each forecast errs and eventually show its own corrected
forecast with a range. Spec: *Tabulator Forecast Archive — Spec* (Claude Docs).

Collection runs twice a day in `.github/workflows/archive.yml`, separately
from the app's own scrape, and uploads to the private Cloudflare R2 bucket
named in the `R2_BUCKET` secret. Nothing here is committed to git except
code and this folder.

## What is in the bucket

```
dictionary.yaml                                    this folder's dictionary, refreshed each run
runs/<run_id>.json                                 what ran, what failed, row counts
raw/source=<source>/date=<yyyy-mm-dd>/<run_id>.tar  the bytes as fetched, gzipped, one tar per source per run
archive/source=<source>/month=<yyyy-mm>/<run_id>.parquet   one row per value
```

Sources so far: `snow-forecast` (all three tiers, the spine),
`open-meteo-ensemble` (ECMWF and GFS, every member) and `snotel` (ground
truth for US resorts). Every column and variable is defined in
`dictionary.yaml`.

## Reading it

DuckDB reads the whole archive in place with plain SQL, from a laptop, a
notebook or an Action. With the bucket's read key:

```sql
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE r2, KEY_ID '…', SECRET '…', ACCOUNT_ID '…');

-- How did Snow-Forecast's mid-tier snow for Alta move as the day approached?
SELECT fetched_at, valid_start, value
FROM read_parquet('r2://tabulator-archive/archive/source=snow-forecast/**/*.parquet', hive_partitioning = 1)
WHERE resort_id = 'alta' AND tier = 'mid' AND variable = 'snow'
ORDER BY valid_start, fetched_at;
```

Keys belong in a password manager or a secret store, never in a chat or a
file in this repo.

## Running it by hand

```
node scripts/archive/collect.js out/          # fetch everything once
python3 scripts/archive/to_parquet.py out/rows parquet/ <run_id> <yyyy-mm>
```

The sandbox Claude works in cannot reach any of these sources; GitHub's
runners and your own Terminal can.
