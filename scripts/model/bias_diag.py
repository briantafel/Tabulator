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

# ---- Candidate: same rule as blend.py, refit on a different winter, judged on the live season only ----
SHRINK, CLAMP, WET = 40, (0.5, 2.0), 1.0


def fit(where):
    con.execute(f"""CREATE OR REPLACE TABLE r AS SELECT model, lead, region, sum(obs) so, sum(fc) sf,
      sum(CAST(obs >= {WET} AS INT)) wet FROM d WHERE {where} GROUP BY ALL""")
    con.execute("CREATE OR REPLACE TABLE a AS SELECT model, lead, sum(so)/nullif(sum(sf),0) pooled FROM r GROUP BY ALL")
    con.execute(f"""CREATE OR REPLACE TABLE cf AS SELECT r.model, r.lead, r.region,
      least(greatest((r.wet/(r.wet+{SHRINK}.0)) * coalesce(r.so/nullif(r.sf,0), least(greatest(a.pooled,{CLAMP[0]}),{CLAMP[1]}))
        + (1 - r.wet/(r.wet+{SHRINK}.0)) * least(greatest(a.pooled,{CLAMP[0]}),{CLAMP[1]}), {CLAMP[0]}), {CLAMP[1]}) f
      FROM r JOIN a USING (model, lead)""")
    con.execute(f"""CREATE OR REPLACE TABLE cw0 AS SELECT d.model, d.lead, 1.0/avg(power(d.fc*cf.f - d.obs, 2)) iw
      FROM d JOIN cf USING (model, lead, region) WHERE {where} AND (d.obs >= {WET} OR d.fc*cf.f >= {WET}) GROUP BY ALL""")
    con.execute("CREATE OR REPLACE TABLE cw AS SELECT model, lead, iw/sum(iw) OVER (PARTITION BY lead) w FROM cw0")


def score(tag):
    return con.execute(f"""WITH x AS (SELECT d.resort_id, d.region, d.local_date, d.lead, any_value(d.obs) obs,
        sum(cw.w*d.fc*cf.f)/sum(cw.w) bl FROM d JOIN cw USING (model, lead) JOIN cf USING (model, lead, region)
        WHERE d.split='live' GROUP BY ALL)
      SELECT '{tag}', coalesce(region,'ALL'), CASE WHEN lead<=3 THEN '1-3' ELSE '4-7' END lg, count(*),
        round(sum(bl)/nullif(sum(obs),0),2),
        round(sum(CAST(bl>=2.5 AND obs>=2.5 AS INT))/nullif(sum(CAST(bl>=2.5 OR obs>=2.5 AS INT)),0),3),
        round(sum(CAST(bl>=10 AND obs>=10 AS INT))/nullif(sum(CAST(bl>=10 OR obs>=10 AS INT)),0),3),
        sum(CAST(obs<1 AND bl>=2.5 AS INT)), round(avg(abs(bl-obs)),2)
      FROM x WHERE region <> 'Washington' GROUP BY GROUPING SETS ((region, lg), (lg)) ORDER BY 2, 3""").fetchall()


# live-file factors, rebuilt into the same tables so all three are scored by one query
con.execute("CREATE OR REPLACE TABLE cf AS SELECT model, lead, region, f FROM fac")
con.execute("CREATE OR REPLACE TABLE cw AS SELECT model, lead, w FROM w")
res = score("v1 live (fit 24-25)")
fit("split = 'test'"); res += score("refit 25-26")
fit("split IN ('train','test')"); res += score("refit both")
print("\n== Live season 2026-27 only (neither fit saw it), Washington excluded (truth problem) ==")
print("factors|region|leads|n|volume|CSI>=2.5|CSI>=10|FA>=2.5 on dry|mean abs err mm")
for r in sorted(res, key=lambda r: (r[1], r[2], r[0])):
    print("|".join(str(x) for x in r))
print("Live season is ~3 weeks: treat differences as direction, not proof.")
