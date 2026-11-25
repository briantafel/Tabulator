#!/usr/bin/env python3
"""Interior-Canada live model coverage check (read-only, public sources only, no app change).

Question (2026-11-25): live NBM and HRDPS 6 h precipitation sums to about 0 at most Kootenay/Rockies resorts (e.g. Fernie HRDPS
0.9 mm where the BC pillow gained 39 mm). Are those zeros REAL, MISSING, or MISSING STORED AS ZERO?

RULE (fixed before any number is read). Per resort x source (nbm, noaa-hrrr surface, msc-hrdps) on LIVE rows only
(run_id not starting 'bf-'), variable precip, 6 h blocks, 2026-11-11 onward:
  NO ROWS      no row at all: no model cell within the collector's max distance. A gap, not a zero. The blend must drop the model.
  STORED ZERO  >= 20 blocks exist where the open-meteo-forecast reference (mean over its models) is >= 1 mm, and the model is
               EXACTLY 0.0 in >= 80% of them, and the model's largest value at the resort over the whole window is < 1 mm.
               Likely missing-as-zero (or a grid edge): scored as untrustworthy until shown otherwise.
  THIN         fewer than 20 reference-wet blocks overlap: cannot decide; reported, not judged.
  PLAUSIBLE    anything else: the model wets when the reference wets.
CONTROLS: alta and jackson-hole (nbm, hrrr), whistler and revelstoke (hrdps) must come out PLAUSIBLE, or the method is broken
and nothing below is trusted. Also reported per resort x source: rows, distinct blocks, distinct UTC days, share exactly 0.0,
max, first/last block. Open-meteo reference only; no paid source is read or named.
Usage: interior_models_coverage.py <archive dir with source=<name>/ subdirs> <outDir>
"""
import sys, glob, os
import duckdb

POOL = ("panorama", "kimberley", "fernie", "kicking-horse", "norquay", "sunshine", "lake-louise", "marmot")
CONTROL = {"nbm": ("alta", "jackson-hole"), "noaa-hrrr": ("alta", "jackson-hole"), "msc-hrdps": ("whistler", "revelstoke")}
SOURCES = ("nbm", "noaa-hrrr", "msc-hrdps")
FROM = "2026-11-11"
MIN_REF_WET, WET_MM, ZERO_SHARE, MAXV = 20, 1.0, 0.80, 1.0

def load(con, arch):
    parts = []
    for s in SOURCES + ("open-meteo-forecast",):
        fs = glob.glob(os.path.join(arch, f"source={s}", "**", "*.parquet"), recursive=True)
        if not fs: print(f"! no parquet for {s}"); continue
        parts.append(f"SELECT '{s}' AS src, resort_id, variable, value, valid_start, valid_end, run_id, model FROM read_parquet({fs!r}, union_by_name=true)"
                     f" WHERE kind='forecast' AND variable='precip' AND value IS NOT NULL AND valid_end >= TIMESTAMP '{FROM}'"
                     f" AND (run_id IS NULL OR run_id NOT LIKE 'bf-%')")
    if not parts: raise SystemExit("no archive data found")
    con.execute("CREATE TABLE f AS " + " UNION ALL ".join(parts))
    # reference: open-meteo-forecast 6 h blocks, mean across its models, one value per block
    con.execute("""CREATE TABLE ref AS SELECT resort_id, valid_start, valid_end, avg(value) AS ref FROM f WHERE src='open-meteo-forecast'
                   GROUP BY 1,2,3""")
    # model value per block: the latest-valued? take MAX across cycles that issued it (a missing-as-zero model is 0 in every cycle)
    con.execute("""CREATE TABLE m AS SELECT src, resort_id, valid_start, valid_end, max(value) AS v, min(value) AS vmin, count(*) AS n
                   FROM f WHERE src IN ('nbm','noaa-hrrr','msc-hrdps') GROUP BY 1,2,3,4""")

def classify(con, src, resort):
    r = con.execute("""SELECT count(*), count(DISTINCT cast(valid_end AS DATE)), avg((v = 0)::INT), max(v), min(valid_end), max(valid_end)
                       FROM m WHERE src=? AND resort_id=?""", [src, resort]).fetchone()
    n, days, zshare, mx, first, last = r
    if not n: return dict(src=src, resort=resort, verdict="NO ROWS", blocks=0, days=0)
    w = con.execute("""SELECT count(*), avg((m.v = 0)::INT) FROM m JOIN ref r USING (resort_id, valid_start, valid_end)
                       WHERE m.src=? AND m.resort_id=? AND r.ref >= ?""", [src, resort, WET_MM]).fetchone()
    nwet, zwet = w[0], (w[1] if w[1] is not None else 0.0)
    if nwet < MIN_REF_WET: verdict = "THIN"
    elif zwet >= ZERO_SHARE and mx < MAXV: verdict = "STORED ZERO"
    else: verdict = "PLAUSIBLE"
    return dict(src=src, resort=resort, verdict=verdict, blocks=n, days=days, zero_all=round(zshare, 3), max=round(mx, 2),
                ref_wet=nwet, zero_when_ref_wet=round(zwet, 3), first=str(first)[:16], last=str(last)[:16])

def main(arch, out):
    os.makedirs(out, exist_ok=True)
    con = duckdb.connect(); load(con, arch)
    rows, bad = [], []
    for s in SOURCES:
        for r in POOL + CONTROL[s]:
            c = classify(con, s, r); c["role"] = "control" if r in CONTROL[s] else "interior"; rows.append(c)
            if c["role"] == "control" and c["verdict"] not in ("PLAUSIBLE",): bad.append(f"{s}/{r}: {c['verdict']}")
    lines = ["# Interior Canada live model coverage (2026-11-25)", "",
             f"Live rows from {FROM}, precip, 6 h blocks. Reference: open-meteo-forecast. Rule is in the script docstring.", ""]
    if bad: lines += ["**METHOD CHECK FAILED: controls not PLAUSIBLE: " + "; ".join(bad) + ". Do not trust the interior rows.**", ""]
    lines += ["| source | resort | role | verdict | blocks | days | exactly 0 (all) | max mm | ref-wet blocks | 0 when ref wet | first | last |", "|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|"]
    for c in rows:
        lines.append(f"| {c['src']} | {c['resort']} | {c['role']} | {c['verdict']} | {c.get('blocks',0)} | {c.get('days',0)} | {c.get('zero_all','')} | {c.get('max','')} | {c.get('ref_wet','')} | {c.get('zero_when_ref_wet','')} | {c.get('first','')} | {c.get('last','')} |")
    md = "\n".join(lines); open(os.path.join(out, "interior_models_coverage.md"), "w").write(md); print(md)
    return rows, bad

if __name__ == "__main__":
    if len(sys.argv) != 3: raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
