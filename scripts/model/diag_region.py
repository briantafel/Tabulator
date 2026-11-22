#!/usr/bin/env python3
"""Diagnosis (2026-11-22): is the blend too wet at Whistler, and why? Reads verify's pairs.parquet; no app change.

    python3 scripts/model/diag_region.py <pairs.parquet> <public/blend.json> <resorts.json> [region]

Per resort in the region (default Canada), strict pairs, mid tier, water, leads 1–5, both past winters:
  - each model's RAW volume ratio (Σfc ÷ Σobs), the factor blend-v1 applies (region × model × lead), and the
    CORRECTED ratio: if corrected is well above 1 at a resort, the shared region factor is wrong for it
  - SLR check: observed snow-to-water ratio at the resort's station by forecast-temperature bin vs slr-v3
  - live: NBM vs each model's water over the same days (no truth needed: just how far apart they are)
"""
import json
import sys

import duckdb

pairs, blend_p, res_p = sys.argv[1:4]
region = sys.argv[4] if len(sys.argv) > 4 else "Canada"
b = json.load(open(blend_p))
ids = [r["id"] for r in json.load(open(res_p))["resorts"] if r.get("region") == region and not r.get("archiveOnly")]
con = duckdb.connect()
con.execute(f"""CREATE TABLE p AS SELECT * FROM read_parquet('{pairs}') WHERE resort_id IN {tuple(ids)} AND tier = 'mid'""")
con.execute("CREATE TABLE fac(model VARCHAR, lead INT, f DOUBLE)")
con.executemany("INSERT INTO fac VALUES (?,?,?)", [(k.split("|")[0], int(k.split("|")[1]), v) for k, v in b["factors"].items()
                                                  if k.endswith("|" + region)])
print(f"# Region {region}: {len(ids)} app resorts. blend-v1 applies ONE factor per model × lead to all of them.\n")
print("## Volume ratio by resort (Σforecast ÷ Σobserved water), leads 1–5, strict station pairs, winters with truth\n")
rows = con.execute("""
  WITH d AS (SELECT resort_id, any_value(station_id) st, any_value(round(station_km,1)) km, any_value(round(station_delev_m)) dz,
                    split_part(source_label, ':', 2) AS model, lead_day AS lead, fc_amount fc, obs
             FROM p WHERE source = 'open-meteo-previous-runs' AND space = 'liquid' AND pair_quality = 'strict'
               AND obs IS NOT NULL AND fc_amount IS NOT NULL AND lead_day BETWEEN 1 AND 5 AND split IN ('train','test')
             GROUP BY resort_id, source_label, lead_day, local_date, fc_amount, obs)
  SELECT resort_id, any_value(st), any_value(km), any_value(dz), count(DISTINCT local_date) AS days, round(avg(obs), 1) AS obs_mm_day,
         round(sum(fc) FILTER (WHERE model='ecmwf_ifs025') / sum(obs) FILTER (WHERE model='ecmwf_ifs025'), 2) ecmwf,
         round(sum(fc) FILTER (WHERE model='gfs_seamless') / sum(obs) FILTER (WHERE model='gfs_seamless'), 2) gfs,
         round(sum(fc) FILTER (WHERE model='gem_seamless') / sum(obs) FILTER (WHERE model='gem_seamless'), 2) gem,
         round(sum(fc * f) / sum(obs), 2) AS corrected_all_models
  FROM d LEFT JOIN fac USING (model, lead) GROUP BY resort_id ORDER BY corrected_all_models DESC""").fetchall()
print("| resort | station | km | Δelev m | days | obs mm/day | ECMWF raw | GFS raw | GEM raw | corrected (what the blend uses) |")
print("|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join("" if v is None else str(v) for v in r) + " |")
if not rows:
    print("_no strict station pairs in this region_")
print("\nFactors blend-v1 applies in this region (model|lead): " + ", ".join(f"{k.rsplit('|',1)[0]} {v}" for k, v in sorted(b['factors'].items()) if k.endswith('|' + region) and int(k.split('|')[1]) <= 5))
print("\n## Observed snow-to-water at the station by forecast temperature (slr-v3 says 11.5 − 0.36·T)\n")
s = con.execute("""
  SELECT resort_id, CAST(floor(fc_temp_c / 2) * 2 AS INT) AS t_bin, count(*) n, round(median(obs_slr), 1) med_slr
  FROM (SELECT DISTINCT resort_id, local_date, obs_slr, fc_temp_c FROM p
        WHERE source = 'open-meteo-previous-runs' AND source_label LIKE '%ecmwf%' AND lead_day = 1 AND obs_slr IS NOT NULL
          AND fc_temp_c IS NOT NULL AND pair_quality = 'strict')
  WHERE fc_temp_c BETWEEN -14 AND 4 GROUP BY ALL HAVING count(*) >= 5 ORDER BY resort_id, t_bin""").fetchall()
print("| resort | forecast °C bin | days | observed median SLR | slr-v3 |\n|---|---|---|---|---|")
for rid, t, n, m in s:
    print(f"| {rid} | {t} to {t+2} | {n} | {m} | {round(b.get('_', 11.517) - 0.357 * (t + 1), 1) if False else round(11.517 - 0.357 * (t + 1), 1)} |")
if not s:
    print("_no stations with both depth and SWE gains here_")
print("\n## Live, this season: NBM vs the models' water at each resort (sum over shared days, leads 1–5, no truth)\n")
lv = con.execute("""
  WITH x AS (SELECT resort_id, local_date, lead_day, source_label, avg(fc_amount) fc FROM p
             WHERE split = 'live' AND space = 'liquid' AND lead_day BETWEEN 1 AND 5
               AND (source = 'nbm' OR source = 'open-meteo-previous-runs') GROUP BY ALL),
       k AS (SELECT resort_id, local_date, lead_day FROM x GROUP BY ALL HAVING count(DISTINCT source_label) = 4)
  SELECT resort_id, count(*) / 4 n, round(sum(fc) FILTER (WHERE source_label = 'nbm:nbm'), 1) nbm,
         round(sum(fc) FILTER (WHERE source_label LIKE '%ecmwf%'), 1) ecmwf, round(sum(fc) FILTER (WHERE source_label LIKE '%gfs%'), 1) gfs,
         round(sum(fc) FILTER (WHERE source_label LIKE '%gem%'), 1) gem
  FROM x JOIN k USING (resort_id, local_date, lead_day) GROUP BY resort_id ORDER BY resort_id""").fetchall()
print("| resort | resort-day-leads | NBM mm | ECMWF mm | GFS mm | GEM mm |\n|---|---|---|---|---|---|")
for r in lv:
    print("| " + " | ".join(str(v) for v in r) + " |")
if not lv:
    print("_no shared live days (NBM may not reach these resorts, or its label differs)_")
