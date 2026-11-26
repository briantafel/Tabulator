"""Why did live CSI at 2.5 mm fall between the 11-22 and 11-26 verify runs? Read-only, prints only.

Same population and blend as bias_diag.py (live blend.json, Previous Runs, strict mid-tier SNOTEL/BC pairs,
liquid, leads 1-3, Washington excluded). Compares OLD pairs (verify/<old day>/pairs.parquet) with NEW
(verify/latest/pairs.parquet):
  A. per local day: n, wet, hits / false alarms / misses at 2.5 mm, CSI, in NEW; marks days absent in OLD.
  B. same keys in both files: how many obs or forecasts changed (revisions to already-scored days).
  C. CSI on OLD's days only, computed from NEW (does the drop come from new days or rewritten old ones?).
  D. new days by region, and the false alarms on them: forecast size and observed value.
Usage: csi_drop_diag.py <old pairs> <new pairs> <blend.json>
"""
import json
import sys

import duckdb

old, new, bj = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3]))
con = duckdb.connect()
for tag, f in (("o", old), ("n", new)):
    con.execute(f"""CREATE TABLE p_{tag} AS SELECT split_part(source_label, ':', 2) AS model, region, resort_id,
      local_date, lead_day AS lead, fc_amount AS fc, obs FROM read_parquet('{f}')
      WHERE source_label LIKE 'open-meteo-previous-runs:%' AND space = 'liquid' AND pair_quality = 'strict'
        AND tier = 'mid' AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day BETWEEN 1 AND 3
        AND split = 'live' AND region <> 'Washington'""")
con.execute("CREATE TABLE fac(model VARCHAR, lead INT, region VARCHAR, f DOUBLE)")
con.executemany("INSERT INTO fac VALUES (?,?,?,?)", [(k.split('|')[0], int(k.split('|')[1]), k.split('|')[2], v) for k, v in bj["factors"].items()])
con.execute("CREATE TABLE pool(model VARCHAR, lead INT, f DOUBLE)")
con.executemany("INSERT INTO pool VALUES (?,?,?)", [(k.split('|')[0], int(k.split('|')[1]), v) for k, v in bj["pooled_factors"].items()])
con.execute("CREATE TABLE w(lead INT, model VARCHAR, w DOUBLE)")
con.executemany("INSERT INTO w VALUES (?,?,?)", [(int(l), m, v) for l, ws in bj["weights"].items() for m, v in ws.items()])
for tag in ("o", "n"):
    con.execute(f"""CREATE TABLE b{tag} AS SELECT resort_id, region, local_date, lead, any_value(obs) obs,
      sum(w.w * d.fc * coalesce(fac.f, pool.f, 1.0)) / sum(w.w) bl, count(*) nm
      FROM p_{tag} d JOIN w USING (lead, model) LEFT JOIN fac USING (model, lead, region) LEFT JOIN pool USING (model, lead)
      GROUP BY ALL""")
S = """count(*) n, sum(CAST(obs>=2.5 AS INT)) wet, sum(CAST(bl>=2.5 AND obs>=2.5 AS INT)) h,
  sum(CAST(bl>=2.5 AND obs<2.5 AS INT)) fa, sum(CAST(bl<2.5 AND obs>=2.5 AS INT)) m,
  round(sum(CAST(bl>=2.5 AND obs>=2.5 AS INT))/nullif(sum(CAST(bl>=2.5 OR obs>=2.5 AS INT)),0),3) csi,
  sum(CAST(obs<1 AND bl>=2.5 AS INT)) fa_dry"""
print("totals OLD:", con.execute(f"SELECT {S} FROM bo").fetchone())
print("totals NEW:", con.execute(f"SELECT {S} FROM bn").fetchone())
print("\nA. per day (NEW) | in OLD?\nday|n|wet|hits|FA|miss|CSI|FA on dry|in_old")
for r in con.execute(f"""SELECT local_date, {S}, local_date IN (SELECT DISTINCT local_date FROM bo) FROM bn
                         GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(x) for x in r))
print("\nB. same resort/day/lead in both files")
print(con.execute("""SELECT count(*) both_n,
  sum(CAST(abs(o.obs-n.obs)>0.01 AS INT)) obs_changed, sum(CAST(abs(o.bl-n.bl)>0.05 AS INT)) fc_changed,
  sum(CAST((o.obs>=2.5)<>(n.obs>=2.5) AS INT)) obs_flip25, sum(CAST((o.bl>=2.5)<>(n.bl>=2.5) AS INT)) fc_flip25,
  sum(CAST(o.nm<>n.nm AS INT)) models_changed
  FROM bo o JOIN bn n USING (resort_id, local_date, lead)""").fetchone())
print("keys only in OLD:", con.execute("SELECT count(*) FROM bo ANTI JOIN bn USING (resort_id, local_date, lead)").fetchone()[0])
for r in con.execute("""SELECT o.resort_id, o.local_date, o.lead, round(o.obs,1), round(n.obs,1), round(o.bl,1), round(n.bl,1)
  FROM bo o JOIN bn n USING (resort_id, local_date, lead) WHERE abs(o.obs-n.obs)>0.01 OR abs(o.bl-n.bl)>0.05
  ORDER BY 2, 1, 3 LIMIT 25""").fetchall():
    print("  changed:", r)
print("\nC. OLD's days only, scored from NEW:", con.execute(f"SELECT {S} FROM bn WHERE local_date IN (SELECT DISTINCT local_date FROM bo)").fetchone())
print("   new days only, from NEW:        ", con.execute(f"SELECT {S} FROM bn WHERE local_date NOT IN (SELECT DISTINCT local_date FROM bo)").fetchone())
print("\nD. new days by region\nregion|n|wet|hits|FA|miss|CSI|FA on dry")
for r in con.execute(f"""SELECT region, {S} FROM bn WHERE local_date NOT IN (SELECT DISTINCT local_date FROM bo)
                         GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(x) for x in r))
