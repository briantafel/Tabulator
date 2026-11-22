"""Water-bias diagnosis by region (read-only; public sources only, prints only).

Applies the LIVE blend's factors and weights (public/blend.json) to pairs.parquet's Open-Meteo Previous Runs
rows, exactly as blend.py does, and prints for each region x lead group x winter split:
  days, wet days, blend volume (sum blend / sum SNOTEL water), raw-model volumes,
  light-day false alarms (SNOTEL < 1 mm while blend >= 2.5 / >= 5 mm), frequency bias at 2.5 and 10 mm,
and the per-winter raw factor (sum obs / sum fc) per model, to show whether a region's correction carries
across winters. Usage: bias_diag.py <pairs.parquet> <blend.json>
"""
import json
import sys

import duckdb

pairs, bj = sys.argv[1], json.load(open(sys.argv[2]))
con = duckdb.connect()
con.execute(f"""CREATE TABLE d AS SELECT split_part(source_label, ':', 2) AS model, region, resort_id, local_date,
  lead_day AS lead, split, fc_amount AS fc, obs FROM read_parquet('{pairs}')
  WHERE source_label LIKE 'open-meteo-previous-runs:%' AND space = 'liquid' AND pair_quality = 'strict'
    AND tier = 'mid' AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day BETWEEN 1 AND 7""")
print("rows by split:", con.execute("SELECT split, count(*) FROM d GROUP BY 1 ORDER BY 1").fetchall())
con.execute("CREATE TABLE fac(model VARCHAR, lead INT, region VARCHAR, f DOUBLE)")
con.executemany("INSERT INTO fac VALUES (?,?,?,?)", [(k.split('|')[0], int(k.split('|')[1]), k.split('|')[2], v)
                                                    for k, v in bj["factors"].items()])
con.execute("CREATE TABLE pool(model VARCHAR, lead INT, f DOUBLE)")
con.executemany("INSERT INTO pool VALUES (?,?,?)", [(k.split('|')[0], int(k.split('|')[1]), v) for k, v in bj["pooled_factors"].items()])
con.execute("CREATE TABLE w(lead INT, model VARCHAR, w DOUBLE)")
con.executemany("INSERT INTO w VALUES (?,?,?)", [(int(l), m, v) for l, ws in bj["weights"].items() for m, v in ws.items()])
con.execute("""CREATE TABLE b AS SELECT resort_id, region, local_date, lead, split, any_value(obs) obs,
  sum(w.w * d.fc * coalesce(fac.f, pool.f, 1.0)) / sum(w.w) AS blend,
  max(CASE WHEN model='ecmwf_ifs025' THEN fc END) ecmwf, max(CASE WHEN model='gem_seamless' THEN fc END) gem,
  max(CASE WHEN model='gfs_seamless' THEN fc END) gfs
  FROM d JOIN w USING (lead, model) LEFT JOIN fac USING (model, lead, region) LEFT JOIN pool USING (model, lead)
  GROUP BY ALL""")
REG = "('California','Nevada','Utah','Colorado','Washington','Oregon','Idaho','Montana','Wyoming','New Mexico')"
q = f"""SELECT region, CASE WHEN lead <= 3 THEN '1-3' ELSE '4-7' END lg, split, count(*) n, sum(CAST(obs>=1 AS INT)) wet,
  round(sum(blend)/nullif(sum(obs),0),2) vol_blend, round(sum(ecmwf)/nullif(sum(obs),0),2) vol_ecmwf,
  round(sum(gem)/nullif(sum(obs),0),2) vol_gem, round(sum(gfs)/nullif(sum(obs),0),2) vol_gfs,
  sum(CAST(obs<1 AND blend>=2.5 AS INT)) fa25, sum(CAST(obs<1 AND blend>=5 AS INT)) fa5, sum(CAST(obs<1 AS INT)) dry,
  round(sum(CAST(blend>=2.5 AS INT))/nullif(sum(CAST(obs>=2.5 AS INT)),0),2) fbias25,
  round(sum(CAST(blend>=10 AS INT))/nullif(sum(CAST(obs>=10 AS INT)),0),2) fbias10,
  round(sum(CAST(blend>=10 AND obs>=10 AS INT))/nullif(sum(CAST(blend>=10 OR obs>=10 AS INT)),0),2) csi10
  FROM b WHERE region IN {REG} GROUP BY ALL ORDER BY region, lg, split"""
cols = "region|leads|split|n|wet|vol_blend|vol_ecmwf|vol_gem|vol_gfs|FA>=2.5|FA>=5|dry|fbias2.5|fbias10|csi10"
print("\n== Blend (live factors) vs SNOTEL water ==\n" + cols)
for r in con.execute(q).fetchall():
    print("|".join(str(x) for x in r))
print("\n== Raw factor (sum obs / sum fc) per winter, leads 1-3 ==\nregion|model|train(24-25)|test(25-26)|live(26-27)|wet train/test/live")
for r in con.execute(f"""SELECT region, model,
   round(sum(obs) FILTER (WHERE split='train') / nullif(sum(fc) FILTER (WHERE split='train'),0),2),
   round(sum(obs) FILTER (WHERE split='test') / nullif(sum(fc) FILTER (WHERE split='test'),0),2),
   round(sum(obs) FILTER (WHERE split='live') / nullif(sum(fc) FILTER (WHERE split='live'),0),2),
   concat(sum(CAST(obs>=1 AND split='train' AS INT)),'/',sum(CAST(obs>=1 AND split='test' AS INT)),'/',sum(CAST(obs>=1 AND split='live' AS INT)))
   FROM d WHERE lead <= 3 AND region IN {REG} GROUP BY ALL ORDER BY region, model""").fetchall():
    print("|".join(str(x) for x in r))
print("\n== California per resort, test winter, leads 1-3 ==\nresort|n|wet|vol_blend|FA>=2.5|dry")
for r in con.execute("""SELECT resort_id, count(*), sum(CAST(obs>=1 AS INT)), round(sum(blend)/nullif(sum(obs),0),2),
   sum(CAST(obs<1 AND blend>=2.5 AS INT)), sum(CAST(obs<1 AS INT)) FROM b
   WHERE region='California' AND split='test' AND lead<=3 GROUP BY 1 ORDER BY 1""").fetchall():
    print("|".join(str(x) for x in r))