print("\n   false alarms on new days: forecast mm bucket x observed mm")
for r in con.execute("""SELECT CASE WHEN bl<5 THEN '2.5-5' WHEN bl<10 THEN '5-10' ELSE '10+' END fcb,
   CASE WHEN obs<0.5 THEN '0' WHEN obs<2.5 THEN '0.5-2.5 (one SWE step)' END ob, count(*)
   FROM bn WHERE local_date NOT IN (SELECT DISTINCT local_date FROM bo) AND bl>=2.5 AND obs<2.5 GROUP BY ALL ORDER BY 1, 2""").fetchall():
    print("  ", r)
print("\n   all live days: FA by forecast bucket (does light-forecast FA dominate everywhere?)")
for r in con.execute("""SELECT CASE WHEN bl<5 THEN '2.5-5' WHEN bl<10 THEN '5-10' ELSE '10+' END fcb, count(*),
   round(avg(obs),2) FROM bn WHERE bl>=2.5 AND obs<2.5 GROUP BY 1 ORDER BY 1""").fetchall():
    print("  ", r)

print("\nE. new days, region x day: obs vs blend vs raw models (sums over resort-day-leads, mm)")
print("region|day|n|obs|blend|ecmwf|gem|gfs|obs wet>=2.5|blend wet>=2.5")
con.execute("""CREATE TABLE raw AS SELECT resort_id, region, local_date, lead, any_value(obs) obs,
  max(CASE WHEN model='ecmwf_ifs025' THEN fc END) ec, max(CASE WHEN model='gem_seamless' THEN fc END) gm,
  max(CASE WHEN model='gfs_seamless' THEN fc END) gf FROM p_n GROUP BY ALL""")
for r in con.execute("""SELECT b.region, b.local_date, count(*), round(sum(b.obs),0), round(sum(b.bl),0), round(sum(ec),0),
   round(sum(gm),0), round(sum(gf),0), sum(CAST(b.obs>=2.5 AS INT)), sum(CAST(b.bl>=2.5 AS INT))
   FROM bn b JOIN raw USING (resort_id, local_date, lead) WHERE b.local_date >= DATE '2026-11-21'
   GROUP BY 1, 2 HAVING sum(b.obs) > 0 OR sum(b.bl) > 5 ORDER BY 1, 2""").fetchall():
    print("|".join(str(x) for x in r))
print("\nF. timing test: 2-day windows (this day + next) at 2.5 mm, new days vs old days")
con.execute("""CREATE TABLE w2 AS SELECT a.resort_id, a.region, a.local_date, a.lead, a.obs + b.obs obs2, a.bl + b.bl bl2
   FROM bn a JOIN bn b ON a.resort_id=b.resort_id AND a.lead=b.lead AND b.local_date = a.local_date + 1""")
for lab, cond in (("old days", "local_date < DATE '2026-11-21'"), ("new days", "local_date >= DATE '2026-11-21'")):
    print(" ", lab, con.execute(f"""SELECT count(*), sum(CAST(bl2>=2.5 AND obs2>=2.5 AS INT)), sum(CAST(bl2>=2.5 AND obs2<2.5 AS INT)),
      sum(CAST(bl2<2.5 AND obs2>=2.5 AS INT)),
      round(sum(CAST(bl2>=2.5 AND obs2>=2.5 AS INT))/nullif(sum(CAST(bl2>=2.5 OR obs2>=2.5 AS INT)),0),3)
      FROM w2 WHERE {cond}""").fetchone(), "(n, hits, FA, miss, CSI)")
print("\nG. missing local days in the live window (NEW):",
      [str(r[0]) for r in con.execute("""SELECT d::DATE FROM range(DATE '2026-11-01', (SELECT max(local_date) FROM bn) + 1, INTERVAL 1 DAY) t(d)
        WHERE d::DATE NOT IN (SELECT local_date FROM bn) ORDER BY 1""").fetchall()])
print("   rows on those days in p_n before the strict/obs filters? see build; obs NULL count by day:")
for r in con.execute(f"""SELECT CAST(local_date AS DATE) d, count(*), count(obs) FROM read_parquet('{new}')
   WHERE source_label LIKE 'open-meteo-previous-runs:%' AND space='liquid' AND tier='mid' AND split='live'
     AND pair_quality='strict' AND lead_day BETWEEN 1 AND 3 AND local_date IN ('2026-11-07','2026-11-14','2026-11-21','2026-11-20')
   GROUP BY 1 ORDER BY 1""").fetchall():
    print("  ", r)
